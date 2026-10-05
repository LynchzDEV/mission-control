import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeContextFile } from '../server/plugins/context-files'
import { createQueueEngine, type QueueEngineDeps } from '../server/queue-engine'
import { writeQueueContext } from '../server/queue-files'
import { add, parkedItem, queueHarness, reply } from './support/queue-harness'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-restore-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const harness = (over: Partial<QueueEngineDeps> = {}) => queueHarness(dir, over)

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

test('a reply for an item whose worktree was deleted by hand prepares the worktree again before the run', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  await rm(parked.worktree!, { recursive: true, force: true })
  h.answer(async () => reply('r1', 'The login page'))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  const resumed = h.store.get(parked.id)!
  expect(h.started.slice(1).every(start => existsSync(join(start.cwd, '.git')))).toBe(true)
  expect(resumed).toMatchObject({ state: 'building', worktree: parked.worktree })
  expect(existsSync(resumed.contextPath!)).toBe(true)
  expect(h.started[1]!.request).toContain(resumed.contextPath!)
})

test('requeue of an item whose worktree was deleted by hand prepares it again and rewrites its context', async () => {
  const h = harness()
  const item = await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  await rm(h.store.get(item.id)!.worktree!, { recursive: true, force: true })
  await h.engine.requeue(item.id)
  const rebuilt = h.store.get(item.id)!
  expect(existsSync(join(h.started[1]!.cwd, '.git'))).toBe(true)
  expect(await readFile(rebuilt.contextPath!, 'utf8')).toBe('# 1')
  expect(h.started[1]!.request).toContain(rebuilt.contextPath!)
})

test('requeue fails the item with a clear reason when its deleted worktree cannot be restored', async () => {
  let prepared = 0
  const h = harness()
  h.deps.prepareWorktree = async (repo, label) => { prepared += 1; if (prepared > 1) throw new Error('branch is gone'); const worktree = join(dir, repo.replace(/\W/g, '_'), '.worktree', label); await mkdir(worktree, { recursive: true }); await writeFile(join(worktree, '.git'), 'gitdir: elsewhere'); return { worktree } }
  const engine = createQueueEngine(h.deps)
  const item = await engine.add(add)
  await engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  await rm(h.store.get(item.id)!.worktree!, { recursive: true, force: true })
  await engine.requeue(item.id)
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'Its worktree is gone and could not be restored: branch is gone' })
  expect(h.started).toHaveLength(1)
})

test('a reply fails the item with a clear reason when its deleted worktree cannot be restored', async () => {
  const h = harness()
  const parked = await parkedItem(h)
  h.deps.prepareWorktree = async () => { throw new Error('branch is gone') }
  const engine = createQueueEngine(h.deps)
  await rm(parked.worktree!, { recursive: true, force: true })
  h.answer(async () => reply('r1', 'The login page'))
  expect(await engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(parked.id)).toMatchObject({ state: 'failed', error: 'Its worktree is gone and could not be restored: branch is gone', lastSeenId: 'c1' })
  expect(existsSync(parked.worktree!)).toBe(false)
  expect(h.started).toHaveLength(1)
})
