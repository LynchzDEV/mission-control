import { describe, expect, test } from 'bun:test'

import { awaitsReview, countPendingReviews, deriveFlow, isSessionFinished, sessionKey } from '../server/flow'
import type { SessionFlow } from '../server/flow'
import type { JobRecord } from '../server/jobs'
import type { Plan } from '../server/plans'
import type { TerminalRecord } from '../server/terminals'

const NOW = Date.parse('2026-08-28T12:00:00.000Z')
const MINUTE = 60_000

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    engine: 'glm',
    cwd: '/home/dev/code/.worktree/orders-export',
    label: 'orders-export-fix',
    pid: 1234,
    status: 'running',
    startedAt: NOW - 26 * MINUTE,
    endedAt: null,
    exitCode: null,
    diffStat: null,
    reviewedAt: null,
    ...overrides,
  }
}

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: 'term-1',
    engine: 'claude',
    cwd: '/home/dev/code',
    pid: 4321,
    createdAt: NOW - 5 * MINUTE,
    title: 'CLAUDE · code',
    ...overrides,
  }
}

function flowOf(jobs: JobRecord[], terminals: TerminalRecord[] = []): Record<string, SessionFlow> {
  return deriveFlow({ jobs, terminals, now: NOW }).sessions
}

describe('sessionKey', () => {
  test('uses the label when present', () => {
    expect(sessionKey(job({ label: 'orders-export-fix' }))).toBe('orders-export-fix')
  })

  test('falls back to the job id for an unlabelled job', () => {
    expect(sessionKey(job({ id: 'abc-123', label: '' }))).toBe('abc-123')
    expect(sessionKey(job({ id: 'abc-123', label: '   ' }))).toBe('abc-123')
  })

  test('groups unlabelled jobs as one session each', () => {
    const sessions = flowOf([job({ id: 'a', label: '' }), job({ id: 'b', label: '' })])
    expect(Object.keys(sessions).sort()).toEqual(['a', 'b'])
  })
})

describe('SPEC stage', () => {
  test('is done for every session that has a job', () => {
    expect(flowOf([job()])['orders-export-fix']?.spec).toEqual(['done', 'CLAUDE'])
  })
})

describe('IMPLEMENT stage', () => {
  test('a running glm job is active with elapsed minutes and the cwd basename', () => {
    const sessions = flowOf([job({ engine: 'glm', status: 'running' })])
    expect(sessions['orders-export-fix']?.impl).toEqual(['active', 'GLM · 26m · orders-export'])
  })

  test('a running claude job is active on the same node', () => {
    const sessions = flowOf([job({ engine: 'claude', startedAt: NOW - 3 * MINUTE })])
    expect(sessions['orders-export-fix']?.impl?.[1]).toBe('CLAUDE · 3m · orders-export')
  })

  test('a done job is done', () => {
    const sessions = flowOf([job({ status: 'done', endedAt: NOW - MINUTE })])
    expect(sessions['orders-export-fix']?.impl).toEqual(['done', 'GLM · orders-export'])
  })

  test('a failed job is flagged as error', () => {
    const sessions = flowOf([job({ status: 'failed', endedAt: NOW - MINUTE })])
    expect(sessions['orders-export-fix']?.impl).toEqual(['error', 'GLM · FAILED'])
  })

  test('a retry that is still running outranks the earlier failure', () => {
    const sessions = flowOf([
      job({ id: 'a', status: 'failed', endedAt: NOW - 30 * MINUTE }),
      job({ id: 'b', status: 'running', startedAt: NOW - 2 * MINUTE }),
    ])
    expect(sessions['orders-export-fix']?.impl).toEqual(['active', 'GLM · 2m · orders-export'])
  })

  test('a done job outranks an earlier failure', () => {
    const sessions = flowOf([
      job({ id: 'a', status: 'failed', endedAt: NOW - 30 * MINUTE }),
      job({ id: 'b', status: 'done', endedAt: NOW - MINUTE }),
    ])
    expect(sessions['orders-export-fix']?.impl?.[0]).toBe('done')
  })

  test('is future when only a codex job carries the label', () => {
    const sessions = flowOf([job({ engine: 'codex' })])
    expect(sessions['orders-export-fix']?.impl).toEqual(['future', 'GLM'])
  })
})

