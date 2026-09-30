import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionUpdate,
  Query,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'

export type ChatPermissionMode = 'settings' | 'ask' | 'acceptEdits' | 'plan' | 'bypass'

export type BridgeImageMedia = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type BridgeImage = { path: string; mediaType: BridgeImageMedia }

export type BridgeLaunch = {
  prompt: string
  images: BridgeImage[]
  resumeSessionId: string | null
  forkSession: boolean
  resumeSessionAt: string | null
  model: string | null
  permissionMode: ChatPermissionMode
  appendSystemPrompt: string
  disallowedTools: string[]
  allowedTools: string[]
  claudePath: string
}

export type BridgeControl = { type: 'permission'; requestId: string; decision: 'allow_once' | 'allow_always' | 'deny' }

export type BridgeQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'supportedCommands' | 'getContextUsage'>

export type BridgeDeps = {
  query: BridgeQuery
  write: (line: object) => void
  controls: AsyncIterable<BridgeControl>
  readFile: (path: string) => Promise<Uint8Array>
  signal: AbortSignal
  waitMs?: (ms: number) => Promise<void>
}

export const BRIDGE_ABORT_EXIT = 143
const PERMISSION_WAIT_MS = 10 * 60_000
const ABORT_GRACE_MS = 800
const INFO_TIMEOUT_MS = 3_000
const STDERR_TAIL_BYTES = 4_096
const DENY_MESSAGES = {
  declined: 'The user declined this in Mission Control.',
  cancelled: 'Cancelled.',
  restart: 'Mission Control restarted; approvals are unavailable for this reply',
  timeout: 'No answer within 10 minutes.',
} as const

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function settingsPermissionMode(configDir: string): PermissionMode {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
  } catch {
    return 'default'
  }
  const mode = isRecord(parsed) && isRecord(parsed.permissions) ? parsed.permissions.defaultMode : undefined
  return PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : 'default'
}

export function chatModeOptions(mode: ChatPermissionMode): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions'> {
  if (mode === 'ask') return { permissionMode: 'default' }
  if (mode === 'acceptEdits') return { permissionMode: 'acceptEdits' }
  if (mode === 'plan') return { permissionMode: 'plan' }
  if (mode === 'bypass') return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
  const fromSettings = settingsPermissionMode(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
  return fromSettings === 'bypassPermissions'
    ? { permissionMode: fromSettings, allowDangerouslySkipPermissions: true }
    : { permissionMode: fromSettings }
}

export function makeSpawner(write: (line: object) => void, onStderr: (text: string) => void): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr?.on('data', (chunk: Buffer) => onStderr(chunk.toString()))
    write({ type: 'mc_child', mc: true, pid: child.pid, startedAt: Date.now() })
    return child as unknown as SpawnedProcess
  }
}

