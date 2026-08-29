import { describe, expect, test } from 'bun:test'

import {
  RECENT_LIMIT,
  accentClass,
  baseName,
  formatElapsed,
  jobElapsed,
  shortId,
  secondLine,
  splitAgents,
  statusGlyph,
  toAgentJob,
  type AgentJob,
  type AgentThread,
} from '../client/agents'

const NOW = 1_700_000_000_000

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  const id = overrides.id ?? 'job-0'
  return {
    id,
    engine: 'glm',
    label: 'job-0',
    cwd: '/Users/x/code/repo',
    status: 'running',
    startedAt: NOW,
    endedAt: null,
    diffStat: '',
    activity: '',
    threadRoot: id,
    ...overrides,
  }
}

describe('toAgentJob', () => {
  test('maps a jobs-list row including currentActivity and threadRoot', () => {
    const mapped = toAgentJob({
      id: 'abcdef01-2345',
      engine: 'claude',
      label: 'panel-work',
      cwd: '/Users/x/code/mission-control',
      status: 'running',
      startedAt: NOW,
      endedAt: null,
      diffStat: '2 files changed',
      currentActivity: 'Edit · client/agents.ts',
      threadRoot: 'root-1',
    })

    expect(mapped).toEqual({
      id: 'abcdef01-2345',
      engine: 'claude',
      label: 'panel-work',
      cwd: '/Users/x/code/mission-control',
      status: 'running',
      startedAt: NOW,
      endedAt: null,
      diffStat: '2 files changed',
      activity: 'Edit · client/agents.ts',
      threadRoot: 'root-1',
    })
  })

  test('defaults threadRoot to its own id for an original dispatch', () => {
    const mapped = toAgentJob({ id: 'solo-job' })
    expect(mapped.threadRoot).toBe('solo-job')
  })

  test('falls back to a short id label and safe defaults on a sparse row', () => {
    const mapped = toAgentJob({ id: 'abcdef0123456789' })

    expect(mapped.label).toBe('abcdef01')
    expect(mapped.engine).toBe('?')
    expect(mapped.status).toBe('unknown')
    expect(mapped.startedAt).toBeNull()
    expect(mapped.activity).toBe('')
  })

  test('rejects non-finite and wrongly typed numeric fields', () => {
    const mapped = toAgentJob({ id: 'x', startedAt: Number.NaN, endedAt: '12' })

    expect(mapped.startedAt).toBeNull()
    expect(mapped.endedAt).toBeNull()
  })

  test('shortId truncates to eight characters', () => {
    expect(shortId('abcdef0123456789')).toBe('abcdef01')
    expect(shortId('abc')).toBe('abc')
  })
})

describe('formatElapsed', () => {
  test('renders seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(999)).toBe('0s')
    expect(formatElapsed(45_000)).toBe('45s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  test('renders minutes with zero-padded seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m00s')
    expect(formatElapsed(125_000)).toBe('2m05s')
    expect(formatElapsed(3_599_000)).toBe('59m59s')
  })

  test('renders hours with zero-padded minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1h00m')
    expect(formatElapsed(3_600_000 + 4 * 60_000)).toBe('1h04m')
    expect(formatElapsed(25 * 3_600_000)).toBe('25h00m')
  })

  test('clamps a negative span to zero', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})

describe('jobElapsed', () => {
  test('runs live off now while a job is running', () => {
    expect(jobElapsed(job(), NOW + 90_000)).toBe('1m30s')
  })

  test('freezes at endedAt once a job finished', () => {
    expect(jobElapsed(job({ status: 'done', endedAt: NOW + 30_000 }), NOW + 900_000)).toBe('30s')
  })

  test('shows a dash when the job never started', () => {
    expect(jobElapsed(job({ startedAt: null }), NOW)).toBe('—')
  })
})

