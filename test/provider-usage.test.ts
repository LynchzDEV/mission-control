import { expect, test } from 'bun:test'
import { normalizeUsage } from '../client/provider-usage'
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
