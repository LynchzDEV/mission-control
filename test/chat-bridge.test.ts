import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Options, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  chatModeOptions,
  fakeQuery,
  makeSpawner,
  runBridge,
  settingsPermissionMode,
  type BridgeControl,
  type BridgeLaunch,
  type BridgeQuery,
} from '../server/chat-bridge-core'

const FIXTURES = join(import.meta.dir, 'fixtures', 'chat-bridge')

type Line = Record<string, unknown>

function baseLaunch(overrides: Partial<BridgeLaunch> = {}): BridgeLaunch {
  return {
    prompt: 'fixture:tools',
    images: [],
    resumeSessionId: null,
    forkSession: false,
    resumeSessionAt: null,
    model: null,
    permissionMode: 'ask',
    appendSystemPrompt: 'RULES',
    disallowedTools: [],
    allowedTools: [],
    claudePath: '/usr/bin/true',
    ...overrides,
  }
}

function controlQueue(): AsyncIterable<BridgeControl> & { push(control: BridgeControl): void; end(): void } {
  const pending: BridgeControl[] = []
  const waiters: Array<(result: IteratorResult<BridgeControl>) => void> = []
  let done = false
  return {
    push(control) {
      const waiter = waiters.shift()
      if (waiter === undefined) pending.push(control)
      else waiter({ value: control, done: false })
    },
    end() {
      done = true
      for (const waiter of waiters) waiter({ value: undefined as never, done: true })
      waiters.length = 0
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<BridgeControl>> {
          const value = pending.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        },
      }
    },
  }
}

type Harness = { lines: Line[]; controls: ReturnType<typeof controlQueue>; controller: AbortController }

function harness(): Harness {
  return { lines: [], controls: controlQueue(), controller: new AbortController() }
}

async function bridgeRun(launch: BridgeLaunch, h: Harness, query: BridgeQuery, overrides: Partial<Parameters<typeof runBridge>[1]> = {}): Promise<number> {
  return runBridge(launch, {
    query,
    write: (line) => h.lines.push(line as Line),
    controls: h.controls,
    readFile: async () => new Uint8Array(),
    signal: h.controller.signal,
    ...overrides,
  })
}

const byType = (h: Harness, type: string): Line[] => h.lines.filter((line) => line.type === type)

async function firstPrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage | undefined> {
  return (await prompt[Symbol.asyncIterator]().next()).value
}

const INIT: SDKMessage = { type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' } as SDKMessage

function resultLine(isError: boolean): SDKMessage {
  return { type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: 'done', total_cost_usd: 0.42 } as SDKMessage
}

function recordingQuery(messages: SDKMessage[], captured: { options?: Options; prompt?: SDKUserMessage }, extras: Partial<Pick<ReturnType<BridgeQuery>, 'supportedCommands' | 'getContextUsage'>> = {}): BridgeQuery {
  return ({ prompt, options }) => {
    captured.options = options
    const stream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        captured.prompt = await firstPrompt(prompt)
        for (const message of messages) yield message
      },
      interrupt: async () => undefined,
      supportedCommands: extras.supportedCommands ?? (async () => [{ name: 'review', description: 'Review the current changes', argumentHint: '' }]),
      getContextUsage: extras.getContextUsage ?? (async () => ({ percentage: 62, totalTokens: 124_000, maxTokens: 200_000 }) as never),
    }
    return stream
  }
}

type AskOptions = { suggestions?: PermissionUpdate[]; suppressAlwaysAllowRule?: boolean }

function permissionQuery(toolName: string, input: Record<string, unknown>, ask: AskOptions, decisions: PermissionResult[]): BridgeQuery {
  return ({ prompt, options }) => {
    const stream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        await firstPrompt(prompt)
        yield INIT
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: toolName, input }] }, uuid: '22222222-2222-4222-8222-222222222222', parent_tool_use_id: null } as SDKMessage
        decisions.push((await options.canUseTool?.(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: 't1',
          requestId: 'r1',
          ...(ask.suggestions === undefined ? {} : { suggestions: ask.suggestions }),
          ...(ask.suppressAlwaysAllowRule === undefined ? {} : { suppressAlwaysAllowRule: ask.suppressAlwaysAllowRule }),
        })) as PermissionResult)
        yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] }, parent_tool_use_id: null } as SDKMessage
        yield resultLine(false)
      },
      interrupt: async () => undefined,
      supportedCommands: async () => [],
      getContextUsage: async () => ({ percentage: 62, totalTokens: 124_000, maxTokens: 200_000 }) as never,
    }
    return stream
  }
}

const allow = (decision: BridgeControl['decision']): BridgeControl => ({ type: 'permission', requestId: 'r1', decision })

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

