import { Elysia } from 'elysia'
import { z } from 'zod'

import { requireLocal } from '../auth'
import type { QueueEngine } from '../queue-engine'
import type { QueueStore } from '../queue-store'
import { eventStreamResponse } from '../run-events'
import { validateWorkspaceCwd } from '../workspace'

type Status = { status?: number | string }
type QueueEngineRoutes = Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies' | 'remove' | 'move'>

const addSchema = z.object({
  source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  externalId: z.string().min(1).max(200),
  repo: z.string().min(1).max(2048),
  flowId: z.string().min(1).max(200).nullable().optional(),
  position: z.enum(['end', 'next']).optional(),
})
const moveSchema = z.object({ to: z.number().int().min(0) })
const NO_ITEM = 'No such queue item'
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function refusalStatus(error: unknown): number | undefined {
  const text = message(error)
  if (text.startsWith('No queue item')) return 404
  if (text.startsWith('It is ') || text === 'Already in the queue') return 409
  return undefined
}

async function refusing<T>(set: Status, work: () => Promise<T>, explain: (error: unknown) => string = message): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (error) {
    const status = refusalStatus(error)
    if (status === undefined) throw error
    set.status = status
    return { error: explain(error) }
  }
}

async function requeueItem(store: QueueStore, engine: QueueEngineRoutes, id: string, set: Status) {
  const item = store.get(id)
  if (item === undefined) { set.status = 404; return { error: NO_ITEM } }
  if (item.state === 'building') { set.status = 409; return { error: 'It is building now' } }
  return refusing(set, async () => ({ item: await engine.requeue(id) }))
}

async function addItem(engine: QueueEngineRoutes, body: unknown, set: Status) {
  const parsed = addSchema.safeParse(body)
  if (!parsed.success) { set.status = 400; return { error: 'source, externalId and repo are required; position is end or next' } }
  const repo = await validateWorkspaceCwd(parsed.data.repo, undefined, { requireGit: true })
  if (!repo.ok) { set.status = 400; return { error: repo.error } }
  try {
    return await refusing(set, async () => ({ item: await engine.add({ ...parsed.data, repo: repo.path }) }))
  } catch (error) {
    set.status = 502
    return { error: message(error) }
  }
}

const removeExplanation = (error: unknown): string => (message(error) === 'It is building now' ? 'Stop its run in Studio first' : NO_ITEM)
const moveExplanation = (): string => NO_ITEM

export function queueRoutes(store: QueueStore, engine: QueueEngineRoutes): Elysia {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/queue', () => ({ items: store.list() }))
    .get('/api/queue/stream', ({ request }) => eventStreamResponse(store, () => ({ items: store.list() }), request.signal))
    .post('/api/queue', ({ body, set }) => addItem(engine, body, set))
    .post('/api/queue/check', () => engine.checkReplies())
    .post('/api/queue/:id/move', async ({ params, body, set }) => {
      const parsed = moveSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'to must be a position from 0' } }
      return refusing(set, async () => { await engine.move(params.id, parsed.data.to); return { items: store.list() } }, moveExplanation)
    })
    .post('/api/queue/:id/requeue', ({ params, set }) => requeueItem(store, engine, params.id, set))
    .delete('/api/queue/:id', ({ params, set }) => refusing(set, async () => { await engine.remove(params.id); return { ok: true } }, removeExplanation))
}
