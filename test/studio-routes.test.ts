import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { createJobManager } from '../server/jobs'
import { fakeEchoResolver } from '../server/jobs-engine-iface'
import { createWorkflowStore, defaultWorkflow } from '../server/workflows'
import { createWorkflowRunner } from '../server/workflow-runner'
import { studioRoutes } from '../server/routes/studio'

let dir: string, app: Elysia
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-studio-api-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  const store = createWorkflowStore(dir)
  const runner = createWorkflowRunner({ manager: createJobManager(), resolver: fakeEchoResolver, store })
  app = new Elysia().use(studioRoutes(store, runner))
})
afterEach(async () => { delete process.env.MISSION_CONTROL_CONFIG_DIR; await rm(dir, { recursive: true, force: true }) })
function request(path: string, body?: unknown, origin = 'http://localhost') {
  return app.handle(new Request(`${origin}/api/studio${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}
function remove(path: string, origin = 'http://localhost') {
  return app.handle(new Request(`${origin}/api/studio${path}`, { method: 'DELETE' }))
}

test('Studio configuration and execution refuse a rebinding host', async () => {
  const rebind = 'http://rebind.example'
  for (const path of ['/workflows', '/connections', '/policy', '/runs', '/drafts', '/drafts/unknown']) expect((await request(path, undefined, rebind)).status).toBe(403)
  expect((await request('/workflows', {}, rebind)).status).toBe(403)
  expect((await request('/drafts', {description:'Build a flow'}, rebind)).status).toBe(403)
  expect((await request('/drafts/unknown/stop', {}, rebind)).status).toBe(403)
})

test('the draft endpoint returns JSON when no workflow is being drafted', async () => {
  const response = await request('/drafts')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ draft: null })
})

test('users can duplicate the default, save revisions and select a pinned default', async () => {
  const saved = await request('/workflows', { workflow: { ...defaultWorkflow(), id: 'custom', name: 'Custom' } })
  expect(saved.status).toBe(200)
  const graph = await saved.json()
  expect((await request('/default', { id: graph.id, revision: graph.revision })).status).toBe(200)
  const listing = await (await request('/workflows')).json()
  expect(listing.selected.id).toBe('custom')
  const invalid = await request('/workflows', { workflow: { ...graph, entry: 'execute' }, expectedRevision: graph.revision })
  expect(invalid.status).toBe(400)
})

test('custom agent setup exposes references, never the referenced credential value', async () => {
  process.env.MC_FIXTURE_KEY = 'sensitive-test-value'
  try {
    expect((await request('/connections', { id: 'qwen', name: 'Qwen', adapter: 'acp', command: 'qwen', args: ['--acp'], env: { API_KEY: 'MC_FIXTURE_KEY' } })).status).toBe(200)
    const body = await (await request('/connections')).text()
    expect(body).toContain('MC_FIXTURE_KEY')
    expect(body).not.toContain('sensitive-test-value')
  } finally { delete process.env.MC_FIXTURE_KEY }
})

test('a saved connection can be removed while built-ins stay', async () => {
  expect((await request('/connections', { id: 'qwen', name: 'Qwen', adapter: 'acp', command: 'qwen', args: ['--acp'] })).status).toBe(200)
  const removed = await remove('/connections/qwen')
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ ok: true })
  expect((await (await request('/connections')).json()).connections).toEqual([])
  const builtin = await remove('/connections/claude')
  expect(builtin.status).toBe(400)
  expect((await builtin.json()).error).toContain('built-in')
  expect((await remove('/connections/qwen', 'http://rebind.example')).status).toBe(403)
})
