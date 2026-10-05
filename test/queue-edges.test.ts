import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeContextFile } from '../server/plugins/context-files'
import { createQueueEngine, QueueRefusal, type QueueEngineDeps, type QueueRunner } from '../server/queue-engine'
import { writeQueueContext } from '../server/queue-files'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource, SourceReplies } from '../server/queue-source'
import { createQueueStore, type QueueItem } from '../server/queue-store'
import type { WorkflowAttempt } from '../server/workflow-runner'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-edges-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const blockedWith = (evidence: string[], over: Partial<WorkflowAttempt> = {}): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 'Need info', evidence }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [], ...over })
const reply = (id: string, text: string): SourceReplies => ({ replies: [{ id, author: 'Ploy', text, images: [] }], lastId: id })
const noReplies: SourceReplies = { replies: [], lastId: null }

type Started = { cwd: string; request: string; label: string; workflowId?: string }

function harness(over: Partial<QueueEngineDeps> = {}, sourceOver: Partial<QueueSource> = {}) {
  const queueFile = join(dir, 'queue.json')
  const store = createQueueStore(queueFile)
  const runs = new Map<string, RunView>()
  const started: Started[] = []
  const posted: Array<{ id: string; kind: string; lines: string[] }> = []
  const alerts: Array<{ title: string; reason: string; state: string }> = []
  const sinceIds: Array<string | null> = []
  let replies: () => Promise<SourceReplies> = async () => noReplies
  let next = 0
  const runner: QueueRunner = {
    start: async input => { started.push(input); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } },
    get: id => runs.get(id),
  }
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async input => { posted.push(input); return { commentId: 'c1' } },
    replies: async ({ sinceId }) => { sinceIds.push(sinceId); return replies() },
    ...sourceOver,
  }
  const deps: QueueEngineDeps = {
    store, runner,
    source: () => source,
    prepareWorktree: async (repo, label) => {
      const worktree = join(dir, repo.replace(/\W/g, '_'), '.worktree', label)
      await mkdir(worktree, { recursive: true })
      await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
      return { worktree }
    },
    writeContext: async (pluginId, context, cwd) => { const folder = join(cwd, '.mission-control', 'queue', pluginId); await mkdir(folder, { recursive: true }); const path = join(folder, `${context.name}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId, 'files'),
    needsYou: (item, reason) => { alerts.push({ title: item.title, reason, state: item.state }) },
    ...over,
  }
  const settle = (id: string, run: Partial<RunView>) => { const done = { ...runs.get(id)!, ...run }; runs.set(id, done); return done }
  const restart = (runnerOver: Partial<QueueRunner> = {}) => {
    const reloaded = createQueueStore(queueFile)
    return { store: reloaded, engine: createQueueEngine({ ...deps, store: reloaded, runner: { ...runner, ...runnerOver } }) }
  }
  return {
    engine: createQueueEngine(deps), store, runs, started, posted, alerts, sinceIds, settle, restart, deps,
    answer: (next: () => Promise<SourceReplies>) => { replies = next },
  }
}

const add = { source: 'clickup-board', externalId: '1', repo: '/repo' }
const states = (items: QueueItem[]) => items.map(item => `${item.externalId}:${item.state}`)

async function refusal(work: Promise<unknown>): Promise<unknown> {
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    return await work.then(() => null, (error: unknown) => error)
  } finally { quiet.mockRestore() }
}

async function parkedItem(h: ReturnType<typeof harness>) {
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['Which page?'])] }))
  return h.store.get(item.id)!
}

test('requeue refuses an item that is already queued and leaves it in line', async () => {
  const h = harness()
  await h.engine.add(add)
  const second = await h.engine.add({ ...add, externalId: '2' })
  const refused = await refusal(h.engine.requeue(second.id))
  expect(refused).toBeInstanceOf(QueueRefusal)
  expect(refused).toMatchObject({ status: 409, message: 'It is queued now' })
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
})

test('remove deletes a queued, a waiting and a ready item', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const built = await h.engine.add({ ...add, externalId: '2' })
  const queued = await h.engine.add({ ...add, externalId: '3' })
  await h.engine.onRunSettled(h.settle('run-2', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:waiting-info', '2:ready', '3:building'])
  await h.engine.add({ ...add, externalId: '4' })
  for (const id of [parked.id, built.id]) await h.engine.remove(id)
  expect(states(h.store.list())).toEqual(['3:building', '4:queued'])
  await h.engine.remove(h.store.list()[1]!.id)
  expect(h.store.list().map(item => item.id)).toEqual([queued.id])
})

test('a removed item can be added again', async () => {
  const h = harness()
  const first = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  await h.engine.remove(first.id)
  const again = await h.engine.add(add)
  expect(again.id).not.toBe(first.id)
  expect(h.store.list()).toMatchObject([{ id: again.id, state: 'building', runIds: ['run-2'] }])
})

test('a queued item removed while another build is starting is never built', async () => {
  const h = harness()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const inStart = new Promise<void>(resolve => { entered = resolve })
  const held: QueueRunner = { start: async input => { h.started.push(input); entered(); await gate; h.runs.set('run-held', { id: 'run-held', status: 'running', error: null, attempts: [] }); return { id: 'run-held' } }, get: id => h.runs.get(id) }
  const engine = harness({ runner: held, store: h.store }).engine
  const adding = engine.add(add)
  await inStart
  const waiting = await h.store.add({ source: 'clickup-board', externalId: '2', title: 'Task 2', url: 'u', repo: '/repo', flowId: null }, 'end')
  const removing = engine.remove(waiting.id)
  release()
  await Promise.all([adding, removing])
  expect(states(h.store.list())).toEqual(['1:building'])
  h.runs.set('run-held', { id: 'run-held', status: 'done', error: null, attempts: [] })
  await engine.onRunSettled(h.runs.get('run-held')!)
  expect(states(h.store.list())).toEqual(['1:ready'])
  expect(h.started).toHaveLength(1)
})

test('items for two different repos still share the one build slot', async () => {
  const h = harness()
  await h.engine.add({ ...add, repo: '/repo-a' })
  await h.engine.add({ ...add, externalId: '2', repo: '/repo-b' })
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:ready', '2:building'])
  expect(h.started.map(start => start.cwd)).toEqual([expect.stringContaining('_repo_a'), expect.stringContaining('_repo_b')])
})

test('an empty queue checks, recovers and kicks without starting anything', async () => {
  const h = harness({ now: () => 77 })
  expect(await h.engine.checkReplies()).toEqual({ checked: 0, resumed: 0 })
  expect(h.engine.checkedAt()).toBe(77)
  await h.engine.recover()
  await h.engine.kick()
  expect(h.started).toEqual([])
  expect(h.sinceIds).toEqual([])
})

test('an interrupted run fails the item instead of asking its leftover evidence', async () => {
  const h = harness()
  await h.engine.add(add)
  const interrupted = blockedWith(['half a question'], { interrupted: true })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: 'Interrupted transition or acceptance check', attempts: [interrupted] }))
  expect(h.posted).toEqual([])
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Interrupted transition or acceptance check' })
})

test('a stopped run whose last step asked questions still fails rather than asks', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'stopped', error: null, attempts: [blockedWith(['Which page?'])] }))
  expect(h.posted).toEqual([])
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Run stopped' })
})

test('a source turned off between add and build fails the queued item and moves on', async () => {
  let off = false
  const h = harness({}, { item: async ({ id }) => { if (off && id === '2') throw new Error('clickup-board is turned off'); return { title: `Task ${id}`, url: 'u', contextMarkdown: '# t' } } })
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.add({ ...add, externalId: '3' })
  off = true
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:ready', '2:failed', '3:building'])
  expect(h.store.list()[1]!.error).toBe('clickup-board is turned off')
  expect(h.alerts.map(alert => alert.reason)).toEqual(['Built and ready for review', 'clickup-board is turned off'])
})

test('a Studio retry of a waiting item\'s run that passes makes it ready and tells you', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const blocked = h.runs.get('run-1')!
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done', attempts: [...blocked.attempts, blockedWith([], { number: 2, endedAt: 3 })] }))
  expect(h.store.get(parked.id)).toMatchObject({ state: 'ready', currentRunId: null, error: null })
  expect(h.alerts.at(-1)).toEqual({ title: 'Task 1', reason: 'Built and ready for review', state: 'ready' })
})

test('a Studio retry that makes a waiting item ready clears its questions', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const blocked = h.runs.get('run-1')!
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done', attempts: [...blocked.attempts, blockedWith([], { number: 2, endedAt: 3 })] }))
  expect(h.store.get(parked.id)).toMatchObject({ state: 'ready', questions: [] })
})

test('a Studio retry of a waiting item\'s run that fails fails it and stops reading its replies', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  const blocked = h.runs.get('run-1')!
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom', attempts: [...blocked.attempts, blockedWith([], { number: 2, endedAt: 3 })] }))
  expect(h.store.get(parked.id)).toMatchObject({ state: 'failed', error: 'boom', questions: [] })
  expect(await h.engine.checkReplies()).toEqual({ checked: 0, resumed: 0 })
})

test('two reply checks at once resume the item once', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', 'The login page'))
  const [first, second] = await Promise.all([h.engine.checkReplies(), h.engine.checkReplies()])
  expect(first.resumed + second.resumed).toBe(1)
  expect(h.store.get(parked.id)).toMatchObject({ state: 'building', runIds: ['run-1', 'run-2'], lastSeenId: 'r1' })
  expect(h.store.get(parked.id)!.answerPaths).toHaveLength(1)
  expect(h.started).toHaveLength(2)
})

test('a reply read for an item removed meanwhile is dropped', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { entered = resolve })
  h.answer(async () => { entered(); await gate; return reply('r1', 'The login page') })
  const checking = h.engine.checkReplies()
  await reading
  await h.engine.remove(parked.id)
  release()
  expect(await checking).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.list()).toEqual([])
  expect(h.started).toHaveLength(1)
})

test('a reply with empty text still counts as an answer', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', ''))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  expect(await readFile(h.store.get(parked.id)!.answerPaths[0]!, 'utf8')).toContain('### Ploy\n\n')
})

test('a reply image given as an absolute path outside the plugin folder is skipped', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  await writeFile(join(dir, 'secret'), 'do not copy')
  h.answer(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'shot.png', path: join(dir, 'secret') }] }], lastId: 'r1' }))
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
    expect(errors).toHaveBeenCalledTimes(1)
  } finally { errors.mockRestore() }
  const worktree = h.store.get(parked.id)!.worktree!
  expect(existsSync(join(worktree, '.mission-control', 'queue', 'clickup-board', 'r1-0-shot.png'))).toBe(false)
})

test('a malformed-reply failure from the source keeps the item waiting with its cursor', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => { throw new Error('clickup-board returned an unexpected source.replies result') })
  for (let i = 0; i < 4; i += 1) expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(parked.id)).toMatchObject({ state: 'waiting-info', lastSeenId: 'c1', answerPaths: [] })
  expect(h.alerts.filter(alert => alert.reason.startsWith('Could not read replies'))).toEqual([{ title: 'Task 1', reason: 'Could not read replies: clickup-board returned an unexpected source.replies result', state: 'waiting-info' }])
})

test('replies without a cursor count as a failed read and are never applied', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: null }))
  for (let i = 0; i < 3; i += 1) expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(parked.id)).toMatchObject({ state: 'waiting-info', lastSeenId: 'c1', answerPaths: [] })
  expect(h.started).toHaveLength(1)
  expect(h.alerts.filter(alert => alert.reason.startsWith('Could not read replies'))).toEqual([{ title: 'Task 1', reason: 'Could not read replies: clickup-board returned replies without a lastId', state: 'waiting-info' }])
})

test.todo('BUG: a reply for an item whose worktree was deleted by hand starts a run in a recreated folder that is not a worktree', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  await rm(parked.worktree!, { recursive: true, force: true })
  h.answer(async () => reply('r1', 'The login page'))
  await h.engine.checkReplies()
  expect(h.started.slice(1).every(start => existsSync(join(start.cwd, '.git')))).toBe(true)
})

test.todo('BUG: requeue of an item whose worktree was deleted by hand starts its run on the missing path', async () => {
  const h = harness()
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  await rm(h.store.get(item.id)!.worktree!, { recursive: true, force: true })
  await h.engine.requeue(item.id)
  expect(existsSync(h.started[1]!.cwd)).toBe(true)
})

test('two items with the same title and id from different sources get their own worktrees', async () => {
  const h = harness()
  const first = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  const second = await h.engine.add({ ...add, source: 'other-board' })
  expect(h.store.get(second.id)!.worktree).not.toBe(h.store.get(first.id)!.worktree)
})

test('a context sweep 30 days after the first build leaves the files the next run is told to read', async () => {
  const h = harness({ writeContext: (pluginId, context, cwd) => writeQueueContext(pluginId, context, cwd) })
  const parked = await parkedItem(h)
  await writeContextFile('clickup-board', { name: 'session', markdown: '# s' }, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000), parked.worktree!)
  h.answer(async () => reply('r1', 'The login page'))
  await h.engine.checkReplies()
  const resumed = h.store.get(parked.id)!
  expect(h.started[1]!.request).toContain(parked.contextPath!)
  expect(existsSync(parked.contextPath!)).toBe(true)
  expect(existsSync(resumed.answerPaths[0]!)).toBe(true)
})

test('restart: a queued item is built by recover', async () => {
  const h = harness()
  await h.store.add({ source: 'clickup-board', externalId: '1', title: 'Task 1', url: 'u', repo: '/repo', flowId: null }, 'end')
  const after = h.restart()
  await after.engine.recover()
  expect(states(after.store.list())).toEqual(['1:building'])
  expect(h.started).toHaveLength(1)
})

test('restart: a building item whose run asked questions while MC was down posts them and parks', async () => {
  const h = harness()
  await h.engine.add(add)
  h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['Which page?'])] })
  const after = h.restart()
  await after.engine.recover()
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['Which page?'] }])
  expect(after.store.list()[0]).toMatchObject({ state: 'waiting-info', questions: ['Which page?'], lastSeenId: 'c1' })
})

test('restart: a building item whose run was stopped while MC was down fails', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  h.settle('run-1', { status: 'stopped', error: null })
  const after = h.restart()
  await after.engine.recover()
  expect(states(after.store.list())).toEqual(['1:failed', '2:building'])
})

test('restart: a waiting item reads replies from its saved cursor and resumes', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.answer(async () => reply('r1', 'The login page'))
  const after = h.restart()
  await after.engine.recover()
  expect(await after.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  expect(h.sinceIds).toEqual(['c1'])
  expect(after.store.get(parked.id)).toMatchObject({ state: 'building', lastSeenId: 'r1', runIds: ['run-1', 'run-2'] })
})

test('restart: ready and failed items are left as they are', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  await h.engine.onRunSettled(h.settle('run-2', { status: 'failed', error: 'boom' }))
  const alerts = h.alerts.length
  const after = h.restart()
  await after.engine.recover()
  expect(after.store.list().map(item => [item.state, item.error])).toEqual([['ready', null], ['failed', 'boom']])
  expect(h.started).toHaveLength(2)
  expect(h.alerts).toHaveLength(alerts)
})

test('restart: a Studio retry of a failed item that settles after the restart still updates it', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const after = h.restart()
  await after.engine.recover()
  await after.engine.onRunSettled(h.settle('run-1', { status: 'done', error: null, attempts: [blockedWith([], { endedAt: 9 })] }))
  expect(after.store.list()[0]).toMatchObject({ state: 'ready', error: null })
})
