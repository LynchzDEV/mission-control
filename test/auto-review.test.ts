import { describe, expect, test } from 'bun:test'

import { buildReviewPrompt, maybeAutoReview, shouldAutoReview } from '../server/auto-review'
import type { CreateJobParams, JobManager, JobRecord } from '../server/jobs'

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
    ...overrides,
  }
}

function fakeManager(all: JobRecord[], created: CreateJobParams[]): JobManager {
  return {
    listJobs: () => all,
    createJob: async (params) => {
      created.push(params)
      return { ok: true, job: job({ id: 'codex-1', engine: 'codex', ...params }) }
    },
  } as unknown as JobManager
}

describe('shouldAutoReview', () => {
  test('a done glm job with a diff and no codex sibling is due', () => {
    expect(shouldAutoReview(job(), [job()])).toBe(true)
  })

  test('failed, non-glm, and diffless jobs are not due', () => {
    expect(shouldAutoReview(job({ status: 'failed' }), [])).toBe(false)
    expect(shouldAutoReview(job({ engine: 'codex' }), [])).toBe(false)
    expect(shouldAutoReview(job({ engine: 'claude' }), [])).toBe(false)
    expect(shouldAutoReview(job({ diffStat: null }), [])).toBe(false)
    expect(shouldAutoReview(job({ diffStat: '  ' }), [])).toBe(false)
  })

  test('a thread that already has a codex job is not re-reviewed', () => {
    const done = job()
    const review = job({ id: 'codex-1', engine: 'codex', threadRoot: done.threadRoot })
    expect(shouldAutoReview(done, [done, review])).toBe(false)
  })
})

describe('maybeAutoReview', () => {
  test('dispatches a codex job chained to the source thread, inheriting terminalId', async () => {
    const source = job({ terminalId: 'term-9' })
    const created: CreateJobParams[] = []
    await maybeAutoReview(source, fakeManager([source], created), {
      resolver: () => ({ cmd: 'echo', args: [], env: {} }),
      probeCodex: async () => ({ available: true, authed: true }),
      log: () => {},
    })

    expect(created).toHaveLength(1)
    const params = created[0]!
    expect(params.engine).toBe('codex')
    expect(params.cwd).toBe(source.cwd)
    expect(params.label).toBe(source.label)
    expect(params.threadRoot).toBe(source.threadRoot)
    expect(params.parentJobId).toBe(source.id)
    expect(params.terminalId).toBe('term-9')
    expect(params.prompt).toContain('SHIP')
  })

  test('skips when codex is unavailable or not authed', async () => {
    const source = job()
    const created: CreateJobParams[] = []
    const manager = fakeManager([source], created)
    const base = { resolver: () => ({ cmd: 'echo', args: [], env: {} }), log: () => {} }

    await maybeAutoReview(source, manager, {
      ...base,
      probeCodex: async () => ({ available: false, reason: 'missing' }),
    })
    await maybeAutoReview(source, manager, {
      ...base,
      probeCodex: async () => ({ available: true, authed: false }),
    })

    expect(created).toHaveLength(0)
  })

  test('a settled codex job never triggers another review (no loop)', async () => {
    const review = job({ id: 'codex-1', engine: 'codex' })
    const created: CreateJobParams[] = []
    await maybeAutoReview(review, fakeManager([review], created), {
      resolver: () => ({ cmd: 'echo', args: [], env: {} }),
      probeCodex: async () => ({ available: true, authed: true }),
      log: () => {},
    })
    expect(created).toHaveLength(0)
  })
})

describe('buildReviewPrompt', () => {
  test('is self-contained: names the label, forbids edits, demands a verdict line', () => {
    const prompt = buildReviewPrompt(job())
    expect(prompt).toContain('ticket-a')
    expect(prompt).toContain('NO-SHIP')
    expect(prompt).toContain('Do NOT edit')
  })
})
