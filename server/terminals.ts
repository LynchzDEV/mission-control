import { basename } from 'node:path'

import { spawn, type IPty } from 'bun-pty'

import { claudeTranscriptPath, findCodexRollout } from './session-transcript'

import {
  ENGINE_NAMES,
  pathWithFallbackDirs,
  PARENT_CLAUDE_SESSION_VARS,
  buildEnv,
  fakeEnginesEnabled,
  modelArgs,
  resolveBinary,
  resolveEngine,
  type EngineName,
} from './engines'
import { validateWorkspaceCwd } from './workspace'
import { connectionEnvironment, createConnectionStore, type AgentConnection } from './agent-connections'
import { configDir, parseBind, readConfig } from './secrets'
import { createWorkflowStore } from './workflows'

export const RING_BUFFER_BYTES = 64 * 1024
export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
export const MIN_DIMENSION = 1
export const MAX_DIMENSION = 1000
export const MAX_TITLE_LENGTH = 60

// MC_FAKE_ENGINES swaps in an interactive shell; the shared FAKE_ENGINES map is /bin/echo, which exits instantly.
const FAKE_TERMINAL_CMD = '/bin/sh'

export type TerminalRecord = {
  id: string
  engine: string
  cwd: string
  pid: number
  createdAt: number
  title: string
  sessionId: string | null
  workflow?: { id: string; revision: string; name: string; selectedDefault: boolean }
}

export type CreateTerminalParams = {
  engine: string
  cwd: string
  cols?: unknown
  rows?: unknown
  model?: string
  resumeSessionId?: string
  title?: string
  workflowId?: string
  revision?: string
}

export type CreateTerminalResult =
  | { ok: true; terminal: TerminalRecord }
  | { ok: false; status: number; error: string }

export type OutputListener = (chunk: string) => void
export type CloseListener = () => void

export type TerminalRegistry = {
  createTerminal(params: CreateTerminalParams): Promise<CreateTerminalResult>
  list(): TerminalRecord[]
  get(id: string): TerminalRecord | undefined
  write(id: string, data: string): boolean
  resize(id: string, cols: unknown, rows: unknown): boolean
  kill(id: string): boolean
  rename(id: string, title: string): boolean
  replay(id: string): string
  transcriptPath(id: string): Promise<string | null>
  subscribe(id: string, listener: OutputListener, onClose?: CloseListener): () => void
  shutdown(): void
}

type Subscriber = { data: OutputListener; close?: CloseListener }

type Session = {
  record: TerminalRecord
  pty: IPty
  buffer: RingBuffer
  listeners: Set<Subscriber>
  transcript: string | null
}

function isEngineName(value: string): value is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(value)
}

export function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < MIN_DIMENSION) return MIN_DIMENSION
  if (rounded > MAX_DIMENSION) return MAX_DIMENSION
  return rounded
}

export function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_TITLE_LENGTH) return null
  return trimmed
}

