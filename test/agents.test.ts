import { describe, expect, test } from 'bun:test'

import {
  RECENT_LIMIT,
  TICKER_ROWS,
  accentClass,
  baseName,
  formatElapsed,
  jobElapsed,
  shortId,
  splitAgents,
  statusGlyph,
  tickerLines,
  toAgentJob,
  type AgentJob,
} from '../client/agents'

const NOW = 1_700_000_000_000

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job-0',
    engine: 'glm',
    label: 'job-0',
    cwd: '/Users/x/code/repo',
    status: 'running',
    startedAt: NOW,
    endedAt: null,
    diffStat: '',
    activity: '',
    ...overrides,
  }
}

describe('toAgentJob', () => {
  test('maps a jobs-list row including currentActivity', () => {
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
    })
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

  test('splits running from finished and orders both newest first', () => {
    const groups = splitAgents(rows)

    expect(groups.running.map((entry) => entry.id)).toEqual(['r2', 'r1'])
    expect(groups.recent.map((entry) => entry.id)).toEqual(['f1', 'd1'])
  })

  test('does not mutate the input order', () => {
    const input = [...rows]
    splitAgents(input)
    expect(input.map((entry) => entry.id)).toEqual(['r1', 'd1', 'r2', 'f1'])
  })

  test(`keeps at most ${RECENT_LIMIT} recent rows, dropping the oldest`, () => {
    const many = Array.from({ length: 12 }, (_unused, index) =>
      job({ id: `done-${index}`, status: 'done', startedAt: NOW + index }),
    )
    const groups = splitAgents(many)

    expect(groups.recent.length).toBe(RECENT_LIMIT)
    expect(groups.recent[0]?.id).toBe('done-11')
    expect(groups.recent.at(-1)?.id).toBe('done-4')
  })

  test('treats a missing startedAt as oldest', () => {
    const groups = splitAgents([job({ id: 'none', startedAt: null }), job({ id: 'has' })])
    expect(groups.running.map((entry) => entry.id)).toEqual(['has', 'none'])
  })

  test('returns empty groups for no jobs', () => {
    expect(splitAgents([])).toEqual({ running: [], recent: [] })
  })
})

describe('tickerLines', () => {
  const events = Array.from({ length: 9 }, (_unused, index) => ({
    kind: 'tool',
    title: 'Edit',
    detail: `file-${index}.ts`,
  }))

  test(`keeps the newest ${TICKER_ROWS} events, newest first`, () => {
    const lines = tickerLines(events)

    expect(lines.length).toBe(TICKER_ROWS)
    expect(lines.map((line) => line.detail)).toEqual([
      'file-8.ts',
      'file-7.ts',
      'file-6.ts',
      'file-5.ts',
      'file-4.ts',
    ])
  })

  test('passes a shorter feed through untouched apart from ordering', () => {
    expect(tickerLines(events.slice(0, 2)).map((line) => line.detail)).toEqual([
      'file-1.ts',
      'file-0.ts',
    ])
    expect(tickerLines([])).toEqual([])
  })

  test('defaults a missing kind to text and blanks missing strings', () => {
    expect(tickerLines([{ title: 42 }])).toEqual([{ kind: 'text', title: '', detail: '' }])
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
    expect(statusGlyph('running')).toBe('▸')
    expect(statusGlyph('done')).toBe('✓')
    expect(statusGlyph('failed')).toBe('✕')
    expect(statusGlyph('weird')).toBe('·')
  })
})
