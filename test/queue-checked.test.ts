import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, type QueueEngineDeps } from '../server/queue-engine'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-checked-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function engineAt(clock: { now: number }) {
  const source: QueueSource = { item: async () => ({ title: 't', url: 'u', contextMarkdown: '' }), post: async () => ({ commentId: 'c' }), replies: async () => ({ replies: [], lastId: null }) }
  const deps: QueueEngineDeps = {
    store: createQueueStore(join(dir, 'queue.json')),
    runner: { start: async () => ({ id: 'run-1' }), get: () => undefined },
    source: () => source,
    prepareWorktree: async () => ({ worktree: dir }),
    writeContext: async () => join(dir, 'context.md'),
    pluginFiles: () => dir,
    needsYou: () => {},
    now: () => clock.now,
  }
  return createQueueEngine(deps)
}

test('the engine has not checked replies until a check completes', () => {
  expect(engineAt({ now: 5 }).checkedAt()).toBeNull()
})

test('each completed check records when it finished and tells listeners', async () => {
  const clock = { now: 1_000 }
  const engine = engineAt(clock)
  let told = 0
  const stop = engine.subscribeChecks(() => { told += 1 })
  await engine.checkReplies()
  expect(engine.checkedAt()).toBe(1_000)
  clock.now = 2_500
  await engine.checkReplies()
  expect(engine.checkedAt()).toBe(2_500)
  expect(told).toBe(2)
  stop()
  await engine.checkReplies()
  expect(told).toBe(2)
})
