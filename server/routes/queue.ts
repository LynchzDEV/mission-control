import { Elysia } from 'elysia'
import { z } from 'zod'

import { requireLocal } from '../auth'
import type { QueueEngine } from '../queue-engine'
import type { QueueItem, QueueStore } from '../queue-store'
import { eventStreamResponse } from '../run-events'

type Status = { status?: number | string }
type QueueEngineRoutes = Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies'>

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

function requeueRefusalStatus(error: unknown): number | undefined {
  const text = message(error)
  if (text.startsWith('No queue item')) return 404
  if (text.startsWith('It is ')) return 409
  return undefined
}

async function requeueItem(store: QueueStore, engine: QueueEngineRoutes, id: string, set: Status) {
  const item = store.get(id)
  if (item === undefined) { set.status = 404; return { error: NO_ITEM } }
  if (item.state === 'building') { set.status = 409; return { error: 'It is building now' } }
  try {
    return { item: await engine.requeue(id) }
  } catch (error) {
    const status = requeueRefusalStatus(error)
    if (status === undefined) throw error
    set.status = status
    return { error: message(error) }
  }
}

export function queueRoutes(store: QueueStore, engine: QueueEngineRoutes): Elysia {
  const known = (id: string, set: Status): QueueItem | undefined => {
    const item = store.get(id)
    if (item === undefined) set.status = 404
    return item
  }
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/queue', () => ({ items: store.list() }))
    .get('/api/queue/stream', ({ request }) => eventStreamResponse(store, () => ({ items: store.list() }), request.signal))
    .post('/api/queue', async ({ body, set }) => {
      const parsed = addSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'source, externalId and repo are required; position is end or next' } }
      try { return { item: await engine.add(parsed.data) } } catch (error) { set.status = 502; return { error: message(error) } }
    })
    .post('/api/queue/check', () => engine.checkReplies())
    .post('/api/queue/:id/move', async ({ params, body, set }) => {
      const parsed = moveSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'to must be a position from 0' } }
      if (!known(params.id, set)) return { error: NO_ITEM }
      await store.move(params.id, parsed.data.to)
      return { items: store.list() }
    })
    .post('/api/queue/:id/requeue', ({ params, set }) => requeueItem(store, engine, params.id, set))
    .delete('/api/queue/:id', async ({ params, set }) => {
      const item = known(params.id, set)
      if (!item) return { error: NO_ITEM }
      if (item.state === 'building') { set.status = 409; return { error: 'Stop its run in Studio first' } }
      await store.remove(params.id)
      return { ok: true }
    })
}
