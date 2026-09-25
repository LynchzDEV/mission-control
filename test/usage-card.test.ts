import { describe, expect, test } from 'bun:test'
import { scrollPlan, usageItems } from '../client/usage-card'
import { normalizeUsage } from '../client/provider-usage'

describe('usageItems', () => {
  test('one item per provider with logo path, primary percent and weekly percent', () => {
    const items = usageItems([normalizeUsage('claude', { available: true, fiveHourPct: 42, weeklyPct: 61 }), normalizeUsage('codex', { available: true, weeklyPct: 73 })])
    expect(items).toEqual([
      { provider: 'claude', name: 'Claude', logo: '/providers/claude.svg', period: '5h', primary: '42%', primaryPercent: 42, weekly: '61%', weeklyPercent: 61, unavailable: false },
      { provider: 'codex', name: 'Codex', logo: '/providers/codex.svg', period: 'Week', primary: '73%', primaryPercent: 73, weekly: null, weeklyPercent: null, unavailable: false },
    ])
  })
  test('renders unavailable providers as dashes', () => {
    const [item] = usageItems([normalizeUsage('glm', { available: false, reason: 'no token' })])
    expect(item).toMatchObject({ name: 'GLM', primary: '—', weekly: '—', unavailable: true })
  })
})

describe('scrollPlan', () => {
  test('goes out, pauses 5s, comes back, pauses 5s', () => {
    const frames = scrollPlan(140, 14)
    expect(frames.map(f => f.transform)).toEqual(['translateX(0)', 'translateX(-140px)', 'translateX(-140px)', 'translateX(0)', 'translateX(0)'])
    const total = (140 / 14) * 1000 * 2 + 10000
    expect(frames[1]!.offset).toBeCloseTo(10000 / total)
    expect(frames[2]!.offset).toBeCloseTo(15000 / total)
  })
})