async function answerFakeAsk(h: Harness, decision: BridgeControl['decision']): Promise<void> {
  await waitFor(() => byType(h, 'mc_permission_request').length > 0)
  const request = byType(h, 'mc_permission_request')[0]
  h.controls.push({ type: 'permission', requestId: String(request.requestId), decision })
}

let envDir: string | undefined

beforeEach(() => { envDir = undefined })
afterEach(async () => {
  if (envDir !== undefined) {
    if (process.env.CLAUDE_CONFIG_DIR === envDir) delete process.env.CLAUDE_CONFIG_DIR
    await rm(envDir, { recursive: true, force: true })
  }
})

describe('always-allow rules', () => {
  test('an addRules suggestion becomes the persisted rule', async () => {
    const decisions: PermissionResult[] = []
    const h = harness()
    h.controls.push(allow('allow_always'))
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'bun test:*' }], behavior: 'allow', destination: 'localSettings' }]
    const code = await bridgeRun(baseLaunch(), h, permissionQuery('Bash', { command: 'x' }, { suggestions }, decisions))
    expect(byType(h, 'mc_permission_resolved')[0]).toMatchObject({ decision: 'allow_always', rules: ['Bash(bun test:*)'] })
    expect(decisions[0]).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', destination: 'session' }] })
    expect(code).toBe(0)
  })

  test('a Bash command without suggestions persists the exact command', async () => {
    const h = harness()
    h.controls.push(allow('allow_always'))
    await bridgeRun(baseLaunch(), h, permissionQuery('Bash', { command: 'ls -la' }, {}, []))
    expect(byType(h, 'mc_permission_resolved')[0]).toMatchObject({ rules: ['Bash(ls -la)'] })
  })

  test('file-writing and read tools persist absolute-path rules', async () => {
    const write = harness()
    write.controls.push(allow('allow_always'))
    await bridgeRun(baseLaunch(), write, permissionQuery('Write', { file_path: '/Users/a/x.ts' }, {}, []))
    expect(byType(write, 'mc_permission_resolved')[0]).toMatchObject({ rules: ['Edit(//Users/a/x.ts)'] })
    const read = harness()
    read.controls.push(allow('allow_always'))
    await bridgeRun(baseLaunch(), read, permissionQuery('Read', { file_path: '/Users/a/y.md' }, {}, []))
    expect(byType(read, 'mc_permission_resolved')[0]).toMatchObject({ rules: ['Read(//Users/a/y.md)'] })
    const bare = harness()
    bare.controls.push(allow('allow_always'))
    await bridgeRun(baseLaunch(), bare, permissionQuery('Read', { pattern: 'x' }, {}, []))
    expect(byType(bare, 'mc_permission_resolved')[0]).toMatchObject({ decision: 'allow_always', rules: [], reason: 'no-rule' })
  })

  test('launch allowedTools reach the query options', async () => {
    const captured: { options?: Options } = {}
    const h = harness()
    await bridgeRun(baseLaunch({ allowedTools: ['Bash(x)'] }), h, recordingQuery([INIT, resultLine(false)], captured))
    expect(captured.options?.allowedTools).toEqual(['Bash(x)'])
  })
})

describe('permission round trip through the fake engine', () => {
  test('allow once answers the tool call and the turn succeeds', async () => {
    const h = harness()
    const running = bridgeRun(baseLaunch({ prompt: 'fixture:permission' }), h, fakeQuery(FIXTURES))
    await answerFakeAsk(h, 'allow_once')
    const code = await running
    expect(byType(h, 'mc_permission_request')[0]).toMatchObject({ mc: true, toolName: 'Bash', title: 'Claude wants to run a command' })
    expect(byType(h, 'mc_permission_resolved')[0]).toMatchObject({ decision: 'allow_once' })
    const toolResult = h.lines.find((line) => line.type === 'user' && JSON.stringify(line).includes('tool_result'))
    expect(JSON.stringify(toolResult)).toContain('"content":"ok"')
    expect(JSON.stringify(toolResult)).toContain('"is_error":false')
    expect(byType(h, 'result')[0]).toMatchObject({ is_error: false })
    expect(code).toBe(0)
  })

  test('deny marks the tool result as an error', async () => {
    const h = harness()
    const running = bridgeRun(baseLaunch({ prompt: 'fixture:permission' }), h, fakeQuery(FIXTURES))
    await answerFakeAsk(h, 'deny')
    await running
    expect(byType(h, 'mc_permission_resolved')[0]).toMatchObject({ decision: 'deny' })
    const toolResult = h.lines.find((line) => line.type === 'user' && JSON.stringify(line).includes('tool_result'))
    expect(JSON.stringify(toolResult)).toContain('"is_error":true')
    expect(JSON.stringify(toolResult)).toContain('declined this in Mission Control')
  })

  test('suppressAlways treats allow_always as allow once', async () => {
    const decisions: PermissionResult[] = []
    const h = harness()
    h.controls.push(allow('allow_always'))
    await bridgeRun(baseLaunch(), h, permissionQuery('Bash', { command: 'ls' }, { suppressAlwaysAllowRule: true }, decisions))
    expect(byType(h, 'mc_permission_resolved')[0]).toMatchObject({ decision: 'allow_once' })
    expect(decisions[0]).not.toHaveProperty('updatedPermissions')
  })

  test('controls ending while pending reads as a restart', async () => {
    const h = harness()
    h.controls.end()
    await bridgeRun(baseLaunch({ prompt: 'fixture:permission' }), h, fakeQuery(FIXTURES))
    expect(byType(h, 'mc_permission_resolved')[0]).toMatchObject({ decision: 'cancelled', reason: 'restart' })
    const toolResult = h.lines.find((line) => line.type === 'user' && JSON.stringify(line).includes('tool_result'))
    expect(JSON.stringify(toolResult)).toContain('Mission Control restarted')
  })

  test('a ten minute silence cancels with reason timeout', async () => {
    const h = harness()
    await bridgeRun(baseLaunch({ prompt: 'fixture:permission' }), h, fakeQuery(FIXTURES), { waitMs: async () => {} })
    expect(byType(h, 'mc_permission_resolved')[0]).toMatchObject({ decision: 'cancelled', reason: 'timeout' })
  })
})

