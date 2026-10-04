import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { createJobManager } from '../server/jobs'
import { fakeEchoResolver } from '../server/jobs-engine-iface'
import { createModelDiscovery, type ModelDiscovery } from '../server/model-discovery'
import { studioRoutes } from '../server/routes/studio'
import { createWorkflowRunner } from '../server/workflow-runner'
import { createWorkflowStore } from '../server/workflows'

let dir: string, app: Elysia, discovery: ModelDiscovery, endpoint: () => Response | Promise<Response>, bridgeCalls: number
const ollama = { id: 'local', name: 'Local models', adapter: 'opencode', command: 'opencode', args: ['acp'], baseUrl: 'http://localhost:11434/v1' }
const grok = { id: 'grok', name: 'Grok', adapter: 'acp', command: 'grok', args: ['agent', 'stdio'] }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-connection-models-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  bridgeCalls = 0
  endpoint = () => Response.json({ data: [{ id: 'llama3' }, { id: 'qwen3' }] })
  const fetchImpl = Object.assign(async () => endpoint(), { preconnect: () => {} }) as unknown as typeof fetch
  discovery = createModelDiscovery({ base: dir, fetchImpl, background: false, now: () => 5000, bridge: async () => { bridgeCalls++; return [{ type: 'mc_models', models: ['grok-4.7', 'grok-4.5'], current: 'grok-4.7' }] } })
  const store = createWorkflowStore(dir)
  const runner = createWorkflowRunner({ manager: createJobManager(), resolver: fakeEchoResolver, store, requireApproval: async () => true })
  app = new Elysia().use(studioRoutes(store, runner, undefined, undefined, undefined, discovery))
})
afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})
function call(path: string, method = 'GET', body?: unknown) {
  return app.handle(new Request(`http://localhost/api/studio${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}

test('an OpenCode endpoint with no model IDs is saved with the models it lists', async () => {
  const response = await call('/connections', 'POST', ollama)
  expect(response.status).toBe(200)
  expect((await discovery.read('local'))).toEqual({ models: ['llama3', 'qwen3'], current: null, checkedAt: 5000, error: null })
  const listed = await (await call('/connections')).json()
  expect(listed.connections.map((item: { id: string }) => item.id)).toEqual(['local'])
  expect(listed.connections[0].models).toEqual([])
  expect(listed.models.local).toEqual(['llama3', 'qwen3'])
  expect(listed.discovery.local.models).toEqual(['llama3', 'qwen3'])
})

test('an OpenCode endpoint that cannot list models is refused with the reason', async () => {
  endpoint = () => new Response('nope', { status: 401 })
  const response = await call('/connections', 'POST', ollama)
  expect(response.status).toBe(400)
  expect((await response.json()).error).toBe("Couldn't list models from http://localhost:11434/v1: HTTP 401. Add at least one model ID.")
  expect((await (await call('/connections')).json()).connections).toEqual([])
  endpoint = () => Response.json({ data: [] })
  expect((await (await call('/connections', 'POST', ollama)).json()).error).toContain("Couldn't list models from http://localhost:11434/v1")
})

test('an OpenCode endpoint with typed model IDs is saved without asking it', async () => {
  endpoint = () => { throw new Error('should not be called') }
  expect((await call('/connections', 'POST', { ...ollama, models: ['llama3'] })).status).toBe(200)
})

test('refreshing an ACP connection returns what the agent reported', async () => {
  await call('/connections', 'POST', grok)
  const response = await call('/connections/grok/models/refresh', 'POST', {})
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ models: ['grok-4.7', 'grok-4.5'], current: 'grok-4.7', checkedAt: 5000, error: null })
  expect(bridgeCalls).toBe(1)
  expect((await (await call('/connections')).json()).models.grok).toEqual(['grok-4.7', 'grok-4.5'])
})

test('a CLI connection cannot be refreshed', async () => {
  await call('/connections', 'POST', { id: 'mycli', name: 'My CLI', adapter: 'cli', command: 'agent', args: ['-p', '{{prompt}}'] })
  const response = await call('/connections/mycli/models/refresh', 'POST', {})
  expect(response.status).toBe(400)
  expect((await response.json()).error).toBe("This connection can't report its models; list them in its settings.")
  expect((await (await call('/connections')).json()).discovery).toEqual({ mycli: null })
})

test('removing a connection forgets its discovered models', async () => {
  await call('/connections', 'POST', grok)
  await call('/connections/grok/models/refresh', 'POST', {})
  expect((await call('/connections/grok', 'DELETE')).status).toBe(200)
  expect(await discovery.read('grok')).toBeNull()
})
