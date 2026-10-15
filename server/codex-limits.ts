import { spawn } from 'node:child_process'
import { resolveBinary } from './engines'
import { requestOverStdio, type StdioSpawner } from './stdio-rpc'

export type UsageLimits = {
  fiveHourPct?: number | null
  weeklyPct?: number | null
  fiveHourResetsAt?: string | null
  weeklyResetsAt?: string | null
  source?: string
  observedAt?: string
  reason?: string
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const usagePercent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
export function resetIso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!parts) return null
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}
export function parseCodexLimits(value: unknown): UsageLimits {
  const data = record(value), buckets = record(data.rateLimitsByLimitId), legacy = record(data.rateLimits)
  const bucket = record(buckets.codex ?? (legacy.limitId === 'codex' || (!Object.keys(buckets).length && (!legacy.limitId || legacy.limitId === 'codex')) ? legacy : null))
  const result: UsageLimits = { fiveHourPct: null, weeklyPct: null, fiveHourResetsAt: null, weeklyResetsAt: null }
  for (const raw of [bucket.primary, bucket.secondary]) {
    const window = record(raw)
    const key = window.windowDurationMins === 300 ? 'fiveHour' : window.windowDurationMins === 10080 ? 'weekly' : null
    if (!key) continue
    result[`${key}Pct`] = usagePercent(window.usedPercent)
    const milliseconds = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt >= 0 ? window.resetsAt * 1000 : NaN
    result[`${key}ResetsAt`] = Number.isFinite(new Date(milliseconds).getTime()) ? new Date(milliseconds).toISOString() : null
  }
  if (result.fiveHourPct === null || result.weeklyPct === null) result.reason = 'Some usage windows are unavailable'
  return result
}
export async function readCodexLimits(
  launch: StdioSpawner = () => spawn(resolveBinary('codex'), ['app-server', '--stdio'], { stdio: 'pipe' }),
  timeoutMs = 4000,
): Promise<UsageLimits> {
  try {
    return parseCodexLimits(await requestOverStdio(launch, {
      initialize: { method: 'initialize', params: { clientInfo: { name: 'shikidan-quota', version: '1.0.0' }, capabilities: { experimentalApi: true } } },
      afterInitialize: { method: 'initialized' },
      request: { method: 'account/rateLimits/read', params: {} },
    }, timeoutMs))
  } catch {
    return { fiveHourPct: null, weeklyPct: null, fiveHourResetsAt: null, weeklyResetsAt: null, reason: 'Codex usage limits unavailable' }
  }
}