describe('prompt content', () => {
  test('images travel as base64 blocks before the text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-bridge-img-'))
    envDir = undefined
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await writeFile(join(dir, 'shot.png'), bytes)
    const captured: { options?: Options; prompt?: SDKUserMessage } = {}
    const h = harness()
    const code = await runBridge(baseLaunch({ prompt: 'what is this', images: [{ path: join(dir, 'shot.png'), mediaType: 'image/png' }] }), {
      query: recordingQuery([INIT, resultLine(false)], captured),
      write: (line) => h.lines.push(line as Line),
      controls: h.controls,
      readFile: async (path) => (path.endsWith('shot.png') ? bytes : new Uint8Array()),
      signal: h.controller.signal,
    })
    const content = (captured.prompt?.message as { content: Array<Record<string, unknown>> }).content
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(bytes).toString('base64') } })
    expect((content[1] as { text: string }).text).toBe('what is this')
    expect(code).toBe(0)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('stop and failure', () => {
  test('an abort mid-reply exits 143 without a success result', async () => {
    const h = harness()
    const running = bridgeRun(baseLaunch({ prompt: 'fixture:slow' }), h, fakeQuery(FIXTURES))
    await waitFor(() => byType(h, 'stream_event').length > 0)
    h.controller.abort()
    expect(await running).toBe(143)
    expect(byType(h, 'result').filter((line) => line.is_error !== true)).toHaveLength(0)
  })

  test('a thrown query reports the error with the collected stderr', async () => {
    const h = harness()
    const failing: BridgeQuery = ({ prompt, options }) => {
      const stream = {
        async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
          await firstPrompt(prompt)
          yield INIT
          options.spawnClaudeCodeProcess?.({ command: '/bin/sh', args: ['-c', 'echo e1 >&2'], cwd: process.cwd(), env: { ...process.env } } as never)
          await new Promise((resolve) => setTimeout(resolve, 150))
          throw new Error('boom')
        },
        interrupt: async () => undefined,
        supportedCommands: async () => [],
        getContextUsage: async () => ({ percentage: 0, totalTokens: 0, maxTokens: 0 }) as never,
      }
      return stream
    }
    const code = await bridgeRun(baseLaunch(), h, failing)
    expect(code).toBe(1)
    expect(byType(h, 'mc_child')[0]).toMatchObject({ mc: true })
    expect(byType(h, 'mc_stderr').map((line) => line.text).join('')).toContain('e1')
    expect(h.lines.at(-1)).toMatchObject({ type: 'result', is_error: true, result: 'boom\ne1' })
  })
})

