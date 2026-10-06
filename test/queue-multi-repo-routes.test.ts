import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import type { AddInput, QueueEngine } from '../server/queue-engine'
import { createQueueStore } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'

type App = { handle(request: Request): Promise<Response> }
const call = (app: App, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
const post = (app: App, path: string, body: unknown) => call(app, path, { method: 'POST', body: JSON.stringify(body) })
const folderOf = (app: App, path: string) => call(app, `/api/queue/folder?path=${encodeURIComponent(path)}`)

let parent: string
const git = (cwd: string, ...args: string[]) => { if (Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).exitCode !== 0) throw new Error(`git ${args[0]} failed`) }
async function repoAt(path: string) {
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  await writeFile(join(path, 'README.md'), 'x')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

beforeAll(async () => {
  parent = await mkdtemp(join(homedir(), 'mc-multirepo-routes-'))
  await repoAt(join(parent, 'api'))
  await repoAt(join(parent, 'backoffice'))
  await mkdir(join(parent, 'empty'))
})
afterAll(async () => { await rm(parent, { recursive: true, force: true }) })

function appWith(added: AddInput[]) {
  const items = createQueueStore(join(mkdtempSync(join(tmpdir(), 'mc-multirepo-routes-store-')), 'queue.json'))
  const engine: Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies' | 'remove' | 'move' | 'checkedAt' | 'subscribeChecks'> = {
    add: async input => { added.push(input); return items.add({ source: input.source, externalId: input.externalId, title: 'T', url: 'u', repo: input.repo, flowId: null, ...(input.repos ? { repos: input.repos } : {}) }, 'end') },
    requeue: async () => { throw new Error('unused') },
    checkReplies: async () => ({ checked: 0, resumed: 0 }),
    remove: async () => {},
    move: async () => {},
    checkedAt: () => null,
    subscribeChecks: () => () => {},
  }
  return new Elysia().use(queueRoutes(items, engine))
}

test('the folder check says a repo is a repo and lists nothing', async () => {
  const response = await folderOf(appWith([]), join(parent, 'api'))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ path: join(parent, 'api'), isRepo: true, repos: [] })
})

test('the folder check lists the repos inside a parent folder', async () => {
  expect(await (await folderOf(appWith([]), parent)).json()).toEqual({ path: parent, isRepo: false, repos: ['api', 'backoffice'] })
  expect(await (await folderOf(appWith([]), join(parent, 'empty'))).json()).toEqual({ path: join(parent, 'empty'), isRepo: false, repos: [] })
})

test('the folder check refuses a missing path, a path outside home and no path', async () => {
  const app = appWith([])
  for (const [path, error] of [[join(parent, 'nope'), 'cwd does not exist'], [tmpdir(), 'cwd must be under $HOME']] as const) {
    const refused = await folderOf(app, path)
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toBe(error)
  }
  const blank = await call(app, '/api/queue/folder')
  expect(blank.status).toBe(400)
  expect((await blank.json()).error).toBe('path is required')
})

test('POST with repos hands the engine the folder and the sorted repo names', async () => {
  const added: AddInput[] = []
  const response = await post(appWith(added), '/api/queue', { source: 'clickup-board', externalId: '9', repo: parent, repos: ['backoffice', 'api'] })
  expect(response.status).toBe(200)
  expect(added).toEqual([{ source: 'clickup-board', externalId: '9', repo: parent, repos: ['api', 'backoffice'] }])
  expect((await response.json()).item.repos).toEqual(['api', 'backoffice'])
})

test('POST without repos keeps the single-repo shape and the single-repo errors', async () => {
  const added: AddInput[] = []
  const app = appWith(added)
  expect((await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo: join(parent, 'api') })).status).toBe(200)
  expect(added).toEqual([{ source: 'clickup-board', externalId: '1', repo: join(parent, 'api') }])
  const refused = await post(app, '/api/queue', { source: 'clickup-board', externalId: '2', repo: parent })
  expect((await refused.json()).error).toBe('cwd is not a git repository')
})

test('POST refuses bad repo lists before the engine sees them', async () => {
  const added: AddInput[] = []
  const app = appWith(added)
  const cases: Array<[unknown, string]> = [
    [[], 'Tick at least one repo this ticket touches'],
    [['../x'], 'Not a repo name: ../x'],
    [['api', 'api'], 'api is ticked twice'],
    [['web'], 'web is not a repo in this folder'],
    [Array.from({ length: 9 }, (_, index) => `r${index}`), 'Pick at most 8 repos for one item'],
  ]
  for (const [repos, error] of cases) {
    const refused = await post(app, '/api/queue', { source: 'clickup-board', externalId: '3', repo: parent, repos })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toBe(error)
  }
  expect((await post(app, '/api/queue', { source: 'clickup-board', externalId: '3', repo: parent, repos: 'api' })).status).toBe(400)
  expect(added).toEqual([])
})
