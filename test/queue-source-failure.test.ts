import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, SourceFailure, type QueueEngineDeps } from '../server/queue-engine'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore, type QueueStore } from '../server/queue-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-source-failure-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const goodSource: QueueSource = { item: async () => ({ title: 't', url: 'u', contextMarkdown: '' }), post: async () => ({ commentId: 'c' }), replies: async () => ({ replies: [], lastId: null }) }

function engineWith(over: Partial<QueueEngineDeps>) {
  const deps: QueueEngineDeps = {
    store: createQueueStore(join(dir, 'queue.json')),
    runner: { start: async () => ({ id: 'run-1' }), get: () => undefined },
    source: () => goodSource,
    prepareWorktree: async () => ({ worktree: dir }),
    writeContext: async () => join(dir, 'context.md'),
    pluginFiles: () => dir,
    needsYou: () => {},
    ...over,
  }
  return createQueueEngine(deps)
}

const input = { source: 'clickup-board', externalId: '1', repo: '/repo' }

test('a source that cannot be reached fails the add as a SourceFailure with its message', async () => {
  const engine = engineWith({ source: () => ({ ...goodSource, item: async () => { throw new Error('ClickUp is down') } }) })
  const adding = engine.add(input)
  await expect(adding).rejects.toBeInstanceOf(SourceFailure)
  await expect(engine.add(input)).rejects.toThrow('ClickUp is down')
})

test('a source that is not installed fails the add as a SourceFailure', async () => {
  const engine = engineWith({ source: () => { throw new Error('clickup-board is not installed') } })
  await expect(engine.add(input)).rejects.toBeInstanceOf(SourceFailure)
})

test('a local store failure during add is not a SourceFailure', async () => {
  const real = createQueueStore(join(dir, 'queue.json'))
  const store: QueueStore = { ...real, add: async () => { throw new Error('disk full') } }
  const adding = engineWith({ store }).add(input)
  await expect(adding).rejects.toThrow('disk full')
  await expect(adding).rejects.not.toBeInstanceOf(SourceFailure)
})
