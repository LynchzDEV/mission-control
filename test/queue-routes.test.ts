import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import type { QueueEngine } from '../server/queue-engine'
import { createQueueStore } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'

const store = () => createQueueStore(join(mkdtempSync(join(tmpdir(), 'mc-queue-routes-')), 'queue.json'))
const call = (app: Elysia, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
const post = (app: Elysia, path: string, body: unknown = {}) => call(app, path, { method: 'POST', body: JSON.stringify(body) })
const newItem = { source: 'clickup-board', externalId: '1', title: 'Task 1', url: 'u', repo: '/repo', flowId: null }

let repo: string
let plain: string
beforeAll(async () => {
  repo = await mkdtemp(join(homedir(), 'mc-queue-routes-repo-'))
  plain = await mkdtemp(join(homedir(), 'mc-queue-routes-plain-'))
  if (Bun.spawnSync(['git', 'init', '-q', repo]).exitCode !== 0) throw new Error('git init failed')
  await symlink(repo, join(plain, 'link'))
})
afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})

type Engine = Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies' | 'remove' | 'move'>

function engine(items: ReturnType<typeof store>, over: Partial<QueueEngine> = {}): Engine {
  const found = (id: string) => { const item = items.get(id); if (item === undefined) throw new Error(`No queue item ${id}`); return item }
  return {
    add: async input => items.add({ ...newItem, externalId: input.externalId, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end'),
    requeue: async id => items.update(id, { state: 'queued' }),
    checkReplies: async () => ({ checked: 2, resumed: 1 }),
    remove: async id => { if (found(id).state === 'building') throw new Error('It is building now'); await items.remove(id) },
    move: async (id, to) => { found(id); await items.move(id, to) },
    ...over,
  }
}

test('GET lists items; POST adds through the engine', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const added = await post(app, '/api/queue', { source: 'clickup-board', externalId: '7', repo: join(plain, 'link'), position: 'next' })
  expect(added.status).toBe(200)
  expect((await added.json()).item).toMatchObject({ externalId: '7', repo: await realpath(repo) })
  expect((await (await call(app, '/api/queue')).json()).items).toHaveLength(1)
})

test('POST rejects a bad body and reports a source failure as 502', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new Error('clickup-board is not installed') } })))
  expect((await post(app, '/api/queue', { source: '', externalId: '1', repo: '/repo' })).status).toBe(400)
  expect((await post(app, '/api/queue', { source: 'x', externalId: '1', repo: '/repo', position: 'top' })).status).toBe(400)
  const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect(failed.status).toBe(502)
  expect((await failed.json()).error).toBe('clickup-board is not installed')
})

test('POST refuses a repo that is missing, not git, or outside home before the engine sees it', async () => {
  const items = store()
  let calls = 0
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { calls += 1; throw new Error('unreachable') } })))
  const cases: Array<[string, string]> = [[plain, 'cwd is not a git repository'], [join(repo, 'missing'), 'cwd does not exist'], [tmpdir(), 'cwd must be under $HOME']]
  for (const [dir, error] of cases) {
    const refused = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo: dir })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toBe(error)
  }
  expect(calls).toBe(0)
})

test('POST maps an item already in the queue to 409', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new Error('Already in the queue') } })))
  const twice = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect(twice.status).toBe(409)
  expect((await twice.json()).error).toBe('Already in the queue')
})

test('delete and move go through the engine so they wait for a build in progress', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const seen: string[] = []
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    remove: async id => { seen.push(`remove ${id}`); throw new Error('It is building now') },
    move: async (id, to) => { seen.push(`move ${id} ${to}`) },
  })))
  const removing = await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })
  expect(removing.status).toBe(409)
  expect((await removing.json()).error).toBe('Stop its run in Studio first')
  expect((await post(app, `/api/queue/${a.id}/move`, { to: 3 })).status).toBe(200)
  expect(seen).toEqual([`remove ${a.id}`, `move ${a.id} 3`])
  expect(items.get(a.id)!.state).toBe('queued')
})

test('check returns the engine counts', async () => {
  const items = store()
  expect(await (await post(new Elysia().use(queueRoutes(items, engine(items))), '/api/queue/check')).json()).toEqual({ checked: 2, resumed: 1 })
})

test('move reorders and 404s an unknown id', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  await items.add(newItem, 'end')
  const b = await items.add({ ...newItem, externalId: '2' }, 'end')
  const moved = await post(app, `/api/queue/${b.id}/move`, { to: 0 })
  expect((await moved.json()).items.map((item: { externalId: string }) => item.externalId)).toEqual(['2', '1'])
  expect((await post(app, '/api/queue/nope/move', { to: 0 })).status).toBe(404)
  expect((await post(app, `/api/queue/${b.id}/move`, { to: -1 })).status).toBe(400)
})

test('delete and requeue refuse a building item and 404 unknown ids', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const a = await items.add(newItem, 'end')
  await items.update(a.id, { state: 'building' })
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(409)
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(409)
  await items.update(a.id, { state: 'failed' })
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(200)
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(200)
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(404)
})

test('requeue maps the engine refusals to 404 and 409 and rethrows anything else', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const refusing = (text: string) => new Elysia().use(queueRoutes(items, engine(items, { requeue: async () => { throw new Error(text) } })))
  const busy = await post(refusing('It is queued now'), `/api/queue/${a.id}/requeue`)
  expect(busy.status).toBe(409)
  expect((await busy.json()).error).toBe('It is queued now')
  const gone = await post(refusing(`No queue item ${a.id}`), `/api/queue/${a.id}/requeue`)
  expect(gone.status).toBe(404)
  expect((await gone.json()).error).toBe(`No queue item ${a.id}`)
  expect((await post(refusing('disk full'), `/api/queue/${a.id}/requeue`)).status).toBe(500)
})

test('a request from another site is refused', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue', { headers: { host: 'evil.example' } }))
  expect(response.status).toBe(403)
})
