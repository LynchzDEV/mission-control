import { basename } from 'node:path'

import { spawn, type IPty } from 'bun-pty'

import { ENGINE_NAMES, buildEnv, fakeEnginesEnabled, resolveEngine, type EngineName } from './engines'
import { validateWorkspaceCwd } from './workspace'

export const RING_BUFFER_BYTES = 64 * 1024
export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24
export const MIN_DIMENSION = 1
export const MAX_DIMENSION = 1000

// MC_FAKE_ENGINES swaps in an interactive shell; the shared FAKE_ENGINES map is /bin/echo, which exits instantly.
const FAKE_TERMINAL_CMD = '/bin/sh'

export type TerminalRecord = {
  id: string
  engine: EngineName
  cwd: string
  pid: number
  createdAt: number
  title: string
}

export type CreateTerminalParams = {
  engine: string
  cwd: string
  cols?: unknown
  rows?: unknown
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
  replay(id: string): string
  subscribe(id: string, listener: OutputListener, onClose?: CloseListener): () => void
  shutdown(): void
}

type Subscriber = { data: OutputListener; close?: CloseListener }

type Session = {
  record: TerminalRecord
  pty: IPty
  buffer: RingBuffer
  listeners: Set<Subscriber>
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
  return fakeEnginesEnabled() ? FAKE_TERMINAL_CMD : resolveEngine(engine).cmd
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
    if (typeof params.engine !== 'string' || !isEngineName(params.engine)) {
      return { ok: false, status: 400, error: 'unknown engine' }
    }
    const engine = params.engine
    const cwdCheck = await validateWorkspaceCwd(params.cwd, home, { requireGit: false })
    if (!cwdCheck.ok) return { ok: false, status: 400, error: cwdCheck.error }

    let env: Record<string, string>
    try {
      env = await buildEnv(engine)
    } catch {
      return { ok: false, status: 400, error: 'engine environment is not configured' }
    }

    const cols = clampDimension(params.cols, DEFAULT_COLS)
    const rows = clampDimension(params.rows, DEFAULT_ROWS)

    let pty: IPty
    try {
      pty = spawn(terminalCommand(engine), [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwdCheck.path,
        env: { ...env, TERM: 'xterm-256color' },
      })
    } catch {
      return { ok: false, status: 500, error: 'failed to spawn terminal process' }
    }

    const id = crypto.randomUUID()
    const record: TerminalRecord = {
      id,
      engine,
      cwd: cwdCheck.path,
      pid: pty.pid,
      createdAt: Date.now(),
      title: `${engine.toUpperCase()} · ${basename(cwdCheck.path)}`,
    }
    const session: Session = { record, pty, buffer: createRingBuffer(), listeners: new Set() }
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
