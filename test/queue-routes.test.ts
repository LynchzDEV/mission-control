import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import type { QueueEngine } from '../server/queue-engine'
import { createQueueStore } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'

const store = () => createQueueStore(join(mkdtempSync(join(tmpdir(), 'mc-queue-routes-')), 'queue.json'))
const call = (app: Elysia, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
const post = (app: Elysia, path: string, body: unknown = {}) => call(app, path, { method: 'POST', body: JSON.stringify(body) })
const newItem = { source: 'clickup-board', externalId: '1', title: 'Task 1', url: 'u', repo: '/repo', flowId: null }

function engine(items: ReturnType<typeof store>, over: Partial<QueueEngine> = {}): Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies'> {
  return {
    add: async input => items.add({ ...newItem, externalId: input.externalId, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end'),
    requeue: async id => items.update(id, { state: 'queued' }),
    checkReplies: async () => ({ checked: 2, resumed: 1 }),
    ...over,
  }
}

test('GET lists items; POST adds through the engine', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const added = await post(app, '/api/queue', { source: 'clickup-board', externalId: '7', repo: '/repo', position: 'next' })
  expect(added.status).toBe(200)
  expect((await added.json()).item.externalId).toBe('7')
  expect((await (await call(app, '/api/queue')).json()).items).toHaveLength(1)
})

test('POST rejects a bad body and reports a source failure as 502', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new Error('clickup-board is not installed') } })))
  expect((await post(app, '/api/queue', { source: '', externalId: '1', repo: '/repo' })).status).toBe(400)
  expect((await post(app, '/api/queue', { source: 'x', externalId: '1', repo: '/repo', position: 'top' })).status).toBe(400)
  const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo: '/repo' })
  expect(failed.status).toBe(502)
  expect((await failed.json()).error).toBe('clickup-board is not installed')
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