const RULE_GLOB_CHARACTERS = /[*?[]/

const FILE_WRITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function ruleString(toolName: string, ruleContent: string | undefined): string {
  return ruleContent === undefined ? toolName : `${toolName}(${ruleContent})`
}

export function alwaysAllowRules(toolName: string, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined): string[] {
  const addRules = (suggestions ?? []).filter((update): update is Extract<PermissionUpdate, { type: 'addRules' }> => update.type === 'addRules').flatMap((update) => update.rules)
  if (addRules.length > 0) return addRules.map((rule) => ruleString(rule.toolName, rule.ruleContent))
  if (toolName === 'Bash' && typeof input.command === 'string') return RULE_GLOB_CHARACTERS.test(input.command) ? [] : [`Bash(${input.command})`]
  if (FILE_WRITING_TOOLS.has(toolName)) {
    for (const key of ['file_path', 'notebook_path'] as const) {
      const path = input[key]
      if (typeof path === 'string' && isAbsolute(path)) return [`Edit(/${path})`]
    }
    return []
  }
  if (toolName === 'Read' && typeof input.file_path === 'string' && isAbsolute(input.file_path)) return [`Read(/${input.file_path})`]
  return []
}

type ControlOutcome = BridgeControl | 'eof' | 'aborted' | 'timeout'

type ControlHub = { wait(requestId: string): Promise<ControlOutcome> }

function createControlHub(controls: AsyncIterable<BridgeControl>, signal: AbortSignal): ControlHub {
  const waiters = new Map<string, (outcome: ControlOutcome) => void>()
  const buffered: BridgeControl[] = []
  let ended: 'eof' | 'aborted' | null = null
  const settleAll = (outcome: 'eof' | 'aborted'): void => {
    if (ended !== null) return
    ended = outcome
    for (const resolve of waiters.values()) resolve(outcome)
    waiters.clear()
  }
  void (async () => {
    try {
      for await (const control of controls) {
        if (ended !== null) break
        const resolve = waiters.get(control.requestId)
        if (resolve === undefined) buffered.push(control)
        else {
          waiters.delete(control.requestId)
          resolve(control)
        }
      }
      settleAll('eof')
    } catch {
      settleAll('eof')
    }
  })()
  if (signal.aborted) settleAll('aborted')
  else signal.addEventListener('abort', () => settleAll('aborted'), { once: true })
  return {
    wait(requestId) {
      const index = buffered.findIndex((control) => control.requestId === requestId)
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0] as BridgeControl)
      if (ended !== null) return Promise.resolve(ended)
      return new Promise((resolve) => waiters.set(requestId, resolve))
    },
  }
}

export function createPermissionHandler(write: (line: object) => void, hub: ControlHub, waitMs: (ms: number) => Promise<void>): CanUseTool {
  const resolved = (requestId: string, decision: string, reason?: string, rules?: string[]): void => {
    write({ type: 'mc_permission_resolved', mc: true, requestId, decision, ...(rules === undefined ? {} : { rules }), ...(reason === undefined ? {} : { reason }) })
  }
  return (toolName, input, options) => {
    write({
      type: 'mc_permission_request',
      mc: true,
      requestId: options.requestId,
      toolUseID: options.toolUseID,
      toolName,
      title: options.title ?? `Claude wants to use ${toolName}`,
      description: options.description ?? '',
      decisionReason: options.decisionReason ?? '',
      suppressAlways: options.suppressAlwaysAllowRule === true,
      input,
    })
    return Promise.race([hub.wait(options.requestId), waitMs(PERMISSION_WAIT_MS).then((): ControlOutcome => 'timeout')]).then((outcome) => {
      if (outcome === 'eof') {
        resolved(options.requestId, 'cancelled', 'restart')
        return { behavior: 'deny', message: DENY_MESSAGES.restart }
      }
      if (outcome === 'timeout') {
        resolved(options.requestId, 'cancelled', 'timeout')
        return { behavior: 'deny', message: DENY_MESSAGES.timeout }
      }
      if (outcome === 'aborted') {
        resolved(options.requestId, 'cancelled')
        return { behavior: 'deny', message: DENY_MESSAGES.cancelled, interrupt: true }
      }
      if (outcome.decision === 'deny') {
        resolved(options.requestId, 'deny')
        return { behavior: 'deny', message: DENY_MESSAGES.declined }
      }
      if (outcome.decision === 'allow_once' || options.suppressAlwaysAllowRule === true) {
        resolved(options.requestId, 'allow_once')
        return { behavior: 'allow', updatedInput: input }
      }
      const rules = alwaysAllowRules(toolName, input, options.suggestions)
      resolved(options.requestId, 'allow_always', rules.length === 0 ? 'no-rule' : undefined, rules)
      const updates = (options.suggestions ?? []).map((update) => ({ ...update, destination: 'session' as const }))
      return updates.length > 0
        ? { behavior: 'allow', updatedInput: input, updatedPermissions: updates }
        : { behavior: 'allow', updatedInput: input }
    })
  }
}

