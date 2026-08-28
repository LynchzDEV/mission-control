import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { createTokenSampler, type TokenSampler } from '../meta'
import { createQuotaCache, fetchExternalSessions, fetchQuotaComposite, type QuotaComposite } from '../quota'
import { readSecrets } from '../secrets'

export const tokenSampler: TokenSampler = createTokenSampler()

export const quotaCache = createQuotaCache<QuotaComposite>(async () => {
  const composite = await fetchQuotaComposite(await readSecrets())
  if (composite.claude.available) {
    const burn = composite.claude.nonCacheTokens ?? null
    if (burn !== null) tokenSampler.record(burn, Date.now())
  }
  return composite
})

export const quotaRoutes = new Elysia()
  .onBeforeHandle(requireSession)
  .get('/api/quota', () => quotaCache.get())
  .get('/api/sessions/external', async () => ({ sessions: await fetchExternalSessions() }))
