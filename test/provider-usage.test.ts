import { expect, test } from 'bun:test'
import { ageLabel, normalizeUsage, renderUsage } from '../client/provider-usage'
test('missing windows stay unavailable, including monthly GLM and authenticated Codex', () => {
  expect(normalizeUsage('glm',{available:true,monthlyPct:70,fiveHourPct:28}).weekly.percent).toBeNull()
  expect(normalizeUsage('codex',{available:true,authed:true}).fiveHour.percent).toBeNull()
  expect(normalizeUsage('claude',{available:true,blockPercent:null}).fiveHour.percent).toBeNull()
})
test('Claude fallback is a nullable ccusage estimate and actual additive windows win', () => {
  expect(normalizeUsage('claude',{available:true,blockPercent:24,resetsAt:null}).fiveHour).toEqual({percent:24,reset:null,estimate:true})
  const value = normalizeUsage('claude',{available:true,blockPercent:24,fiveHourPct:0,weeklyPct:12,fiveHourResetsAt:'today',weeklyResetsAt:'Monday'})
  expect(value.fiveHour).toEqual({percent:0,reset:'today',estimate:false})
  expect(value.weekly).toEqual({percent:12,reset:'Monday',estimate:false})
})
test('unavailable and malformed records never produce fake percentages', () => {
  for (const raw of [null,{available:false,fiveHourPct:10},{available:true,fiveHourPct:NaN,weeklyPct:101},{available:true,fiveHourPct:'20',weeklyPct:-1}]) {
    const value = normalizeUsage('codex',raw); expect(value.fiveHour.percent).toBeNull(); expect(value.weekly.percent).toBeNull()
  }
})

test('Codex shows the weekly window as its headline and skips the weekly row', () => {
  const make = (): any => ({ children: [] as any[], dataset: {} as Record<string, string>, append(...nodes: any[]) { this.children.push(...nodes) }, replaceChildren(...nodes: any[]) { this.children = nodes }, setAttribute() {} })
  ;(globalThis as any).document = { createElement: make }
  const host = make()
  renderUsage(host, [normalizeUsage('codex',{available:true,fiveHourPct:61,weeklyPct:34}), normalizeUsage('claude',{available:true,fiveHourPct:24,weeklyPct:12})])
  const [codex, claude] = host.children
  expect(codex.children.length).toBe(2)
  expect(codex.children[0].children[1].textContent).toBe('Weekly')
  expect(codex.children[0].children[2].textContent).toBe('34')
  expect(codex.children[1].value).toBe(34)
  expect(claude.children.length).toBe(3)
  expect(claude.children[0].children[1].textContent).toBe('5h')
  renderUsage(host, [normalizeUsage('glm', null)])
  const [glm] = host.children
  expect(glm.dataset.unavailable).toBe('true')
  expect(glm.children[1].className).toBe('quota-track')
  expect(glm.title).toBe('Usage unavailable')
  delete (globalThis as any).document
})

test('age label appears only once the observation is older than three minutes', () => {
  const now = Date.parse('2026-09-09T02:00:00.000Z')
  expect(ageLabel(null, now)).toBeNull()
  expect(ageLabel('2026-09-09T01:58:30.000Z', now)).toBeNull()
  expect(ageLabel('2026-09-09T01:46:00.000Z', now)).toBe('14m ago')
  expect(ageLabel('2026-09-08T23:00:00.000Z', now)).toBe('3h ago')
  expect(normalizeUsage('claude', { available: true, fiveHourPct: 24, source: 'ccstatusline cache', observedAt: '2026-09-09T01:46:00.000Z' }).observedAt).toBe('2026-09-09T01:46:00.000Z')
})
