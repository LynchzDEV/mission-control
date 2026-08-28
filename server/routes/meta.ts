import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { countPendingReviews } from '../flow'
import type { JobManager } from '../jobs'
import { blockClock, type BlockClock, type TokenSampler } from '../meta'
import type { QuotaComposite } from '../quota'
import { quotaCache, tokenSampler } from './quota'

export type MetaResponse = {
  source: 'live'
  blockClock: BlockClock | null
  tokPerMin: number | null
  reviewCount: number
}

export type MetaDeps = {
  quota: () => Promise<QuotaComposite>
  sampler: TokenSampler
  now: () => number
}

export function metaSnapshot(manager: JobManager, deps: MetaDeps): Promise<MetaResponse> {
  return deps.quota().then((composite) => ({
    source: 'live' as const,
    blockClock: blockClock(composite.claude.available ? composite.claude.resetsAt : null, deps.now()),
    tokPerMin: deps.sampler.tokensPerMin(),
    reviewCount: countPendingReviews(manager.listJobs()),
  }))
}

export function metaRoutes(manager: JobManager, deps: Partial<MetaDeps> = {}): Elysia {
  const resolved: MetaDeps = {
    quota: deps.quota ?? (() => quotaCache.get()),
    sampler: deps.sampler ?? tokenSampler,
    now: deps.now ?? Date.now,
  }
  return new Elysia().onBeforeHandle(requireSession).get('/api/meta', () => metaSnapshot(manager, resolved))
}