describe('query options', () => {
  test('carry the preset system prompt, the blocked ask tool and the parent env', async () => {
    const captured: { options?: Options } = {}
    const h = harness()
    await bridgeRun(baseLaunch({ appendSystemPrompt: 'RULES' }), h, recordingQuery([INIT, resultLine(false)], captured))
    expect(captured.options?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'RULES' })
    expect(captured.options?.disallowedTools).toContain('AskUserQuestion')
    expect((captured.options?.env as Record<string, string>).PATH).toBe(process.env.PATH)
    expect(captured.options?.pathToClaudeCodeExecutable).toBe('/usr/bin/true')
    expect(captured.options?.includePartialMessages).toBe(true)
  })

  test('map the chat permission modes onto SDK modes', async () => {
    const ask: { options?: Options } = {}
    await bridgeRun(baseLaunch({ permissionMode: 'ask' }), harness(), recordingQuery([INIT, resultLine(false)], ask))
    expect(ask.options?.permissionMode).toBe('default')
    const bypass: { options?: Options } = {}
    await bridgeRun(baseLaunch({ permissionMode: 'bypass' }), harness(), recordingQuery([INIT, resultLine(false)], bypass))
    expect(bypass.options?.permissionMode).toBe('bypassPermissions')
    expect(bypass.options?.allowDangerouslySkipPermissions).toBe(true)
  })

  test("the settings mode reads the claude config dir's defaultMode", async () => {
    envDir = await mkdtemp(join(tmpdir(), 'mc-bridge-cfg-'))
    await writeFile(join(envDir, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }))
    process.env.CLAUDE_CONFIG_DIR = envDir
    const captured: { options?: Options } = {}
    await bridgeRun(baseLaunch({ permissionMode: 'settings' }), harness(), recordingQuery([INIT, resultLine(false)], captured))
    expect(captured.options?.permissionMode).toBe('acceptEdits')
    expect(captured.options?.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('the settings mode falls back to default without a settings file', async () => {
    envDir = await mkdtemp(join(tmpdir(), 'mc-bridge-cfg-'))
    process.env.CLAUDE_CONFIG_DIR = envDir
    const captured: { options?: Options } = {}
    await bridgeRun(baseLaunch({ permissionMode: 'settings' }), harness(), recordingQuery([INIT, resultLine(false)], captured))
    expect(captured.options?.permissionMode).toBe('default')
  })
})

describe('settingsPermissionMode', () => {
  test('reads known modes and falls back to default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-bridge-settings-'))
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }))
    expect(settingsPermissionMode(dir)).toBe('auto')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
    expect(settingsPermissionMode(dir)).toBe('bypassPermissions')
    expect(settingsPermissionMode(join(dir, 'missing'))).toBe('default')
    await writeFile(join(dir, 'settings.json'), '{oops')
    expect(settingsPermissionMode(dir)).toBe('default')
    await rm(dir, { recursive: true, force: true })
  })

  test('a bypassPermissions settings mode also sets the dangerous skip flag', () => {
    process.env.CLAUDE_CONFIG_DIR = '/definitely/missing/mc-bridge-test'
    expect(chatModeOptions('bypass')).toEqual({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
    delete process.env.CLAUDE_CONFIG_DIR
  })
})

describe('makeSpawner', () => {
  test('reports the child pid and drains its stderr', async () => {
    const lines: Line[] = []
    const stderr: string[] = []
    const spawner = makeSpawner((line) => lines.push(line as Line), (text) => stderr.push(text))
    const child = spawner({ command: '/bin/sh', args: ['-c', 'echo e1 >&2'], cwd: process.cwd(), env: { ...process.env } } as never)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(lines[0]).toMatchObject({ type: 'mc_child', mc: true })
    expect(typeof lines[0].pid).toBe('number')
    expect(stderr.join('')).toContain('e1')
    expect(child.exitCode).toBe(0)
  })
})

describe('bridge info lines', () => {
  test('commands and context arrive after init and result', async () => {
    const h = harness()
    const code = await bridgeRun(baseLaunch({ prompt: 'fixture:tools' }), h, fakeQuery(FIXTURES))
    const commands = byType(h, 'mc_commands')[0]
    expect((commands?.commands as Array<{ name: string }>).map((command) => command.name)).toEqual(['review', 'compact', 'init'])
    expect(byType(h, 'mc_context')[0]).toMatchObject({ percentage: 62, totalTokens: 124_000, maxTokens: 200_000 })
    expect(code).toBe(0)
    const commandsIndex = h.lines.indexOf(commands)
    const contextIndex = h.lines.findIndex((line) => line.type === 'mc_context')
    const resultIndex = h.lines.findIndex((line) => line.type === 'result')
    expect(resultIndex).toBeGreaterThan(-1)
    expect(contextIndex).toBeGreaterThan(resultIndex)
    expect(h.lines.findIndex((line) => line.type === 'system')).toBeLessThan(commandsIndex)
  })

  test('a hanging supportedCommands probe skips its line without blocking the run', async () => {
    const h = harness()
    const code = await bridgeRun(baseLaunch(), h, recordingQuery([INIT, resultLine(false)], {}), {
      waitMs: async () => {},
    })
    expect(code).toBe(0)
    expect(byType(h, 'mc_commands')).toHaveLength(0)
  })
})
