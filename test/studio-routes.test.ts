import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { completeSetup, SESSION_COOKIE } from '../server/auth'
import { createJobManager } from '../server/jobs'
import { fakeEchoResolver } from '../server/jobs-engine-iface'
import { createWorkflowStore, defaultWorkflow } from '../server/workflows'
import { createWorkflowRunner } from '../server/workflow-runner'
import { studioRoutes } from '../server/routes/studio'

let dir: string, app: Elysia, cookie: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-studio-api-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  const setup = await completeSetup('correct horse battery staple')
  if (!setup.ok) throw new Error('Setup failed')
  cookie = `${SESSION_COOKIE}=${setup.token}`
  const store = createWorkflowStore(dir)
  const runner = createWorkflowRunner({ manager: createJobManager(), resolver: fakeEchoResolver, store })
  app = new Elysia().use(studioRoutes(store, runner))
})
afterEach(async () => { delete process.env.MISSION_CONTROL_CONFIG_DIR; await rm(dir, { recursive: true, force: true }) })
function request(path: string, body?: unknown, auth = true) {
  return app.handle(new Request(`http://localhost/api/studio${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}

test('Studio configuration and execution require authentication', async () => {
  for (const path of ['/workflows', '/connections', '/policy', '/runs', '/drafts', '/drafts/unknown']) expect((await request(path, undefined, false)).status).toBe(401)
  expect((await request('/workflows', {}, false)).status).toBe(401)
  expect((await request('/drafts', {description:'Build a flow'}, false)).status).toBe(401)
  expect((await request('/drafts/unknown/stop', {}, false)).status).toBe(401)
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
