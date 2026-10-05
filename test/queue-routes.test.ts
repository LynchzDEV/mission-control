import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { createQueueEngine, QueueRefusal, SourceFailure, type QueueEngine } from '../server/queue-engine'
import { createQueueStore } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'

const store = () => createQueueStore(join(mkdtempSync(join(tmpdir(), 'mc-queue-routes-')), 'queue.json'))
type App = { handle(request: Request): Promise<Response> }
const call = (app: App, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
const post = (app: App, path: string, body: unknown = {}) => call(app, path, { method: 'POST', body: JSON.stringify(body) })
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

type Engine = Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies' | 'remove' | 'move' | 'checkedAt' | 'subscribeChecks'>

function engine(items: ReturnType<typeof store>, over: Partial<QueueEngine> = {}): Engine {
  const found = (id: string) => { const item = items.get(id); if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404); return item }
  return {
    add: async input => items.add({ ...newItem, externalId: input.externalId, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end'),
    requeue: async id => items.update(id, { state: 'queued' }),
    checkReplies: async () => ({ checked: 2, resumed: 1 }),
    remove: async id => { if (found(id).state === 'building') throw new QueueRefusal('It is building now', 409); await items.remove(id) },
    move: async (id, to) => { found(id); await items.move(id, to) },
    checkedAt: () => null,
    subscribeChecks: () => () => {},
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
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new SourceFailure('clickup-board is not installed') } })))
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
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new QueueRefusal('Already in the queue', 409) } })))
  const twice = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect(twice.status).toBe(409)
  expect((await twice.json()).error).toBe('Already in the queue')
})

test('delete and move go through the engine so they wait for a build in progress', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const seen: string[] = []
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    remove: async id => { seen.push(`remove ${id}`); throw new QueueRefusal('It is building now', 409) },
    move: async (id, to) => { seen.push(`move ${id} ${to}`) },
  })))
  const removing = await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })
  expect(removing.status).toBe(409)
  expect((await removing.json()).error).toBe('Stop its run in Studio first')
  expect((await post(app, `/api/queue/${a.id}/move`, { to: 3 })).status).toBe(200)
  expect(seen).toEqual([`remove ${a.id}`, `move ${a.id} 3`])
  expect(items.get(a.id)!.state).toBe('queued')
})

test('move refuses an item that is not queued with 409 and says why', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const app = new Elysia().use(queueRoutes(items, engine(items, { move: async () => { throw new QueueRefusal('It is building now', 409) } })))
  const refused = await post(app, `/api/queue/${a.id}/move`, { to: 0 })
  expect(refused.status).toBe(409)
  expect((await refused.json()).error).toBe('It is building now')
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
  const refusing = (error: Error) => new Elysia().use(queueRoutes(items, engine(items, { requeue: async () => { throw error } })))
  const busy = await post(refusing(new QueueRefusal('It is queued now', 409)), `/api/queue/${a.id}/requeue`)
  expect(busy.status).toBe(409)
  expect((await busy.json()).error).toBe('It is queued now')
  const gone = await post(refusing(new QueueRefusal(`No queue item ${a.id}`, 404)), `/api/queue/${a.id}/requeue`)
  expect(gone.status).toBe(404)
  expect((await gone.json()).error).toBe(`No queue item ${a.id}`)
  expect((await post(refusing(new Error('disk full')), `/api/queue/${a.id}/requeue`)).status).toBe(500)
  expect((await post(refusing(new Error(`No queue item ${a.id}`)), `/api/queue/${a.id}/requeue`)).status).toBe(500)
  expect((await post(refusing(new Error('It is broken')), `/api/queue/${a.id}/requeue`)).status).toBe(500)
})

test('a request from another site is refused', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue', { headers: { host: 'evil.example' } }))
  expect(response.status).toBe(403)
})

test('GET tree returns what the tree source builds', async () => {
  const items = store()
  const tree = { repos: [{ repo: '/repo', base: { branch: 'main', commits: [{ sha: 'abc1234', subject: 'Base' }] }, lanes: [] }] }
  const app = new Elysia().use(queueRoutes(items, engine(items), async () => tree))
  const response = await call(app, '/api/queue/tree')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(tree)
})

test('POST reports a source error that reads like a refusal as 502', async () => {
  const items = store()
  for (const text of ['It is broken', 'No queue item here', 'Already in the queue']) {
    const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new SourceFailure(text) } })))
    const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
    expect(failed.status).toBe(502)
    expect((await failed.json()).error).toBe(text)
  }
})

