import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createQueueStore, type NewQueueItem } from '../server/queue-store'

let dir: string
let path: string
const item = (externalId: string): NewQueueItem => ({ source: 'clickup-board', externalId, title: `Task ${externalId}`, url: `https://app.clickup.com/t/${externalId}`, repo: '/repo', flowId: null })

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-')); path = join(dir, 'nested', 'queue.json') })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('a missing file is an empty queue', () => {
  expect(createQueueStore(path).list()).toEqual([])
})

test('added items start queued, keep order, and survive a new instance', async () => {
  const store = createQueueStore(path, () => 1000)
  const a = await store.add(item('a'), 'end')
  await store.add(item('b'), 'end')
  expect(a).toMatchObject({ state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: 1000, updatedAt: 1000 })
  expect(createQueueStore(path).list().map(entry => entry.externalId)).toEqual(['a', 'b'])
})

test('next puts the item first', async () => {
  const store = createQueueStore(path)
  await store.add(item('a'), 'end')
  await store.add(item('b'), 'next')
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'a'])
})

test('update patches fields and bumps updatedAt; unknown ids throw', async () => {
  let now = 1
  const store = createQueueStore(path, () => now)
  const a = await store.add(item('a'), 'end')
  now = 5
  const updated = await store.update(a.id, { state: 'building', currentRunId: 'run-1' })
  expect(updated).toMatchObject({ state: 'building', currentRunId: 'run-1', createdAt: 1, updatedAt: 5 })
  await expect(store.update('nope', { state: 'failed' })).rejects.toThrow('No queue item nope')
})

test('move and toFront reorder; remove deletes', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  const b = await store.add(item('b'), 'end')
  const c = await store.add(item('c'), 'end')
  expect(await store.move(c.id, 0)).toBe(true)
  expect(store.list().map(entry => entry.externalId)).toEqual(['c', 'a', 'b'])
  await store.toFront(b.id)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'c', 'a'])
  expect(await store.move('nope', 0)).toBe(false)
  expect(await store.remove(a.id)).toBe(true)
  expect(await store.remove(a.id)).toBe(false)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'c'])
})

test('move clamps the target index into range', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  await store.add(item('b'), 'end')
  await store.move(a.id, 99)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'a'])
})

test('every change notifies subscribers', async () => {
  const store = createQueueStore(path)
  let calls = 0
  store.subscribe(() => { calls += 1 })
  const a = await store.add(item('a'), 'end')
  await store.update(a.id, { state: 'failed' })
  await store.remove(a.id)
  expect(calls).toBe(3)
})

test('a corrupt file or malformed entries load as empty instead of crashing', async () => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '{not json')
  expect(createQueueStore(path).list()).toEqual([])
  await writeFile(path, JSON.stringify({ items: [{ id: 'x' }] }))
  expect(createQueueStore(path).list()).toEqual([])
})

test('the file is written as { items }', async () => {
  const store = createQueueStore(path)
  await store.add(item('a'), 'end')
  expect(JSON.parse(await readFile(path, 'utf8')).items).toHaveLength(1)
})
