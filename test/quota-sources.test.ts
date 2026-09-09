import { normalizeUsage } from '../client/provider-usage'
import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseCodexLimits, readCodexLimits, resetIso } from '../server/codex-limits'
import { fetchClaudeQuota, fetchCodexQuota, parseClaudeCache } from '../server/quota'
const weekly = { windowDurationMins: 10080, usedPercent: 9, resetsAt: 1800000000 }
const five = { windowDurationMins: 300, usedPercent: 0, resetsAt: 1800000001 }
test('Codex matches duration regardless of position and keeps weekly-only missing 5h', () => {
  expect(parseCodexLimits({ rateLimitsByLimitId: { codex: { primary: weekly, secondary: five } } })).toMatchObject({ fiveHourPct: 0, weeklyPct: 9, weeklyResetsAt: new Date(1800000000000).toISOString() })
  expect(parseCodexLimits({ rateLimits: { primary: weekly } })).toMatchObject({ fiveHourPct: null, weeklyPct: 9 })
  expect(parseCodexLimits({ rateLimitsByLimitId: { other: { primary: five } }, rateLimits: { primary: five } }).fiveHourPct).toBeNull()
  expect(parseCodexLimits({ rateLimits: { limitId: 'other', primary: five } }).fiveHourPct).toBeNull()
  expect(parseCodexLimits({ rateLimitsByLimitId: { codex: { primary: weekly } }, rateLimits: { primary: five } }).fiveHourPct).toBeNull()
})
test('malformed percentages and timestamps never become zero or valid dates', () => {
  for (const value of [-1, 101, NaN, Infinity, '9', null]) {
    expect(parseCodexLimits({ rateLimits: { primary: { ...five, usedPercent: value, resetsAt: 'tomorrow' } } })).toMatchObject({ fiveHourPct: null, fiveHourResetsAt: null })
  }
  for (const resetsAt of [Infinity, -1, 1e30, null]) expect(parseCodexLimits({ rateLimits: { primary: { ...weekly, resetsAt } } }).weeklyResetsAt).toBeNull()
})
function transport(mode: 'success' | 'error' | 'eof' | 'timeout' | 'process-error') {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false, kill() { this.killed = true; return true } })
  const sent: any[] = []
  child.stdin.on('data', data => {
    const message = JSON.parse(data.toString()); sent.push(message)
    if (mode === 'timeout') return
    queueMicrotask(() => {
      if (mode === 'eof') { child.stdout.end(); return }
      if (mode === 'process-error') { child.emit('error', new Error('SECRET')); return }
      if (message.id === 1) {
        child.stdout.write('{"method":"notice"}\n{"id":88,"result":{}}\n{"id":1,')
        child.stdout.write('"result":{}}\n')
      }
      if (message.id === 2) child.stdout.write(JSON.stringify(mode === 'error' ? { id: 2, error: { message: 'SECRET' } } : { id: 2, result: { rateLimits: { primary: weekly } } }) + '\n')
    })
  })
  return { child, sent, launch: () => child as unknown as ChildProcessWithoutNullStreams }
}
test('RPC handshake filters IDs and notifications, handles chunks, cleans up only its child', async () => {
  const h = transport('success')
  expect(await readCodexLimits(h.launch, 100)).toMatchObject({ weeklyPct: 9, fiveHourPct: null })
  expect(h.sent.map(value => value.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
  expect(h.sent[0].params.capabilities.experimentalApi).toBe(true)
  expect(h.child.killed).toBe(true)
  expect(h.child.stdin.writableEnded).toBe(true)
})
for (const mode of ['error', 'eof', 'timeout', 'process-error'] as const) test(`RPC ${mode} is bounded, sanitized and cleaned up`, async () => {
  const h = transport(mode)
  const result = await readCodexLimits(h.launch, 10)
  expect(result.reason).toBe('Codex usage limits unavailable')
  expect(h.child.killed).toBe(true)
  expect(h.child.stdin.writableEnded).toBe(true)
  expect(JSON.stringify(result)).not.toContain('SECRET')
})
test('RPC startup failure is sanitized', async () => {
  expect((await readCodexLimits(() => { throw new Error('SECRET') }, 10)).reason).toBe('Codex usage limits unavailable')
})
const now = new Date('2026-09-08T06:00:00Z')
const raw = JSON.stringify({ sessionUsage: 24, weeklyUsage: 12, sessionResetAt: '2026-09-08T07:00:00Z', weeklyResetAt: 'bad' })
test('Claude cache uses mtime freshness, real zeros and validated resets', () => {
  expect(parseClaudeCache({ raw, mtimeMs: +now - 180000 }, now)).toMatchObject({ fiveHourPct: 24, weeklyPct: 12, weeklyResetsAt: null, source: 'ccstatusline cache', observedAt: new Date(+now - 180000).toISOString() })
  expect(parseClaudeCache({ raw, mtimeMs: +now - 11 * 3600_000 }, now)).toMatchObject({ fiveHourPct: 24, observedAt: new Date(+now - 11 * 3600_000).toISOString() })
  for (const mtimeMs of [+now - 12 * 3600_000 - 1, +now + 1, NaN]) expect(parseClaudeCache({ raw, mtimeMs }, now)).toBeNull()
  for (const value of [null, { raw: '{', mtimeMs: +now }, { raw: '{"sessionUsage":101}', mtimeMs: +now }]) expect(parseClaudeCache(value, now)).toBeNull()
  expect(parseClaudeCache({ raw: '{"sessionUsage":0}', mtimeMs: +now }, now)?.fiveHourPct).toBe(0)
})
test('cache enrichment preserves ccusage accounting and missing cache retains estimate', async () => {
  const run = async () => ({ exitCode: 0, stdout: JSON.stringify({ blocks: [{ isActive: true, totalTokens: 100, costUSD: 2, tokenLimitStatus: { percentUsed: 17 }, modelBreakdowns: [{ modelName: 'claude-x', inputTokens: 70, outputTokens: 30, cost: 2 }] }] }) })
  const baseline = await fetchClaudeQuota(run, now)
  const cached = await fetchClaudeQuota(run, now, async () => ({ raw, mtimeMs: +now }))
  expect(cached).toMatchObject({ ...baseline, fiveHourPct: 24, weeklyPct: 12 })
  expect(await fetchClaudeQuota(run, now, async () => { throw new Error('missing') })).toEqual(baseline)
  expect(await fetchClaudeQuota(run, now, async () => ({ raw, mtimeMs: +now - 12 * 3600_000 - 1 }))).toEqual(baseline)
})
test('quota source failure preserves Codex authentication status', async () => {
  expect(await fetchCodexQuota(async () => ({ exitCode: 0, stdout: 'private' }), async () => { throw new Error('SECRET') })).toEqual({ available: true, authed: true, reason: 'Codex usage limits unavailable' })
})

test('cache reset strings reject calendar overflow and incomplete timestamps', () => {
  for (const value of ['2026-02-30T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T01:00:00','tomorrow']) expect(resetIso(value)).toBeNull()
  expect(resetIso('2026-09-08T13:00:00+07:00')).toBe('2026-09-08T06:00:00.000Z')
})
test('fresh cached limits remain usable when ccusage accounting fails', async () => {
  expect(await fetchClaudeQuota(async () => ({exitCode:1,stdout:''}), now, async () => ({raw,mtimeMs:+now}))).toMatchObject({available:true,tokens:null,costUSD:null,fiveHourPct:24,weeklyPct:12,source:'ccstatusline cache'})
})

test('collector and normalizer retain fresh actual limits without accounting', async () => {
  const collected = await fetchClaudeQuota(async () => ({exitCode:1,stdout:''}), now, async () => ({raw:'{"sessionUsage":34,"weeklyUsage":51}',mtimeMs:+now}))
  expect(collected).toMatchObject({tokens:null,costUSD:null})
  expect(normalizeUsage('claude', collected)).toMatchObject({fiveHour:{percent:34,estimate:false},weekly:{percent:51,estimate:false}})
})