describe('CROSS-REVIEW stage', () => {
  test('is future while the implementation is still running', () => {
    expect(flowOf([job()])['orders-export-fix']?.codex).toEqual(['future', 'CODEX'])
  })

  test('is queued once the implementation is done and no codex job exists', () => {
    const sessions = flowOf([job({ status: 'done', endedAt: NOW - MINUTE })])
    expect(sessions['orders-export-fix']?.codex).toEqual(['queued', 'CODEX · QUEUED'])
  })

  test('a running codex job is active with elapsed minutes', () => {
    const sessions = flowOf([
      job({ id: 'a', status: 'done', endedAt: NOW - 20 * MINUTE }),
      job({ id: 'b', engine: 'codex', status: 'running', startedAt: NOW - 4 * MINUTE }),
    ])
    expect(sessions['orders-export-fix']?.codex).toEqual(['active', 'CODEX · 4m'])
  })

  test('a done codex job is done', () => {
    const sessions = flowOf([
      job({ id: 'a', status: 'done', endedAt: NOW - 20 * MINUTE }),
      job({ id: 'b', engine: 'codex', status: 'done', endedAt: NOW - MINUTE }),
    ])
    expect(sessions['orders-export-fix']?.codex).toEqual(['done', 'CODEX · DONE'])
  })

  test('a failed codex job is flagged as error', () => {
    const sessions = flowOf([
      job({ id: 'a', status: 'done', endedAt: NOW - 20 * MINUTE }),
      job({ id: 'b', engine: 'codex', status: 'failed', endedAt: NOW - MINUTE }),
    ])
    expect(sessions['orders-export-fix']?.codex).toEqual(['error', 'CODEX · FAILED'])
  })
})

describe('VERIFY stage', () => {
  const withDiff = { status: 'done' as const, endedAt: NOW - 4 * MINUTE, diffStat: '2 files changed' }

  test('is future while nothing has produced a diff', () => {
    expect(flowOf([job()])['orders-export-fix']?.verify).toEqual(['future', 'CLAUDE'])
  })

  test('is future for a done job with an empty diffStat', () => {
    const sessions = flowOf([job({ status: 'done', endedAt: NOW - MINUTE, diffStat: '' })])
    expect(sessions['orders-export-fix']?.verify).toEqual(['future', 'CLAUDE'])
  })

  test('an unreviewed diff is active with the wait time', () => {
    const sessions = flowOf([job(withDiff)])
    expect(sessions['orders-export-fix']?.verify).toEqual(['active', 'CLAUDE · NOW · 4m'])
  })

  test('a reviewed diff is done', () => {
    const sessions = flowOf([job({ ...withDiff, reviewedAt: NOW - MINUTE })])
    expect(sessions['orders-export-fix']?.verify).toEqual(['done', 'CLAUDE · REVIEWED'])
  })

  test('one unreviewed diff keeps the node active even when a sibling is reviewed', () => {
    const sessions = flowOf([
      job({ id: 'a', ...withDiff, reviewedAt: NOW - MINUTE }),
      job({ id: 'b', ...withDiff }),
    ])
    expect(sessions['orders-export-fix']?.verify?.[0]).toBe('active')
  })
})

describe('MERGED stage', () => {
  const reviewed = { status: 'done' as const, endedAt: NOW - 10 * MINUTE, diffStat: '1 file changed' }

  test('is future while any job of the label is unreviewed', () => {
    const sessions = flowOf([job({ id: 'a', ...reviewed, reviewedAt: NOW - MINUTE }), job({ id: 'b' })])
    expect(sessions['orders-export-fix']?.merged?.[0]).toBe('future')
  })

  test('is done once every job of the label is reviewed', () => {
    const sessions = flowOf([job({ ...reviewed, reviewedAt: NOW - MINUTE })])
    expect(sessions['orders-export-fix']?.merged).toEqual(['done', '1 TODAY'])
  })

  test("the badge counts today's merged labels across every session", () => {
    const snapshot = deriveFlow({
      jobs: [
        job({ id: 'a', label: 'one', ...reviewed, reviewedAt: NOW - MINUTE }),
        job({ id: 'b', label: 'two', ...reviewed, reviewedAt: NOW - 2 * MINUTE }),
        job({ id: 'c', label: 'three', ...reviewed, reviewedAt: NOW - 3 * 24 * 60 * MINUTE }),
        job({ id: 'd', label: 'four' }),
      ],
      terminals: [],
      now: NOW,
    })
    expect(snapshot.mergedToday).toBe(2)
    expect(snapshot.sessions.four?.merged).toEqual(['future', '2 TODAY'])
  })
})

