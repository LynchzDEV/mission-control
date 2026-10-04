import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionSchema, type AgentConnection } from '../server/agent-connections'
import { createModelDiscovery, endpointModels, FRESH_MS, mergeModels, modelsFromSession, RETRY_AFTER_FAILURE_MS } from '../server/model-discovery'

const grokOptions = [{ value: 'grok-4.7', name: 'Grok 4.7' }, { value: 'grok-4.7-build-fast', name: 'Fast' }]

describe('modelsFromSession', () => {
  test('reads a flat model select option with its current value', () => {
    expect(modelsFromSession({ configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'code', options: [{ value: 'code', name: 'Code' }] }, { id: 'model', category: 'model', type: 'select', currentValue: 'grok-4.7', options: grokOptions }] }))
      .toEqual({ models: ['grok-4.7', 'grok-4.7-build-fast'], current: 'grok-4.7' })
  })

  test('flattens grouped options and finds the option by id when it has no category', () => {
    expect(modelsFromSession({ configOptions: [{ id: 'model', type: 'select', currentValue: 'b', options: [{ group: 'one', name: 'One', options: [{ value: 'a', name: 'A' }] }, { group: 'two', name: 'Two', options: [{ value: 'b', name: 'B' }] }] }] }))
      .toEqual({ models: ['a', 'b'], current: 'b' })
  })

  test('falls back to the older models form', () => {
    expect(modelsFromSession({ models: { currentModelId: 'grok-4.6', availableModels: [{ modelId: 'grok-4.6', name: 'x' }, { modelId: 'grok-4.5', name: 'y' }] } }))
      .toEqual({ models: ['grok-4.6', 'grok-4.5'], current: 'grok-4.6' })
  })

  test('configOptions win when both forms are present', () => {
    expect(modelsFromSession({ configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'grok-4.7', options: grokOptions }], models: { currentModelId: 'old', availableModels: [{ modelId: 'old', name: 'Old' }] } }))
      .toEqual({ models: ['grok-4.7', 'grok-4.7-build-fast'], current: 'grok-4.7' })
  })

  test('reports nothing when the session has no model information', () => {
    expect(modelsFromSession({ sessionId: 's' })).toEqual({ models: [], current: null })
    expect(modelsFromSession(null)).toEqual({ models: [], current: null })
    expect(modelsFromSession({ configOptions: [{ id: 'model', category: 'model', type: 'boolean', currentValue: true }] })).toEqual({ models: [], current: null })
  })

  test('drops duplicate model ids and keeps the first order', () => {
    expect(modelsFromSession({ configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { group: 'g', name: 'G', options: [{ value: 'a', name: 'A again' }, { value: 'b', name: 'B' }] }] }] }).models)
      .toEqual(['a', 'b'])
  })
})