export function terminalArgs(
  engine: EngineName,
  model: string | undefined,
  resumeSessionId: string | undefined,
  sessionId?: string,
  instructions?: string,
): string[] {
  return [
    ...(engine === 'codex' ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
    ...(resumeSessionId === undefined ? (engine === 'codex' || sessionId === undefined ? [] : ['--session-id', sessionId]) : ['--resume', resumeSessionId]),
    ...modelArgs(engine, model),
    ...(instructions ? engine === 'codex' ? ['-c', `developer_instructions=${JSON.stringify(instructions)}`] : ['--append-system-prompt', instructions] : []),
  ]
}

export type RingBuffer = { chunks: Buffer[]; bytes: number }

export function createRingBuffer(): RingBuffer {
  return { chunks: [], bytes: 0 }
}

export function pushToRingBuffer(buffer: RingBuffer, chunk: string, limitBytes: number): void {
  const encoded = Buffer.from(chunk, 'utf-8')
  buffer.chunks.push(encoded)
  buffer.bytes += encoded.length
  while (buffer.chunks.length > 1 && buffer.bytes > limitBytes) {
    buffer.bytes -= (buffer.chunks.shift() as Buffer).length
  }
  if (buffer.bytes > limitBytes) {
    const kept = (buffer.chunks[0] as Buffer).subarray(buffer.bytes - limitBytes)
    buffer.chunks[0] = Buffer.from(kept)
    buffer.bytes = kept.length
  }
}

export function replayRingBuffer(buffer: RingBuffer): string {
  return Buffer.concat(buffer.chunks).toString('utf-8')
}

function terminalCommand(engine: EngineName): string {
  return fakeEnginesEnabled() ? FAKE_TERMINAL_CMD : resolveBinary(resolveEngine(engine).cmd)
}

export type TerminalRegistryOptions = {
  home?: string
}

export function createTerminalRegistry(options: TerminalRegistryOptions = {}): TerminalRegistry {
  const sessions = new Map<string, Session>()
  const home = options.home

  function forget(id: string): void {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    const subscribers = [...session.listeners]
    session.listeners.clear()
    for (const subscriber of subscribers) subscriber.close?.()
  }

  async function createTerminal(params: CreateTerminalParams): Promise<CreateTerminalResult> {
    if (typeof params.engine !== 'string') {
      return { ok: false, status: 400, error: 'unknown engine' }
    }
    const engine = params.engine
    let connection: AgentConnection | undefined
    if (!isEngineName(engine)) {
      try { connection = await createConnectionStore().get(engine) }
      catch { return { ok: false, status: 400, error: 'unknown engine' } }
      if (!connection.terminalArgs) return { ok: false, status: 400, error: 'Configure interactive terminal arguments for this connection in Studio' }
      if (params.resumeSessionId) return { ok: false, status: 400, error: 'Interactive resume is not configured for this connection' }
      if (params.model && !connection.terminalArgs.some(arg => arg.includes('{{model}}'))) return { ok: false, status: 400, error: 'Interactive arguments need a {{model}} slot to select a model' }
    }
    if (params.resumeSessionId !== undefined && engine === 'codex') {
      return { ok: false, status: 400, error: 'resume is only supported for claude and glm' }
    }
    const cwdCheck = await validateWorkspaceCwd(params.cwd, home, { requireGit: false })
    if (!cwdCheck.ok) return { ok: false, status: 400, error: cwdCheck.error }

    let workflow: NonNullable<TerminalRecord['workflow']>
    try {
      if (params.revision && !params.workflowId) throw new Error('Choose a workflow for this version')
      const store = createWorkflowStore()
      const selected = params.workflowId ? await store.get(params.workflowId, params.revision) : await store.selected()
      workflow = { id: selected.id, revision: selected.revision, name: selected.name, selectedDefault: !params.workflowId }
    } catch (error) { return { ok: false, status: 400, error: (error as Error).message } }

    let env: Record<string, string>
    try {
      env = connection ? { ...process.env, ...connectionEnvironment(connection), PATH: pathWithFallbackDirs(process.env.PATH) } as Record<string, string> : await buildEnv(engine as EngineName)
      if (connection) for (const key of PARENT_CLAUDE_SESSION_VARS) delete env[key]
    } catch {
      return { ok: false, status: 400, error: 'engine environment is not configured' }
    }

    const cols = clampDimension(params.cols, DEFAULT_COLS)
    const rows = clampDimension(params.rows, DEFAULT_ROWS)

    const id = crypto.randomUUID()
    const target = parseBind((await readConfig()).bind)
    const mcUrl = `http://${target.hostname === '0.0.0.0' ? '127.0.0.1' : target.hostname}:${target.port}`
    const instructions = `This is a Mission Control terminal. Its pinned workflow is ${JSON.stringify(workflow)}. For a user-requested workflow task, start POST ${mcUrl}/api/studio/runs with terminalId ${JSON.stringify(id)}, cwd ${JSON.stringify(cwdCheck.path)}, label, and the complete user request. Mission Control owns the workflow steps; do not also execute those steps yourself. Read the Bearer apiToken from secrets.json in MISSION_CONTROL_CONFIG_DIR without printing it. Use MC_URL for all cockpit calls, never a hardcoded port. Follow the mc-dispatch skill when available, preserving this terminal's workflow and service address. Answer ordinary questions directly. Opening this terminal does not authorize starting any work; wait for the user. MC_WORKFLOW_ID and MC_WORKFLOW_REVISION identify the pinned version.`
    const sessionId = connection || engine === 'codex' ? null : (params.resumeSessionId ?? crypto.randomUUID())
    let pty: IPty
    try {
      const command = connection ? resolveBinary(connection.command) : terminalCommand(engine as EngineName)
      const args = connection ? connection.terminalArgs!.map(arg => arg.replaceAll('{{model}}', params.model ?? '').replaceAll('{{instructions}}', instructions)) : fakeEnginesEnabled() ? [] : terminalArgs(engine as EngineName, params.model, params.resumeSessionId, sessionId ?? undefined, instructions)
      pty = spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwdCheck.path,
        env: { ...env, TERM: 'xterm-256color', MC_TERMINAL_ID: id, MC_URL: mcUrl, MISSION_CONTROL_CONFIG_DIR: configDir(), MC_WORKFLOW_ID: workflow.id, MC_WORKFLOW_REVISION: workflow.revision },
      })
    } catch {
      return { ok: false, status: 500, error: 'failed to spawn terminal process' }
    }
    const record: TerminalRecord = {
      id,
      engine,
      cwd: cwdCheck.path,
      pid: pty.pid,
      createdAt: Date.now(),
      title: normalizeTitle(params.title) ?? `${engine.toUpperCase()} · ${basename(cwdCheck.path)}`,
      sessionId,
      workflow,
    }
    const session: Session = { record, pty, buffer: createRingBuffer(), listeners: new Set(), transcript: sessionId === null ? null : claudeTranscriptPath(env.CLAUDE_CONFIG_DIR, cwdCheck.path, sessionId) }
    sessions.set(id, session)

    pty.onData((chunk) => {
      pushToRingBuffer(session.buffer, chunk, RING_BUFFER_BYTES)
      for (const subscriber of session.listeners) subscriber.data(chunk)
    })
    pty.onExit(() => forget(id))

    return { ok: true, terminal: record }
  }

  function kill(id: string): boolean {
    const session = sessions.get(id)
    if (session === undefined) return false
    try {
      session.pty.kill()
    } catch {
      // pty already gone; forget() still drops it from the registry
    }
    forget(id)
    return true
  }

  return {
    createTerminal,
    kill,
    rename(id, title) {
      const session = sessions.get(id)
      const clean = normalizeTitle(title)
      if (session === undefined || clean === null) return false
      session.record = { ...session.record, title: clean }
      return true
    },
    list() {
      return [...sessions.values()]
        .map((session) => session.record)
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    get(id) {
      return sessions.get(id)?.record
    },
    write(id, data) {
      const session = sessions.get(id)
      if (session === undefined) return false
      session.pty.write(data)
      return true
    },
    resize(id, cols, rows) {
      const session = sessions.get(id)
      if (session === undefined) return false
      session.pty.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS))
      return true
    },
    async transcriptPath(id) {
      const session = sessions.get(id)
      if (session === undefined) return null
      if (session.transcript === null && session.record.engine === 'codex') session.transcript = await findCodexRollout(session.record.cwd, session.record.createdAt)
      return session.transcript
    },
    replay(id) {
      const session = sessions.get(id)
      return session === undefined ? '' : replayRingBuffer(session.buffer)
    },
    subscribe(id, listener, onClose) {
      const session = sessions.get(id)
      if (session === undefined) return () => {}
      const subscriber: Subscriber = { data: listener, close: onClose }
      session.listeners.add(subscriber)
      return () => session.listeners.delete(subscriber)
    },
    shutdown() {
      for (const id of [...sessions.keys()]) kill(id)
    },
  }
}
