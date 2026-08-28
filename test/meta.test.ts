import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { SESSION_COOKIE, completeSetup, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import { createJobManager, type JobManager, type JobRecord } from '../server/jobs'
import { BLOCK_MS, blockClock, createTokenSampler, tokensPerMinute } from '../server/meta'
import type { QuotaComposite } from '../server/quota'
import { metaRoutes } from '../server/routes/meta'

const PASSWORD = 'correct-horse-battery'
const NOW = Date.parse('2026-08-28T12:00:00.000Z')
const MINUTE = 60_000

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-meta-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  resetLoginLimiter()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  resetLoginLimiter()
  await rm(configDir, { recursive: true, force: true })
})

describe('blockClock', () => {
  test('measures elapsed time from the block start (resetsAt minus five hours)', () => {
    const resetsAt = new Date(NOW + 109 * MINUTE).toISOString()
    expect(blockClock(resetsAt, NOW)).toEqual({ elapsed: '03:11', total: '5:00', pct: 63.7 })
  })

  test('reads zero at the very start of a block', () => {
    const resetsAt = new Date(NOW + BLOCK_MS).toISOString()
    expect(blockClock(resetsAt, NOW)).toEqual({ elapsed: '00:00', total: '5:00', pct: 0 })
  })

  test('clamps to the full block once the reset time has passed', () => {
    const resetsAt = new Date(NOW - MINUTE).toISOString()
    expect(blockClock(resetsAt, NOW)).toEqual({ elapsed: '05:00', total: '5:00', pct: 100 })
  })

  test('clamps to zero for a block that has not started yet', () => {
    const resetsAt = new Date(NOW + BLOCK_MS + 30 * MINUTE).toISOString()
    expect(blockClock(resetsAt, NOW)?.elapsed).toBe('00:00')
  })

  test('is null without a usable resetsAt', () => {
    expect(blockClock(null, NOW)).toBeNull()
    expect(blockClock('not-a-timestamp', NOW)).toBeNull()
  })
})

describe('tokensPerMinute', () => {
  test('is null below two samples', () => {
    expect(tokensPerMinute([])).toBeNull()
    expect(tokensPerMinute([{ at: NOW, tokens: 100 }])).toBeNull()
  })

  test('is the slope between two samples', () => {
    const slope = tokensPerMinute([
      { at: NOW, tokens: 1_000 },
      { at: NOW + 2 * MINUTE, tokens: 3_000 },
    ])
    expect(slope).toBe(1_000)
  })

  test('fits a slope across a longer run of samples', () => {
    const samples = [0, 1, 2, 3, 4].map((step) => ({ at: NOW + step * MINUTE, tokens: 500 * step }))
    expect(tokensPerMinute(samples)).toBeCloseTo(500, 6)
  })

  test('is null when every sample shares one timestamp', () => {
    expect(
      tokensPerMinute([
        { at: NOW, tokens: 10 },
        { at: NOW, tokens: 20 },
      ]),
    ).toBeNull()
  })
})

describe('token sampler', () => {
  test('reports null until a second sample arrives', () => {
    const sampler = createTokenSampler()
    expect(sampler.tokensPerMin()).toBeNull()
    sampler.record(1_000, NOW)
    expect(sampler.tokensPerMin()).toBeNull()
    sampler.record(2_000, NOW + MINUTE)
    expect(sampler.tokensPerMin()).toBe(1_000)
  })

  test('keeps only the last ten samples', () => {
    const sampler = createTokenSampler()
    for (let step = 0; step < 14; step += 1) sampler.record(step * 100, NOW + step * MINUTE)
    const samples = sampler.samples()
    expect(samples.length).toBe(10)
    expect(samples[0]?.tokens).toBe(400)
  })

  test('drops the history when the counter resets into a new block', () => {
    const sampler = createTokenSampler()
    sampler.record(9_000, NOW)
    sampler.record(10_000, NOW + MINUTE)
    expect(sampler.tokensPerMin()).toBe(1_000)

    sampler.record(200, NOW + 2 * MINUTE)
    expect(sampler.samples()).toEqual([{ at: NOW + 2 * MINUTE, tokens: 200 }])
    expect(sampler.tokensPerMin()).toBeNull()

    sampler.record(700, NOW + 3 * MINUTE)
    expect(sampler.tokensPerMin()).toBe(500)
  })

  test('honours a custom sample cap', () => {
    const sampler = createTokenSampler(2)
    sampler.record(1, NOW)
    sampler.record(2, NOW + MINUTE)
    sampler.record(3, NOW + 2 * MINUTE)
    expect(sampler.samples().map((sample) => sample.tokens)).toEqual([2, 3])
  })
})

