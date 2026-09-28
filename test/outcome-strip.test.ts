import { describe, expect, test } from 'bun:test'

import { capacity, mergeOutcomes, relativeTime, whoText, type Outcome } from '../client/outcome-strip'

const outcome = (seq: number, fields: Partial<Outcome> = {}): Outcome => ({ seq, at: 0, ok: true, kind: 'command', tool: 'Bash', target: 'ls', result: 'Passed', detail: '', actor: { by: 'main', label: 'Main agent', engine: 'claude' }, ...fields })

describe('capacity', () => {
  test('fits 10px squares with 3px gaps, never negative', () => {
    expect(capacity(10)).toBe(1)
    expect(capacity(23)).toBe(2)
    expect(capacity(22)).toBe(1)
    expect(capacity(0)).toBe(0)
  })
})

describe('relativeTime', () => {
  test('reads just now, minutes, hours and days', () => {
    expect(relativeTime(0, 30_000)).toBe('just now')
    expect(relativeTime(0, 8 * 60_000)).toBe('8m ago')
    expect(relativeTime(0, 3 * 3_600_000)).toBe('3h ago')
    expect(relativeTime(0, 2 * 86_400_000)).toBe('2d ago')
    expect(relativeTime(10_000, 0)).toBe('just now')
  })
})

describe('whoText', () => {
  test('spawned jobs and agents read as started by the main agent; actions name their actor', () => {
    expect(whoText(outcome(1, { tool: 'Job', actor: { by: 'spawned', label: 'Job · export', engine: 'codex' } }))).toBe('Started by the main agent')
    expect(whoText(outcome(1, { actor: { by: 'spawned', label: 'Sub-agent · review', engine: 'claude' } }))).toBe('Sub-agent · review')
  })
})

describe('mergeOutcomes', () => {
  test('appends only newer seqs, so a repeated page never doubles a square', () => {
    const current = [outcome(1), outcome(2)]
    expect(mergeOutcomes(current, [outcome(2), outcome(3)]).map((item) => item.seq)).toEqual([1, 2, 3])
  })
  test('keeps at most the newest 500', () => {
    const many = Array.from({ length: 600 }, (_, index) => outcome(index + 1))
    const merged = mergeOutcomes([], many)
    expect(merged).toHaveLength(500)
    expect(merged[0]?.seq).toBe(101)
  })
})
