import { Elysia } from 'elysia'

import type { AttentionStore } from '../attention'
import { requireLocal } from '../auth'
import { eventStreamResponse } from '../run-events'

export function attentionRoutes(store: AttentionStore): Elysia {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/attention', () => ({ items: store.list() }))
    .get('/api/attention/stream', ({ request }) => eventStreamResponse(store, () => ({ items: store.list() }), request.signal))
    .post('/api/attention/:key/dismiss', async ({ params, set }) => {
      const key = decodeURIComponent(params.key)
      const item = store.list().find(entry => entry.key === key)
      if (item === undefined) { set.status = 404; return { error: 'Nothing waiting under that key' } }
      if (item.kind === 'permission') { set.status = 409; return { error: 'Answer the permission request instead' } }
      await store.resolve(key)
      return { ok: true }
    })
}