function quotaWith(resetsAt: string | null, tokens = 1_000): () => Promise<QuotaComposite> {
  return async () => ({
    claude: { available: true, active: true, tokens, costUSD: null, resetsAt, blockPercent: null },
    glm: { available: false, reason: 'not configured' },
    codex: { available: true, authed: false },
    peak: { peak: false, minutesToChange: 30 },
  })
}

function reviewableJob(id: string, reviewedAt: number | null): JobRecord {
  return {
    id,
    engine: 'glm',
    cwd: '/home/dev/code',
    label: id,
    pid: 1,
    status: 'done',
    startedAt: NOW - 10 * MINUTE,
    endedAt: NOW - MINUTE,
    exitCode: 0,
    diffStat: '1 file changed',
    reviewedAt,
  }
}

function stubManager(jobs: JobRecord[]): JobManager {
  const base = createJobManager()
  return { ...base, listJobs: () => jobs }
}

async function authCookie(): Promise<string> {
  const result = await completeSetup(PASSWORD)
  if (!result.ok) throw new Error('test harness setup failed')
  return `${SESSION_COOKIE}=${result.token}`
}

describe('GET /api/meta', () => {
  test('requires a session', async () => {
    const app = new Elysia().use(metaRoutes(createJobManager()))
    const response = await app.handle(new Request('http://localhost/api/meta'))
    expect(response.status).toBe(401)
  })

  test('serves the live block clock, slope, and pending review count', async () => {
    const cookie = await authCookie()
    const sampler = createTokenSampler()
    sampler.record(1_000, NOW)
    sampler.record(4_000, NOW + MINUTE)

    const manager = stubManager([reviewableJob('a', null), reviewableJob('b', NOW), reviewableJob('c', null)])
    const app = new Elysia().use(
      metaRoutes(manager, {
        quota: quotaWith(new Date(NOW + 109 * MINUTE).toISOString()),
        sampler,
        now: () => NOW,
      }),
    )

    const response = await app.handle(new Request('http://localhost/api/meta', { headers: { cookie } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      source: 'live',
      blockClock: { elapsed: '03:11', total: '5:00', pct: 63.7 },
      tokPerMin: 3_000,
      reviewCount: 2,
    })
  })

  test('serves a null block clock and slope when the quota has neither', async () => {
    const cookie = await authCookie()
    const app = new Elysia().use(
      metaRoutes(stubManager([]), {
        quota: quotaWith(null),
        sampler: createTokenSampler(),
        now: () => NOW,
      }),
    )

    const response = await app.handle(new Request('http://localhost/api/meta', { headers: { cookie } }))
    const body = (await response.json()) as { blockClock: unknown; tokPerMin: unknown; reviewCount: number }
    expect(body.blockClock).toBeNull()
    expect(body.tokPerMin).toBeNull()
    expect(body.reviewCount).toBe(0)
  })

  // The authed path is covered above with an injected quota; hitting it here would shell out to ccusage.
  test('is mounted in the real app behind the session guard', async () => {
    const app = await createApp()
    expect((await app.handle(new Request('http://localhost/api/meta'))).status).toBe(401)
    expect((await app.handle(new Request('http://localhost/api/meta-nope'))).status).toBe(404)
  })
})
