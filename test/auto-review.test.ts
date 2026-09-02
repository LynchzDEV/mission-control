import { describe, expect, test } from 'bun:test'

import { buildReviewPrompt, maybeAutoReview, reviewerReadiness, shouldAutoReview } from '../server/auto-review'
import type { CreateJobParams, JobManager, JobRecord } from '../server/jobs'
import type { QuotaComposite } from '../server/quota'
import { DEFAULT_ROLES, type EngineRoles } from '../server/secrets'

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  const id = overrides.id ?? 'glm-1'
  return {
    id,
    engine: 'glm',
    cwd: '/Users/x/code/repo',
    label: 'ticket-a',
    prompt: 'implement',
    pid: 1,
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    exitCode: 0,
    diffStat: '2 files changed',
    reviewedAt: null,
    sessionId: null,
    parentJobId: null,
    threadRoot: id,
    terminalId: null,
    reviewOf: null,
    model: null,
    ...overrides,
  }
}

function quota(overrides: Partial<QuotaComposite> = {}): QuotaComposite {
  return {
    claude: { available: true, active: true, tokens: 1, costUSD: null, resetsAt: null, blockPercent: null, nonCacheTokens: null },
    glm: { available: true, fiveHourPct: 10, monthlyPct: null },
    codex: { available: true, authed: true },
    peak: { peak: false, minutesToChange: 60 },
    ...overrides,
  }
}

function fakeManager(all: JobRecord[], created: CreateJobParams[]): JobManager {
  return {
    listJobs: () => all,
    createJob: async (params) => {
      created.push(params)
      return { ok: true, job: job({ id: 'review-1', ...params }) }
    },
  } as unknown as JobManager
}

function deps(roles: EngineRoles = DEFAULT_ROLES, composite: QuotaComposite = quota()) {
  return {
    resolver: () => ({ cmd: 'echo', args: [], env: {} }),
    roles: async () => roles,
    probeQuota: async () => composite,
    log: () => {},
  }
}

const ROLES = (plan: string, execute: string, review: string): EngineRoles => ({
  plan: { engine: plan, model: null },
  execute: { engine: execute, model: null },
  review: { engine: review, model: null },
})

describe('shouldAutoReview', () => {
  test('a done executor job with a diff and no review sibling is due', () => {
    expect(shouldAutoReview(job(), [job()], DEFAULT_ROLES)).toBe(true)
  })

  test('failed, non-executor, diffless, and review jobs are not due', () => {
    expect(shouldAutoReview(job({ status: 'failed' }), [], DEFAULT_ROLES)).toBe(false)
    expect(shouldAutoReview(job({ engine: 'codex' }), [], DEFAULT_ROLES)).toBe(false)
    expect(shouldAutoReview(job({ engine: 'claude' }), [], DEFAULT_ROLES)).toBe(false)
    expect(shouldAutoReview(job({ diffStat: null }), [], DEFAULT_ROLES)).toBe(false)
    expect(shouldAutoReview(job({ diffStat: '  ' }), [], DEFAULT_ROLES)).toBe(false)
    expect(shouldAutoReview(job({ reviewOf: 'other' }), [], DEFAULT_ROLES)).toBe(false)
  })

  test('the executor role decides which engine is reviewable', () => {
    const roles = ROLES('claude', 'codex', 'claude')
    expect(shouldAutoReview(job({ engine: 'codex' }), [], roles)).toBe(true)
    expect(shouldAutoReview(job({ engine: 'glm' }), [], roles)).toBe(false)
  })

  test('a thread that already has a review job is not re-reviewed, even on the same engine', () => {
    const done = job()
    const review = job({ id: 'glm-2', engine: 'glm', threadRoot: done.threadRoot, reviewOf: done.id })
    const roles = ROLES('glm', 'glm', 'glm')
    expect(shouldAutoReview(done, [done, review], roles)).toBe(false)
    expect(shouldAutoReview(review, [done, review], roles)).toBe(false)
  })
})