describe('snapshot shape', () => {
  test('current prefers a session with an active stage', () => {
    const snapshot = deriveFlow({
      jobs: [
        job({ id: 'a', label: 'idle', status: 'done', endedAt: NOW - MINUTE, reviewedAt: NOW }),
        job({ id: 'b', label: 'busy', status: 'running', startedAt: NOW - MINUTE }),
      ],
      terminals: [terminal()],
      now: NOW,
    })
    expect(snapshot.current).toBe('busy')
  })

  test('an empty job list derives nothing rather than inventing a session', () => {
    const snapshot = deriveFlow({ jobs: [], terminals: [terminal()], now: NOW })
    expect(snapshot).toEqual({ current: '', sessions: {}, reviewCount: 0, mergedToday: 0 })
  })

  test('terminals never introduce a session of their own', () => {
    const snapshot = deriveFlow({ jobs: [], terminals: [terminal(), terminal({ id: 'term-2' })], now: NOW })
    expect(snapshot.sessions).toEqual({})
  })

  test('every node id the client renders is present for each session', () => {
    const session = flowOf([job()])['orders-export-fix']
    expect(Object.keys(session as SessionFlow).sort()).toEqual([
      'codex',
      'impl',
      'merged',
      'spec',
      'verify',
    ])
  })
})

describe('isSessionFinished', () => {
  function plan(overrides: Partial<Plan> = {}): Plan {
    return { label: 'demo', steps: [], next: null, updatedAt: 0, ...overrides }
  }

  test('with a plan, finished only once every step is done', () => {
    const allDone = plan({
      steps: [
        { title: 'a', assignee: 'claude', status: 'done' },
        { title: 'b', assignee: 'glm', status: 'done' },
      ],
    })
    expect(isSessionFinished(allDone, [])).toBe(true)
  })

  test('with a plan, one pending or active step is not finished', () => {
    const partial = plan({
      steps: [
        { title: 'a', assignee: 'claude', status: 'done' },
        { title: 'b', assignee: 'glm', status: 'active' },
      ],
    })
    expect(isSessionFinished(partial, [])).toBe(false)
  })

  test('without a plan, finished once every job of the label is reviewed', () => {
    const jobs = [
      job({ id: 'a', status: 'done', endedAt: NOW - MINUTE, reviewedAt: NOW - MINUTE }),
      job({ id: 'b', status: 'done', endedAt: NOW - MINUTE, reviewedAt: NOW }),
    ]
    expect(isSessionFinished(null, jobs)).toBe(true)
  })

  test('without a plan, one unreviewed job is not finished', () => {
    const jobs = [
      job({ id: 'a', status: 'done', endedAt: NOW - MINUTE, reviewedAt: NOW }),
      job({ id: 'b', status: 'done', endedAt: NOW - MINUTE, reviewedAt: null }),
    ]
    expect(isSessionFinished(null, jobs)).toBe(false)
  })

  test('no plan and no jobs is not finished', () => {
    expect(isSessionFinished(null, [])).toBe(false)
  })
})

describe('review predicate', () => {
  const done = { status: 'done' as const, endedAt: NOW - MINUTE }

  test('a done job with a diff and no review is waiting', () => {
    expect(awaitsReview(job({ ...done, diffStat: '1 file changed' }))).toBe(true)
  })

  test('a reviewed job is not waiting', () => {
    expect(awaitsReview(job({ ...done, diffStat: '1 file changed', reviewedAt: NOW }))).toBe(false)
  })

  test('a running job and a diffless job are not waiting', () => {
    expect(awaitsReview(job({ diffStat: '1 file changed' }))).toBe(false)
    expect(awaitsReview(job({ ...done, diffStat: null }))).toBe(false)
  })

  test('countPendingReviews excludes reviewed jobs', () => {
    const jobs = [
      job({ id: 'a', ...done, diffStat: '1 file changed' }),
      job({ id: 'b', ...done, diffStat: '2 files changed', reviewedAt: NOW }),
      job({ id: 'c', ...done, diffStat: '3 files changed' }),
    ]
    expect(countPendingReviews(jobs)).toBe(2)
    expect(deriveFlow({ jobs, terminals: [], now: NOW }).reviewCount).toBe(2)
  })
})
