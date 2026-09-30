import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

import { query, type CanUseTool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import { buildEnv } from '../server/engines'
import { chatEnv, ensureChatProfile } from '../server/chat-profile'

const WORKTREE = resolve(import.meta.dir, '..')
const SPIKE = join(WORKTREE, '.spike')
const CLAUDE_PATH = Bun.which('claude') ?? 'claude'
const QUERY_TIMEOUT_MS = 240_000

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }

type PermissionCall = {
  toolName: string
  input: Record<string, unknown>
  decision: 'allow' | 'deny'
  suggestions: unknown
  suppressAlways: boolean
}

type SpikeRun = {
  sessionId: string | null
  initPermissionMode: string | null
  texts: string[]
  lastAssistantUuid: string | null
  toolResults: Array<{ isError: boolean; text: string }>
  costUsd: number | null
  subtype: string | null
  isError: boolean
  permissionCalls: PermissionCall[]
  error: string | null
}

type SpikeSpec = {
  prompt: string
  blocks?: Block[]
  engine?: 'claude' | 'glm'
  resume?: string
  forkSession?: boolean
  resumeSessionAt?: string
  allowedTools?: string[]
  decisions?: Array<'allow' | 'deny'>
  extraOptions?: Partial<Options>
  timeoutMs?: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function solidRedPng(size = 16): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0).fill(0)])
  for (let offset = 1; offset < row.length; offset += 3) {
    row[offset] = 255
    row[offset + 2] = 0
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null || (block as Record<string, unknown>).type !== 'text') continue
    const text = (block as Record<string, unknown>).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('')
}

async function spikeEnv(engine: 'claude' | 'glm'): Promise<Record<string, string>> {
  if (engine === 'claude') return buildEnv('claude', { worker: false })
  const profile = await ensureChatProfile({ configDir: join(SPIKE, 'glm-profile') })
  return { ...(await buildEnv('glm', { worker: false })), ...chatEnv('glm', { claude: profile.claude, codex: '' }) }
}

async function runSpike(spec: SpikeSpec): Promise<SpikeRun> {
  const run: SpikeRun = {
    sessionId: null, initPermissionMode: null, texts: [], lastAssistantUuid: null, toolResults: [],
    costUsd: null, subtype: null, isError: false, permissionCalls: [], error: null,
  }
  const decisions = spec.decisions ?? []
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const decision = decisions[run.permissionCalls.length] ?? 'deny'
    run.permissionCalls.push({
      toolName,
      input,
      decision,
      suggestions: options.suggestions ?? null,
      suppressAlways: options.suppressAlwaysAllowRule === true,
    })
    return decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'The spike denied this tool call.' }
  }
  let release!: () => void
  const done = new Promise<void>(resolveDone => { release = resolveDone })
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: spec.blocks ?? spec.prompt }, parent_tool_use_id: null }
    await done
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), spec.timeoutMs ?? QUERY_TIMEOUT_MS)
  try {
    const options: Options = {
      env: await spikeEnv(spec.engine ?? 'claude'),
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      abortController: abort,
      canUseTool,
      ...(spec.resume === undefined ? {} : { resume: spec.resume }),
      ...(spec.forkSession ? { forkSession: true } : {}),
      ...(spec.resumeSessionAt === undefined ? {} : { resumeSessionAt: spec.resumeSessionAt }),
      ...(spec.allowedTools === undefined ? {} : { allowedTools: spec.allowedTools }),
      ...spec.extraOptions,
    }
    for await (const message of query({ prompt: stream(), options })) {
      collect(message, run)
      if (message.type === 'result') break
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
    release()
  }
  return run
}

function collect(message: SDKMessage, run: SpikeRun): void {
  const raw = message as unknown as Record<string, unknown>
  if (message.type === 'system' && message.subtype === 'init') {
    run.sessionId = typeof raw.session_id === 'string' ? raw.session_id : null
    run.initPermissionMode = typeof raw.permissionMode === 'string' ? raw.permissionMode : null
    return
  }
  if (message.type === 'assistant') {
    if (message.parent_tool_use_id === null && typeof message.uuid === 'string') run.lastAssistantUuid = message.uuid
    const text = textOfContent(message.message?.content).trim()
    if (text !== '') run.texts.push(text)
    return
  }
  if (message.type === 'user') {
    const content = (message as unknown as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null || (block as Record<string, unknown>).type !== 'tool_result') continue
      const record = block as Record<string, unknown>
      run.toolResults.push({ isError: record.is_error === true, text: textOfContent(record.content) })
    }
    return
  }
  if (message.type === 'result') {
    run.costUsd = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null
    run.subtype = message.subtype ?? null
    run.isError = message.is_error === true
  }
}