async function raceInfo<T>(value: Promise<T>, waitMs: (ms: number) => Promise<void>, onValue: (value: T) => void): Promise<void> {
  try {
    const outcome = await Promise.race([value.then((resolved) => ({ resolved })).catch(() => null), waitMs(INFO_TIMEOUT_MS).then(() => null)])
    if (outcome !== null) onValue(outcome.resolved)
  } catch {
    // a failed info probe skips its line
  }
}

function launchOptions(launch: BridgeLaunch, abortController: AbortController, canUseTool: CanUseTool, spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess): Options {
  return {
    ...(launch.resumeSessionId === null ? {} : { resume: launch.resumeSessionId }),
    forkSession: launch.forkSession,
    ...(launch.resumeSessionAt === null ? {} : { resumeSessionAt: launch.resumeSessionAt }),
    ...(launch.model === null ? {} : { model: launch.model }),
    ...chatModeOptions(launch.permissionMode),
    systemPrompt: { type: 'preset', preset: 'claude_code' as const, append: launch.appendSystemPrompt },
    disallowedTools: [...launch.disallowedTools, 'AskUserQuestion'],
    includePartialMessages: true,
    env: { ...process.env },
    pathToClaudeCodeExecutable: launch.claudePath,
    abortController,
    canUseTool,
    allowedTools: launch.allowedTools,
    spawnClaudeCodeProcess,
  }
}

async function imageBlocks(launch: BridgeLaunch, readFile: (path: string) => Promise<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const image of launch.images) {
    const data = Buffer.from(await readFile(image.path)).toString('base64')
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data } })
  }
  return blocks
}

export async function runBridge(launch: BridgeLaunch, deps: BridgeDeps): Promise<number> {
  const waitMs = deps.waitMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const write = deps.write
  const abortController = new AbortController()
  if (deps.signal.aborted) abortController.abort()
  else deps.signal.addEventListener('abort', () => abortController.abort(), { once: true })
  let stderrTail = ''
  const onStderr = (text: string): void => {
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES)
    write({ type: 'mc_stderr', mc: true, text })
  }
  let child = null as SpawnedProcess | null
  const spawner = makeSpawner(write, onStderr)
  const hub = createControlHub(deps.controls, deps.signal)
  const canUseTool = createPermissionHandler(write, hub, waitMs)
  let exitCode = 1

  const consume = async (): Promise<void> => {
    let released!: () => void
    const release = new Promise<void>((resolve) => { released = resolve })
    async function* promptStream(): AsyncIterable<SDKUserMessage> {
      const content: Array<Record<string, unknown>> = [...await imageBlocks(launch, deps.readFile), { type: 'text', text: launch.prompt }]
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as unknown as SDKUserMessage
      await release
    }
    const options = launchOptions(launch, abortController, canUseTool, (spawnOptions) => {
      child = spawner(spawnOptions)
      return child
    })
    const q = deps.query({ prompt: promptStream(), options })
    const pendingInfo: Array<Promise<void>> = []
    let initSeen = false
    for await (const message of q) {
      write(message as object)
      if (isRecord(message)) {
        if (!initSeen && message.type === 'system' && message.subtype === 'init') {
          initSeen = true
          pendingInfo.push(raceInfo(q.supportedCommands(), waitMs, (commands) => write({
            type: 'mc_commands',
            mc: true,
            commands: commands.map((command) => ({ name: command.name, description: command.description, argumentHint: command.argumentHint })),
          })))
        }
        if (message.type === 'result') {
          await raceInfo(q.getContextUsage({ detail: 'summary' }), waitMs, (usage) => write({
            type: 'mc_context',
            mc: true,
            percentage: usage.percentage,
            totalTokens: usage.totalTokens,
            maxTokens: usage.maxTokens,
          }))
          released()
          exitCode = message.is_error === true ? 1 : 0
        }
      }
    }
    await Promise.allSettled(pendingInfo)
  }

  const run = consume().catch((error) => {
    exitCode = 1
    const message = error instanceof Error ? error.message : String(error)
    const tail = stderrTail.trimEnd()
    write({ type: 'result', subtype: 'error_during_execution', is_error: true, result: tail === '' ? message : `${message}\n${tail}` })
  })
  const stopped = new Promise<true>((resolve) => {
    if (deps.signal.aborted) resolve(true)
    else deps.signal.addEventListener('abort', () => resolve(true), { once: true })
  })
  if ((await Promise.race([run.then(() => false), stopped])) === false) return exitCode
  abortController.abort()
  child?.kill('SIGTERM')
  await Promise.race([run, waitMs(ABORT_GRACE_MS)])
  if (child !== null && child.exitCode === null) child.kill('SIGKILL')
  return BRIDGE_ABORT_EXIT
}

