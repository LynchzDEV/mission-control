import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, type QueueEngineDeps, type QueueRunner } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore, type QueueItem } from '../server/queue-store'
import type { WorkflowAttempt } from '../server/workflow-runner'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-engine-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const blockedWith = (evidence: string[]): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 'Need info', evidence }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] })

function harness(over: Partial<QueueEngineDeps> = {}, sourceOver: Partial<QueueSource> = {}) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const started: Array<{ cwd: string; request: string; label: string; workflowId?: string }> = []
  const posted: Array<{ id: string; kind: string; lines: string[] }> = []
  const alerts: Array<{ title: string; reason: string }> = []
  let next = 0
  const runner: QueueRunner = {
    start: async input => { started.push(input); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } },
    get: id => runs.get(id),
  }
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async input => { posted.push(input); return { commentId: 'c1' } },
    replies: async () => ({ replies: [], lastId: null }),
    ...sourceOver,
  }
  const deps: QueueEngineDeps = {
    store, runner,
    source: () => source,
    prepareWorktree: async (repo, label) => ({ worktree: join(repo, '.worktree', label) }),
    writeContext: async (pluginId, context, cwd) => join(cwd, '.mission-control', 'context', pluginId, `${context.name}.md`),
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId, 'files'),
    needsYou: (item, reason) => { alerts.push({ title: item.title, reason }) },
    ...over,
  }
  const settle = (id: string, run: Partial<RunView>) => { const done = { ...runs.get(id)!, ...run }; runs.set(id, done); return done }
  return { engine: createQueueEngine(deps), store, runs, started, posted, alerts, settle }
}

const add = { source: 'clickup-board', externalId: '1', repo: '/repo' }
const states = (items: QueueItem[]) => items.map(item => `${item.externalId}:${item.state}`)

test('adding an item fetches its title and starts building it in its own worktree', async () => {
  const h = harness()
  const item = await h.engine.add({ ...add, flowId: 'wf-1' })
  expect(item.title).toBe('Task 1')
  const built = h.store.get(item.id)!
  expect(built).toMatchObject({ state: 'building', currentRunId: 'run-1', runIds: ['run-1'], worktree: '/repo/.worktree/queue-task-1-1' })
  expect(built.contextPath).toBe('/repo/.worktree/queue-task-1-1/.mission-control/context/clickup-board/item-1.md')
  expect(h.started).toEqual([{ cwd: '/repo/.worktree/queue-task-1-1', request: expect.stringContaining('Work on "Task 1"'), label: 'Task 1', workflowId: 'wf-1' }])
})

test('two adds at once build only the first; the second waits queued', async () => {
  const h = harness()
  await Promise.all([h.engine.add(add), h.engine.add({ ...add, externalId: '2' })])
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
  expect(h.started).toHaveLength(1)
})

test('a passed run makes the item ready, tells you, and starts the next', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:ready', '2:building'])
  expect(h.alerts).toEqual([{ title: 'Task 1', reason: 'Built and ready for review' }])
})

test('a run blocked with questions posts them, parks the item and frees the slot', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['Which page?'])] }))
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.list()[0]).toMatchObject({ state: 'waiting-info', questions: ['Which page?'], lastSeenId: 'c1', currentRunId: null })
  expect(h.store.list()[1]!.state).toBe('building')
})

test('a blocked run without questions, a failed or a stopped run fails the item and tells you', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: 'Visit cap reached', attempts: [] }))
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Visit cap reached' })
  expect(h.alerts).toEqual([{ title: 'Task 1', reason: 'Visit cap reached' }])
})

test('posting the questions failing fails the item with the reason', async () => {
  const h = harness({}, { post: async () => { throw new Error('ClickUp is down') } })
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['Which page?'])] }))
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Could not post the questions: ClickUp is down' })
})

test('a settle for an unknown or already settled run changes nothing', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled({ id: 'other', status: 'done', error: null, attempts: [] })
  const done = h.settle('run-1', { status: 'done' })
  await h.engine.onRunSettled(done)
  await h.engine.onRunSettled(done)
  expect(h.alerts).toHaveLength(1)
})

test('a run that settles before start returns still settles its item', async () => {
  const h = harness()
  const instant: QueueRunner = { start: async () => { h.runs.set('run-x', { id: 'run-x', status: 'failed', error: 'No agent for plan', attempts: [] }); return { id: 'run-x' } }, get: id => h.runs.get(id) }
  const fast = harness({ runner: instant, store: h.store })
  await fast.engine.add(add)
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'No agent for plan' })
})

test('a start error fails that item and moves on to the next', async () => {
  let calls = 0
  const h = harness({ prepareWorktree: async (repo, label) => { calls += 1; if (calls === 1) throw new Error('not a git repo'); return { worktree: join(repo, '.worktree', label) } } })
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  expect(states(h.store.list())).toEqual(['1:failed', '2:building'])
  expect(h.store.list()[0]!.error).toBe('not a git repo')
})

test('requeue puts a failed item back at the end and builds it when free', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const again = await h.engine.requeue(h.store.list()[0]!.id)
  expect(again.state).toBe('building')
  expect(again.error).toBeNull()
  await expect(h.engine.requeue('nope')).rejects.toThrow('No queue item nope')
})

test('recover settles an item whose run finished while MC was down', async () => {
  const h = harness()
  await h.engine.add(add)
  h.settle('run-1', { status: 'done' })
  await h.engine.recover()
  expect(h.store.list()[0]!.state).toBe('ready')
})

test('recover fails an item whose run is gone', async () => {
  const h = harness()
  await h.engine.add(add)
  h.runs.delete('run-1')
  await h.engine.recover()
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Its run is gone' })
})