async function cliReadySession(): Promise<{ sessionId: string | null; costUsd: number | null; stderr: string }> {
  const proc = Bun.spawn([CLAUDE_PATH, '-p', 'Reply with the word ready', '--output-format', 'json'], {
    cwd: WORKTREE,
    env: await buildEnv('claude', { worker: false }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    const cost = parsed.total_cost_usd ?? parsed.costUSD
    return { sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null, costUsd: typeof cost === 'number' ? cost : null, stderr }
  } catch {
    return { sessionId: null, costUsd: null, stderr }
  }
}

function userSettingsDefaultMode(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>
    const permissions = parsed.permissions as Record<string, unknown> | undefined
    const mode = permissions?.defaultMode
    return typeof mode === 'string' ? mode : 'default'
  } catch {
    return 'default'
  }
}

const marker = (name: string): string => join(SPIKE, name)

async function main(): Promise<void> {
  await rm(SPIKE, { recursive: true, force: true })
  await mkdir(SPIKE, { recursive: true })
  const outcomes: Record<string, unknown> = { claudePath: CLAUDE_PATH, sdkVersion: '0.3.285' }

  const red = solidRedPng(16)
  await writeFile(join(SPIKE, 'red.png'), red)

  const imageRun = await runSpike({
    prompt: 'What colour is this square? One word.',
    blocks: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: red.toString('base64') } },
      { type: 'text', text: 'What colour is this square? One word.' },
    ],
  })
  const imageAnswer = imageRun.texts.join(' ').toLowerCase()
  outcomes.a_image = {
    answer: imageRun.texts.join(' '),
    sawRed: imageAnswer.includes('red'),
    error: imageRun.error,
  }
  outcomes.f_settings_mode = {
    fileDefaultMode: userSettingsDefaultMode(),
    initPermissionMode: imageRun.initPermissionMode,
    match: userSettingsDefaultMode() === imageRun.initPermissionMode,
  }

  const cli = await cliReadySession()
  outcomes.b_cli = { sessionId: cli.sessionId, costUsd: cli.costUsd, stderr: cli.stderr.slice(0, 400) }
  const firstResume = cli.sessionId === null ? null : await runSpike({ prompt: 'What word did you reply with?', resume: cli.sessionId })
  const secondResume = cli.sessionId === null ? null : await runSpike({ prompt: 'What word did you reply with?', resume: cli.sessionId })
  outcomes.b_resume = {
    firstAnswer: firstResume?.texts.join(' ') ?? null,
    firstCostUsd: firstResume?.costUsd ?? null,
    secondCostUsd: secondResume?.costUsd ?? null,
    firstError: firstResume?.error ?? null,
    secondError: secondResume?.error ?? null,
  }
  const cumulative = (secondResume?.costUsd ?? 0) >= (cli.costUsd ?? 0) + (firstResume?.costUsd ?? 0.0001) * 0.9
  outcomes.b_cost_shape = { sessionCumulative: cumulative }

  const forkRun = firstResume?.lastAssistantUuid ? await runSpike({
    prompt: 'What word did you reply with?',
    resume: cli.sessionId!,
    forkSession: true,
    resumeSessionAt: firstResume.lastAssistantUuid,
  }) : null
  outcomes.d_fork = {
    forkPoint: firstResume?.lastAssistantUuid ?? null,
    answer: forkRun?.texts.join(' ') ?? null,
    forkSessionId: forkRun?.sessionId ?? null,
    newSession: forkRun !== null && forkRun.sessionId !== null && forkRun.sessionId !== cli.sessionId,
    error: forkRun?.error ?? null,
  }

  try {
    await buildEnv('glm', { worker: false })
    const glmRun = await runSpike({ prompt: 'Reply with the word ready', engine: 'glm' })
    outcomes.c_glm = { answer: glmRun.texts.join(' '), ready: glmRun.texts.join(' ').toLowerCase().includes('ready'), error: glmRun.error }
  } catch (error) {
    outcomes.c_glm = { notConfigured: true, reason: error instanceof Error ? error.message : String(error) }
  }

  const eMarker = marker('e-marker')
  const denyRun = await runSpike({
    prompt: `Run exactly this shell command: touch ${eMarker}`,
    decisions: ['deny'],
    extraOptions: { settingSources: [], settings: { permissions: { ask: [`Bash(touch:*)`] } }, permissionMode: 'default' },
  })
  outcomes.e_deny = {
    asked: denyRun.permissionCalls.some(call => call.toolName === 'Bash'),
    markerExistsAfterDeny: existsSync(eMarker),
    toolResultError: denyRun.toolResults.some(result => result.isError),
    error: denyRun.error,
  }

  const gMarker = marker('g1')
  const g1 = await runSpike({
    prompt: `Run exactly this shell command: touch ${gMarker}`,
    decisions: ['allow'],
    extraOptions: { settingSources: [], settings: {}, permissionMode: 'default' },
  })
  const g1Suggestions = g1.permissionCalls[0]?.suggestions ?? null
  await rm(gMarker, { force: true })
  const g2 = g1.sessionId === null ? null : await runSpike({
    prompt: `Run exactly this shell command: touch ${gMarker}`,
    resume: g1.sessionId,
    allowedTools: [`Bash(touch ${gMarker})`],
    extraOptions: { settingSources: [], settings: {}, permissionMode: 'default' },
  })
  outcomes.g_bash_rule = {
    firstAsked: g1.permissionCalls.length > 0,
    firstSuggestions: g1Suggestions,
    secondAsked: (g2?.permissionCalls.length ?? 0) > 0,
    markerExistsAfterAllowRule: existsSync(gMarker),
    errors: [g1.error, g2?.error ?? null],
  }

  const hFile = marker('h1.txt')
  const h1 = await runSpike({
    prompt: `Create the file ${hFile} containing the word one`,
    decisions: ['allow'],
    extraOptions: { settingSources: [], settings: {}, permissionMode: 'default' },
  })
  await rm(hFile, { force: true })
  const h2 = h1.sessionId === null ? null : await runSpike({
    prompt: `Create the file ${hFile} containing the word two`,
    resume: h1.sessionId,
    allowedTools: [`Edit(/${hFile})`],
    extraOptions: { settingSources: [], settings: {}, permissionMode: 'default' },
  })
  const hContent = await readFile(hFile, 'utf8').catch(() => '')
  outcomes.h_file_rule = {
    firstAskedForWrite: h1.permissionCalls.some(call => call.toolName === 'Write'),
    secondAsked: (h2?.permissionCalls.length ?? 0) > 0,
    fileContains: hContent.trim(),
    errors: [h1.error, h2?.error ?? null],
  }

  await writeFile(join(SPIKE, 'results.json'), `${JSON.stringify(outcomes, null, 2)}\n`)
  console.log(JSON.stringify(outcomes, null, 2))
}

await main()
