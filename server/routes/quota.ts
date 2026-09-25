import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { createTokenSampler, type TokenSampler } from '../meta'
import { createQuotaCache, type ExternalSession, fetchQuotaComposite, type QuotaComposite } from '../quota'
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

export function quotaRoutes(deps: { externalSessions: () => Promise<ExternalSession[]> }) {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/quota', () => quotaCache.get())
    .get('/api/sessions/external', async () => ({ sessions: await deps.externalSessions() }))
}