test('move and delete map only engine refusals to 404 and 409', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const app = (error: Error) => new Elysia().use(queueRoutes(items, engine(items, { move: async () => { throw error }, remove: async () => { throw error } })))
  const gone = await post(app(new QueueRefusal(`No queue item ${a.id}`, 404)), `/api/queue/${a.id}/move`, { to: 0 })
  expect(gone.status).toBe(404)
  expect((await gone.json()).error).toBe('No such queue item')
  expect((await post(app(new Error('It is broken')), `/api/queue/${a.id}/move`, { to: 0 })).status).toBe(500)
  expect((await call(app(new Error('It is building now')), `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(500)
  expect((await call(app(new QueueRefusal(`No queue item ${a.id}`, 404)), `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(404)
})

test('GET says when replies were last checked, or null before the first check', async () => {
  const items = store()
  let checkedAt: number | null = null
  const app = new Elysia().use(queueRoutes(items, engine(items, { checkedAt: () => checkedAt })))
  expect(await (await call(app, '/api/queue')).json()).toEqual({ items: [], checkedAt: null })
  checkedAt = 1_700_000_000_000
  expect(await (await call(app, '/api/queue')).json()).toEqual({ items: [], checkedAt: 1_700_000_000_000 })
})

test('the stream sends checkedAt and sends again when a check finishes with no item changes', async () => {
  const items = store()
  let checkedAt: number | null = null
  const listeners = new Set<() => void>()
  const app = new Elysia().use(queueRoutes(items, engine(items, {
    checkedAt: () => checkedAt,
    subscribeChecks: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })))
  const aborting = new AbortController()
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue/stream', { headers: { host: '127.0.0.1:7777' }, signal: aborting.signal }))
  const reader = response.body!.getReader()
  const nextData = async (): Promise<unknown> => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, '').trim())
  expect(await nextData()).toEqual({ items: [], checkedAt: null })
  checkedAt = 42
  for (const listener of listeners) listener()
  expect(await nextData()).toEqual({ items: [], checkedAt: 42 })
  aborting.abort()
  await reader.cancel()
  expect(listeners.size).toBe(0)
})

test('POST maps an unexpected local failure to 500, not a source error', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new Error('disk full') } })))
  const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect(failed.status).toBe(500)
})

function realEngine(items: ReturnType<typeof store>) {
  const runs = new Map<string, { id: string; status: 'running' | 'done'; error: null; attempts: [] }>()
  let next = 0
  return createQueueEngine({
    store: items,
    runner: { start: async () => { const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id) },
    source: () => ({ item: async ({ id }) => ({ title: `Task ${id}`, url: 'u', contextMarkdown: '# t' }), post: async () => ({ commentId: 'c1' }), replies: async () => ({ replies: [], lastId: null }) }),
    prepareWorktree: async (_repo, label) => ({ worktree: join(repo, '.worktree', label) }),
    writeContext: async (_pluginId, context, cwd) => join(cwd, `${context.name}.md`),
    pluginFiles: () => repo,
    needsYou: () => {},
  })
}

test('with the real engine: add builds, a queued item cannot be requeued, and a queued item can be removed', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, realEngine(items)))
  const first = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo })
  expect((await first.json()).item).toMatchObject({ state: 'building', title: 'Task 1' })
  const second = (await (await post(app, '/api/queue', { source: 'clickup-board', externalId: '2', repo })).json()).item
  expect(second.state).toBe('queued')
  const twice = await post(app, '/api/queue', { source: 'clickup-board', externalId: '2', repo })
  expect(twice.status).toBe(409)
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const requeued = await post(app, `/api/queue/${second.id}/requeue`)
    expect(requeued.status).toBe(409)
    expect((await requeued.json()).error).toBe('It is queued now')
    expect((await call(app, `/api/queue/${items.list()[0]!.id}`, { method: 'DELETE' })).status).toBe(409)
  } finally { quiet.mockRestore() }
  expect((await call(app, `/api/queue/${second.id}`, { method: 'DELETE' })).status).toBe(200)
  expect(items.list().map(item => item.externalId)).toEqual(['1'])
  expect(await (await post(app, '/api/queue/check')).json()).toEqual({ checked: 0, resumed: 0 })
})

test('move refuses a position that is not a whole number', async () => {
  const items = store()
  const a = await items.add(newItem, 'end')
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  for (const to of [1.5, '1', null]) expect((await post(app, `/api/queue/${a.id}/move`, { to })).status).toBe(400)
})
