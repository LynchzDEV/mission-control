import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAttentionStore } from '../server/attention'
import { raiseQueueAlert, sweepQueueAlerts, watchQueueAlerts } from '../server/queue-attention'
import { createQueueStore, type NewQueueItem } from '../server/queue-store'

let dir: string
const task = (externalId: string): NewQueueItem => ({ source: 'clickup-board', externalId, title: `Task ${externalId}`, url: `https://app.clickup.com/t/${externalId}`, repo: '/repo', flowId: null })
const keys = (attention: ReturnType<typeof createAttentionStore>) => attention.list().map(alert => alert.key).sort()

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-attention-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('queue alerts clear when the item moves on', async () => {
  const store = createQueueStore(join(dir, 'queue.json'))
  const attention = createAttentionStore(join(dir, 'attention.json'))
  const moving = await store.update((await store.add(task('a'), 'end')).id, { state: 'ready' })
  const failing = await store.update((await store.add(task('b'), 'end')).id, { state: 'failed' })
  const staying = await store.update((await store.add(task('c'), 'end')).id, { state: 'ready' })
  await raiseQueueAlert(attention, moving, 'Built and ready for review')
  await raiseQueueAlert(attention, staying, 'Built and ready for review')
  expect(attention.list().find(alert => alert.key === `queue:${moving.id}`)).toMatchObject({ kind: 'queue', title: 'Task a', detail: 'Built and ready for review', chatId: null, jobId: null })
  const stop = watchQueueAlerts(store, attention)

  await store.update(moving.id, { state: 'building' })
  expect(keys(attention)).toEqual([`queue:${staying.id}`])

  await raiseQueueAlert(attention, failing, 'Build failed')
  await store.remove(failing.id)
  expect(keys(attention)).toEqual([`queue:${staying.id}`])
  stop()
})

test('a stopped watcher leaves alerts alone', async () => {
  const store = createQueueStore(join(dir, 'queue.json'))
  const attention = createAttentionStore(join(dir, 'attention.json'))
  const item = await store.update((await store.add(task('a'), 'end')).id, { state: 'waiting-info' })
  await raiseQueueAlert(attention, item, 'Has questions')
  watchQueueAlerts(store, attention)()
  await store.update(item.id, { state: 'building' })
  expect(keys(attention)).toEqual([`queue:${item.id}`])
})

test('a sweep clears alerts left from before a restart without waiting for a change', async () => {
  const store = createQueueStore(join(dir, 'queue.json'))
  const attention = createAttentionStore(join(dir, 'attention.json'))
  const moved = await store.add(task('a'), 'end')
  const waiting = await store.update((await store.add(task('b'), 'end')).id, { state: 'ready' })
  await raiseQueueAlert(attention, moved, 'Built and ready for review')
  await raiseQueueAlert(attention, waiting, 'Built and ready for review')
  await attention.raise({ key: 'queue:missing', kind: 'queue', title: 'Gone', detail: 'x', command: null, chatId: null, jobId: null, requestId: null })
  expect(await sweepQueueAlerts(store, attention)).toBe(2)
  expect(keys(attention)).toEqual([`queue:${waiting.id}`])
})