describe('endpointModels', () => {
  type Call = { url: string; headers: Record<string, string> }
  function fakeFetch(response: () => Response | Promise<Response>, calls: Call[] = []) {
    return Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
      return response()
    }, { preconnect: () => {} }) as unknown as typeof fetch
  }

  test('lists the ids an OpenAI-compatible endpoint returns', async () => {
    const calls: Call[] = []
    const ids = await endpointModels('http://localhost:11434/v1', undefined, fakeFetch(() => Response.json({ data: [{ id: 'llama3' }, { id: 'qwen3' }] }), calls))
    expect(ids).toEqual(['llama3', 'qwen3'])
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/models')
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  test('drops a trailing slash and sends a bearer key only when there is one', async () => {
    const calls: Call[] = []
    await endpointModels('https://api.example.com/v1/', 'sk-test-key', fakeFetch(() => Response.json({ data: [{ id: 'm' }] }), calls))
    expect(calls[0]!.url).toBe('https://api.example.com/v1/models')
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test-key')
  })

  test('an HTTP error names the status and never the key', async () => {
    const error = await endpointModels('https://api.example.com/v1', 'sk-test-key', fakeFetch(() => new Response('denied sk-test-key', { status: 401 }))).catch(caught => caught as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('401')
    expect((error as Error).message).not.toContain('sk-test-key')
  })

  test('a malformed body is an error', async () => {
    await expect(endpointModels('https://api.example.com/v1', undefined, fakeFetch(() => Response.json({ models: ['m'] })))).rejects.toThrow()
    await expect(endpointModels('https://api.example.com/v1', undefined, fakeFetch(() => new Response('not json')))).rejects.toThrow()
  })

  test('a network failure keeps its reason and never the key', async () => {
    const failing = Object.assign(async () => { throw new Error('connect ECONNREFUSED sk-test-key') }, { preconnect: () => {} }) as unknown as typeof fetch
    const error = await endpointModels('http://localhost:9/v1', 'sk-test-key', failing).catch(caught => caught as Error)
    expect((error as Error).message).toContain('ECONNREFUSED')
    expect((error as Error).message).not.toContain('sk-test-key')
  })
})

test('mergeModels keeps discovered models first, then new manual ones', () => {
  expect(mergeModels(['a', 'b'], ['b', 'c', 'a', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  expect(mergeModels([], ['x'])).toEqual(['x'])
})

describe('createModelDiscovery', () => {
  let dir: string
  let clock: number
  let calls: number
  let reply: () => Promise<Array<Record<string, unknown>>>
  const grok = connectionSchema.parse({ id: 'grok', name: 'Grok', adapter: 'acp', command: 'grok', args: ['agent', 'stdio'], models: ['grok-4.5', 'grok-custom'] })
  const cli = connectionSchema.parse({ id: 'mycli', name: 'My CLI', adapter: 'cli', command: 'agent', args: ['-p', '{{prompt}}'], models: ['x'] })
  const reported = (models: string[], current: string | null = models[0] ?? null) => async () => [{ type: 'system' }, { type: 'mc_models', models, current }]
  const discovery = () => createModelDiscovery({ base: dir, now: () => clock, bridge: async () => { calls++; return reply() } })
  const settle = () => Bun.sleep(5)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mc-discovery-'))
    clock = 1_000_000
    calls = 0
    reply = reported(['grok-4.7', 'grok-4.5'])
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  test('refresh writes what the agent reported', async () => {
    const store = discovery()
    expect(await store.read('grok')).toBeNull()
    const state = await store.refresh(grok)
    expect(state).toEqual({ models: ['grok-4.7', 'grok-4.5'], current: 'grok-4.7', checkedAt: clock, error: null })
    expect(await discovery().read('grok')).toEqual(state)
  })

  test('a failed refresh keeps the last models and records the error', async () => {
    const store = discovery()
    await store.refresh(grok)
    clock += 1000
    reply = async () => { throw new Error('grok is not signed in') }
    expect(await store.refresh(grok)).toEqual({ models: ['grok-4.7', 'grok-4.5'], current: 'grok-4.7', checkedAt: clock, error: 'grok is not signed in' })
  })

  test('an agent that reports no models is a failure, not an empty success', async () => {
    reply = reported([])
    expect(await discovery().refresh(grok)).toMatchObject({ models: [], error: expect.stringContaining('no models') })
  })

  test('two refreshes at once share one agent run', async () => {
    const store = discovery()
    const [first, second] = await Promise.all([store.refresh(grok), store.refresh(grok)])
    expect(calls).toBe(1)
    expect(second).toEqual(first)
  })

  test('a CLI connection is never asked and nothing is written', async () => {
    const store = discovery()
    expect(await store.refresh(cli)).toBeNull()
    expect(await store.ensureFresh(cli)).toBeNull()
    await settle()
    expect(calls).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  test('ensureFresh starts a check when nothing is known and returns at once', async () => {
    let release!: () => void
    reply = () => new Promise(resolve => { release = () => resolve([{ type: 'mc_models', models: ['grok-4.7'], current: 'grok-4.7' }]) })
    const store = discovery()
    expect(await store.ensureFresh(grok)).toBeNull()
    await settle()
    expect(calls).toBe(1)
    release()
    await store.refresh(grok)
    expect(calls).toBe(1)
    expect((await store.read('grok'))?.models).toEqual(['grok-4.7'])
  })

  test('a successful check stays fresh for a day', async () => {
    const store = discovery()
    await store.refresh(grok)
    clock += FRESH_MS - 1
    await store.ensureFresh(grok)
    await settle()
    expect(calls).toBe(1)
    clock += 1
    await store.ensureFresh(grok)
    await settle()
    expect(calls).toBe(2)
  })

  test('a failed check is retried after fifteen minutes, not before', async () => {
    reply = async () => { throw new Error('offline') }
    const store = discovery()
    await store.refresh(grok)
    clock += RETRY_AFTER_FAILURE_MS - 1
    await store.ensureFresh(grok)
    await settle()
    expect(calls).toBe(1)
    clock += 1
    await store.ensureFresh(grok)
    await settle()
    expect(calls).toBe(2)
  })

  test('ensureFresh never lets a background failure escape', async () => {
    reply = async () => { throw new Error('boom') }
    const store = discovery()
    await store.ensureFresh(grok)
    await settle()
    expect((await store.read('grok'))?.error).toBe('boom')
  })

  test('effective lists discovered models first and keeps manual extras once', async () => {
    const store = discovery()
    expect((await store.effective(grok)).models).toEqual(['grok-4.5', 'grok-custom'])
    await store.refresh(grok)
    const effective: AgentConnection = await store.effective(grok)
    expect(effective.models).toEqual(['grok-4.7', 'grok-4.5', 'grok-custom'])
    expect(effective.id).toBe('grok')
  })

  test('forget deletes the saved state', async () => {
    const store = discovery()
    await store.refresh(grok)
    await store.forget('grok')
    expect(await store.read('grok')).toBeNull()
    await store.forget('grok')
  })

  test('an OpenCode endpoint is listed over HTTP with the key from its environment variable', async () => {
    const seen: string[] = []
    const fetchImpl = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`)
      return Response.json({ data: [{ id: 'llama3' }] })
    }, { preconnect: () => {} }) as unknown as typeof fetch
    const opencode = connectionSchema.parse({ id: 'local', name: 'Local', adapter: 'opencode', command: 'opencode', args: ['acp'], baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'MC_DISCOVERY_TEST_KEY' })
    const store = createModelDiscovery({ base: dir, now: () => clock, fetchImpl, env: { MC_DISCOVERY_TEST_KEY: 'k1' }, bridge: async () => { calls++; return [] } })
    expect(await store.refresh(opencode)).toEqual({ models: ['llama3'], current: null, checkedAt: clock, error: null })
    expect(seen).toEqual(['http://localhost:11434/v1/models Bearer k1'])
    expect(calls).toBe(0)
  })

  test('discovery asks the bridge for models only, with a time limit', async () => {
    const inputs: unknown[] = []
    const store = createModelDiscovery({ base: dir, now: () => clock, bridge: async (input, timeoutMs) => { inputs.push({ input, timeoutMs }); return [{ type: 'mc_models', models: ['m'], current: 'm' }] } })
    await store.refresh(grok)
    expect(inputs).toEqual([{ input: { connection: grok, prompt: '', discoverModels: true }, timeoutMs: 45_000 }])
  })
})