export function fakeQuery(dir: string): BridgeQuery {
  const fakeCommands = [
    { name: 'review', description: 'Review the current changes', argumentHint: '' },
    { name: 'compact', description: 'Summarise the conversation to free context', argumentHint: '' },
    { name: 'init', description: 'Write a CLAUDE.md for this project', argumentHint: '' },
  ]
  const fakeUsage = { percentage: 62, totalTokens: 124_000, maxTokens: 200_000 } as unknown as SDKControlGetContextUsageResponse
  return ({ prompt, options }) => {
    const stream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        const text = await firstPromptText(prompt)
        const name = /fixture:([a-z][a-z0-9-]*)/.exec(text)?.[1] ?? 'tools'
        const lines = readFileSync(`${dir}/${name}.jsonl`, 'utf8').split('\n').filter((line) => line.trim() !== '')
        for (const line of lines) {
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.fake === 'permission') {
            yield* fakePermission(parsed, options)
            continue
          }
          if (parsed.fake === 'sleep') {
            await new Promise((resolve) => setTimeout(resolve, typeof parsed.ms === 'number' ? parsed.ms : 100))
            continue
          }
          if (parsed.fake === 'write') {
            const target = String(parsed.path)
            await mkdir(dirname(target), { recursive: true }).catch(() => undefined)
            await writeFile(target, String(parsed.content))
            continue
          }
          yield freshFakeLine(parsed)
        }
      },
      interrupt: async () => undefined,
      supportedCommands: async () => fakeCommands,
      getContextUsage: async () => fakeUsage,
    }
    return stream
  }
}

async function firstPromptText(prompt: AsyncIterable<SDKUserMessage>): Promise<string> {
  const first = await prompt[Symbol.asyncIterator]().next()
  const content = first.value?.message?.content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).filter((block) => block.type === 'text').map((block) => asString(block.text)).join('')
}

function freshFakeLine(parsed: Record<string, unknown>): SDKMessage {
  if (parsed.type === 'system') return { ...parsed, session_id: crypto.randomUUID() } as unknown as SDKMessage
  if (parsed.type === 'assistant') return { ...parsed, uuid: crypto.randomUUID(), parent_tool_use_id: null } as unknown as SDKMessage
  if (parsed.type === 'result') return { ...parsed, total_cost_usd: 0.42 } as unknown as SDKMessage
  return parsed as SDKMessage
}

async function* fakePermission(parsed: Record<string, unknown>, options: Options): AsyncGenerator<SDKMessage> {
  const toolName = asString(parsed.toolName) || 'Bash'
  const input = isRecord(parsed.input) ? parsed.input : {}
  const toolUseId = `toolu_fake_${crypto.randomUUID().slice(0, 8)}`
  const requestId = `req_${toolUseId}`
  yield freshFakeLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }] },
    uuid: '',
  }) as SDKMessage
  const decision = await options.canUseTool?.(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId,
    title: asString(parsed.title) || undefined,
    description: asString(parsed.description) || undefined,
    suggestions: Array.isArray(parsed.suggestions) ? (parsed.suggestions as PermissionUpdate[]) : undefined,
  })
  const allowed = decision?.behavior === 'allow'
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: allowed ? 'ok' : (decision?.behavior === 'deny' ? decision.message : 'Cancelled.'), is_error: !allowed }],
    },
    parent_tool_use_id: null,
  } as SDKMessage
}