describe('splitAgents', () => {
  const rows: AgentJob[] = [
    job({ id: 'r1', status: 'running', startedAt: NOW - 10 }),
    job({ id: 'd1', status: 'done', startedAt: NOW - 20 }),
    job({ id: 'r2', status: 'running', startedAt: NOW - 5 }),
    job({ id: 'f1', status: 'failed', startedAt: NOW - 1 }),
  ]

  test('splits running from finished and orders both newest first, one thread per row', () => {
    const groups = splitAgents(rows)

    expect(groups.running.map((entry) => entry.threadRoot)).toEqual(['r2', 'r1'])
    expect(groups.recent.map((entry) => entry.threadRoot)).toEqual(['f1', 'd1'])
  })

  test('does not mutate the input order', () => {
    const input = [...rows]
    splitAgents(input)
    expect(input.map((entry) => entry.id)).toEqual(['r1', 'd1', 'r2', 'f1'])
  })

  test(`keeps at most ${RECENT_LIMIT} recent threads, dropping the oldest`, () => {
    const many = Array.from({ length: 12 }, (_unused, index) =>
      job({ id: `done-${index}`, status: 'done', startedAt: NOW + index }),
    )
    const groups = splitAgents(many)

    expect(groups.recent.length).toBe(RECENT_LIMIT)
    expect(groups.recent[0]?.threadRoot).toBe('done-11')
    expect(groups.recent.at(-1)?.threadRoot).toBe('done-4')
  })

  test('treats a missing startedAt as oldest', () => {
    const groups = splitAgents([job({ id: 'none', startedAt: null }), job({ id: 'has' })])
    expect(groups.running.map((entry) => entry.threadRoot)).toEqual(['has', 'none'])
  })

  test('returns empty groups for no jobs', () => {
    expect(splitAgents([])).toEqual({ running: [], recent: [] })
  })

  describe('one card per thread', () => {
    test('a reply job collapses into its parent thread, keyed by threadRoot', () => {
      const opening = job({ id: 'root-1', threadRoot: 'root-1', status: 'done', startedAt: NOW - 100 })
      const reply = job({ id: 'reply-1', threadRoot: 'root-1', status: 'running', startedAt: NOW })

      const groups = splitAgents([opening, reply])

      expect(groups.running).toHaveLength(1)
      expect(groups.recent).toHaveLength(0)
      const thread = groups.running[0] as AgentThread
      expect(thread.threadRoot).toBe('root-1')
      expect(thread.jobCount).toBe(2)
    })

    test('status/elapsed/engine on the card come from the newest job in the thread', () => {
      const opening = job({
        id: 'root-2',
        threadRoot: 'root-2',
        status: 'done',
        engine: 'claude',
        startedAt: NOW - 100,
        endedAt: NOW - 90,
      })
      const reply = job({
        id: 'reply-2',
        threadRoot: 'root-2',
        status: 'running',
        engine: 'glm',
        startedAt: NOW,
      })

      const [thread] = splitAgents([opening, reply]).running as AgentThread[]

      expect(thread?.newestJob.id).toBe('reply-2')
      expect(thread?.newestJob.status).toBe('running')
      expect(thread?.newestJob.engine).toBe('glm')
    })

    test('a mixed running/done thread still exposes the running job as the KILL target', () => {
      const doneReply = job({ id: 'reply-3', threadRoot: 'root-3', status: 'done', startedAt: NOW })
      const stillRunning = job({
        id: 'root-3',
        threadRoot: 'root-3',
        status: 'running',
        startedAt: NOW - 100,
      })

      const [thread] = splitAgents([doneReply, stillRunning]).recent as AgentThread[]

      expect(thread?.newestJob.id).toBe('reply-3')
      expect(thread?.runningJob?.id).toBe('root-3')
    })

    test('a thread with nothing running has a null runningJob', () => {
      const opening = job({ id: 'root-4', threadRoot: 'root-4', status: 'done', startedAt: NOW - 10 })
      const reply = job({ id: 'reply-4', threadRoot: 'root-4', status: 'failed', startedAt: NOW })

      const [thread] = splitAgents([opening, reply]).recent as AgentThread[]

      expect(thread?.runningJob).toBeNull()
    })

    test('RECENT_LIMIT bounds distinct threads, not the jobs inside them', () => {
      const many = Array.from({ length: RECENT_LIMIT + 2 }, (_unused, index) => {
        const root = `root-${index}`
        return [
          job({ id: root, threadRoot: root, status: 'done', startedAt: NOW + index * 10 }),
          job({ id: `${root}-reply`, threadRoot: root, status: 'done', startedAt: NOW + index * 10 + 1 }),
        ]
      }).flat()

      const groups = splitAgents(many)

      expect(groups.recent).toHaveLength(RECENT_LIMIT)
      expect(new Set(groups.recent.map((thread) => thread.threadRoot)).size).toBe(RECENT_LIMIT)
    })
  })
})

describe('secondLine', () => {
  test('a running card shows what the agent is doing right now', () => {
    expect(secondLine(job({ status: 'running', activity: 'Bash · Run the test suite' }))).toBe(
      'Bash · Run the test suite',
    )
  })

  test('a running card with no activity yet falls back to the repo it works in', () => {
    expect(secondLine(job({ status: 'running', activity: '' }))).toBe('repo')
  })

  test('a finished card shows its diff, or a dash when nothing changed', () => {
    expect(secondLine(job({ status: 'done', diffStat: '3 files +40 -2' }))).toBe('3 files +40 -2')
    expect(secondLine(job({ status: 'done', diffStat: '' }))).toBe('—')
  })
})

describe('presentation helpers', () => {
  test('baseName reduces a cwd to its last segment', () => {
    expect(baseName('/Users/x/code/mission-control')).toBe('mission-control')
    expect(baseName('/Users/x/code/repo/')).toBe('repo')
    expect(baseName('repo')).toBe('repo')
    expect(baseName('')).toBe('')
  })

  test('accentClass maps each engine to its theme colour class', () => {
    expect(accentClass('claude')).toBe('c-claude')
    expect(accentClass('glm')).toBe('c-glm')
    expect(accentClass('codex')).toBe('c-white')
    expect(accentClass('unknown')).toBe('c-white')
  })

  test('statusGlyph marks running, done, failed and anything else', () => {
    expect(statusGlyph('running')).toBe('●')
    expect(statusGlyph('done')).toBe('✓')
    expect(statusGlyph('failed')).toBe('✕')
    expect(statusGlyph('weird')).toBe('·')
  })
})
