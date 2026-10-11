import { spawn } from 'node:child_process'
import { resetIso, usagePercent, type UsageLimits } from './codex-limits'
import { resolveBinary } from './engines'
import { requestOverStdio, type StdioSpawner } from './stdio-rpc'

const UNAVAILABLE = 'Grok usage limits unavailable'
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function parseGrokLimits(value: unknown): UsageLimits {
  const config = record(record(value).config)
  const weeklyPct = usagePercent(config.creditUsagePercent)
  const result: UsageLimits = { fiveHourPct: null, weeklyPct, fiveHourResetsAt: null, weeklyResetsAt: resetIso(record(config.currentPeriod).end) }
  return weeklyPct === null ? { ...result, reason: UNAVAILABLE } : result
}

export async function readGrokLimits(
  launch: StdioSpawner = () => spawn(resolveBinary('grok'), ['agent', 'stdio'], { stdio: 'pipe' }),
  timeoutMs = 5000,
): Promise<UsageLimits> {
  try {
    return parseGrokLimits(await requestOverStdio(launch, {
      initialize: { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      request: { jsonrpc: '2.0', method: '_x.ai/billing', params: {} },
    }, timeoutMs))
  } catch {
    return { fiveHourPct: null, weeklyPct: null, fiveHourResetsAt: null, weeklyResetsAt: null, reason: UNAVAILABLE }
  }
}
