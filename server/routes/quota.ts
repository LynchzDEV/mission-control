import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { createQuotaCache, fetchExternalSessions, fetchQuotaComposite, type QuotaComposite } from '../quota'
import { readSecrets } from '../secrets'

const quotaCache = createQuotaCache<QuotaComposite>(async () => fetchQuotaComposite(await readSecrets()))

export const quotaRoutes = new Elysia()
  .onBeforeHandle(requireSession)
  .get('/api/quota', () => quotaCache.get())
  .get('/api/sessions/external', async () => ({ sessions: await fetchExternalSessions() }))