describe('reviewerReadiness', () => {
  test('codex needs availability and auth', () => {
    expect(reviewerReadiness('codex', quota())).toEqual({ ok: true })
    expect(reviewerReadiness('codex', quota({ codex: { available: false, reason: 'missing' } })).ok).toBe(false)
    expect(reviewerReadiness('codex', quota({ codex: { available: true, authed: false } })).ok).toBe(false)
  })

  test('glm and claude need their quota probe to answer', () => {
    expect(reviewerReadiness('glm', quota())).toEqual({ ok: true })
    expect(reviewerReadiness('glm', quota({ glm: { available: false, reason: 'no token' } })).ok).toBe(false)
    expect(reviewerReadiness('claude', quota())).toEqual({ ok: true })
    expect(reviewerReadiness('claude', quota({ claude: { available: false, reason: 'ccusage down' } })).ok).toBe(false)
    expect(reviewerReadiness('gpt', quota()).ok).toBe(false)
  })
})

describe('maybeAutoReview', () => {
  test('dispatches the review-role engine chained to the source thread, inheriting terminalId', async () => {
    const source = job({ terminalId: 'term-9' })
    const created: CreateJobParams[] = []
    await maybeAutoReview(source, fakeManager([source], created), deps())

    expect(created).toHaveLength(1)
    const params = created[0]!
    expect(params.engine).toBe('codex')
    expect(params.cwd).toBe(source.cwd)
    expect(params.label).toBe(source.label)
    expect(params.threadRoot).toBe(source.threadRoot)
    expect(params.parentJobId).toBe(source.id)
    expect(params.reviewOf).toBe(source.id)
    expect(params.terminalId).toBe('term-9')
    expect(params.prompt).toContain('SHIP')
  })

  test('follows a custom mapping: codex executor reviewed by claude', async () => {
    const source = job({ engine: 'codex' })
    const created: CreateJobParams[] = []
    await maybeAutoReview(source, fakeManager([source], created), deps(ROLES('claude', 'codex', 'claude')))
    expect(created.map((params) => params.engine)).toEqual(['claude'])
  })

  test('passes the review-role model to the created job', async () => {
    const source = job()
    const created: CreateJobParams[] = []
    const roles: EngineRoles = { ...DEFAULT_ROLES, review: { engine: 'codex', model: 'gpt-5.1' } }
    await maybeAutoReview(source, fakeManager([source], created), deps(roles))
    expect(created[0]?.model).toBe('gpt-5.1')
  })

  test('same-engine mapping reviews once and never loops', async () => {
    const roles = ROLES('glm', 'glm', 'glm')
    const source = job()
    const all = [source]
    const created: CreateJobParams[] = []
    const manager = {
      listJobs: () => all,
      createJob: async (params: CreateJobParams) => {
        created.push(params)
        const review = job({ id: 'glm-2', ...params, reviewOf: params.reviewOf ?? null })
        all.push(review)
        return { ok: true, job: review }
      },
    } as unknown as JobManager

    await maybeAutoReview(source, manager, deps(roles))
    await maybeAutoReview(all[1]!, manager, deps(roles))
    await maybeAutoReview(source, manager, deps(roles))
    expect(created).toHaveLength(1)
  })

  test('skips when the reviewer engine is not ready', async () => {
    const source = job()
    const created: CreateJobParams[] = []
    const manager = fakeManager([source], created)

    await maybeAutoReview(source, manager, deps(DEFAULT_ROLES, quota({ codex: { available: false, reason: 'missing' } })))
    await maybeAutoReview(source, manager, deps(DEFAULT_ROLES, quota({ codex: { available: true, authed: false } })))
    await maybeAutoReview(
      source,
      manager,
      deps(ROLES('claude', 'glm', 'claude'), quota({ claude: { available: false, reason: 'ccusage' } })),
    )

    expect(created).toHaveLength(0)
  })
})

describe('buildReviewPrompt', () => {
  test('is self-contained: names the label and executor, forbids edits, demands a verdict line', () => {
    const prompt = buildReviewPrompt(job({ engine: 'codex' }))
    expect(prompt).toContain('ticket-a')
    expect(prompt).toContain('finished codex implementation job')
    expect(prompt).toContain('NO-SHIP')
    expect(prompt).toContain('Do NOT edit')
  })
})
