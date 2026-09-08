import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveBinary } from './engines'

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
export type CodexSpawner = () => ChildProcessWithoutNullStreams
export async function readCodexLimits(
  launch: CodexSpawner = () => spawn(resolveBinary('codex'), ['app-server', '--stdio'], { stdio: 'pipe' }),
  timeoutMs = 4000,
): Promise<UsageLimits> {
  let child: ChildProcessWithoutNullStreams | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<UsageLimits>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      child = launch()
      const proc = child
      let pending = '', initialized = false
      const fail = () => reject(new Error('unavailable'))
      const send = (value: unknown) => proc.stdin.write(JSON.stringify(value) + '\n')
      proc.on('error', fail)
      proc.on('exit', fail)
      proc.stdout.on('end', fail)
      proc.stdout.on('error', fail)
      proc.stdin.on('error', fail)
      proc.stderr.on('error', fail)
      proc.stderr.resume()
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        pending += chunk
        if (pending.length > 1_000_000) { fail(); return }
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          let message: Record<string, unknown>
          try { message = record(JSON.parse(line)) } catch { continue }
          if (message.id !== (initialized ? 2 : 1)) continue
          if (message.error || !('result' in message)) { fail(); return }
          if (!initialized) {
            initialized = true
            send({ method: 'initialized' })
            send({ id: 2, method: 'account/rateLimits/read', params: {} })
          } else { resolve(parseCodexLimits(message.result)); return }
        }
      })
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mission-control-quota', version: '1.0.0' }, capabilities: { experimentalApi: true } } })
    })
  } catch {
    return { fiveHourPct: null, weeklyPct: null, fiveHourResetsAt: null, weeklyResetsAt: null, reason: 'Codex usage limits unavailable' }
  } finally {
    clearTimeout(timer)
    if (child) { child.stdin.end(); child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null) child.kill('SIGKILL') }
  }
}
