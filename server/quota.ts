import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCodexLimits, resetIso, usagePercent, type UsageLimits } from './codex-limits'
import { resolveBinary } from './engines'
import type { Secrets } from './secrets'

type ClaudeEstimate =
  | (UsageLimits & {
      available: true
      active: boolean
      tokens: number
      otherTokens: number
      nonCacheTokens?: number | null
      costUSD: number | null
      resetsAt: string | null
      blockPercent: number | null
    })
  | { available: false; reason: string }

export type ClaudeQuota = ClaudeEstimate | (UsageLimits & { available: true; active: false; tokens: null; otherTokens: null; costUSD: null; resetsAt: null; blockPercent: null })

export type GlmQuota =
  | { available: true; fiveHourPct: number; monthlyPct: number | null }
  | { available: false; reason: string }

export type CodexQuota = (UsageLimits & { available: true; authed: boolean }) | { available: false; reason: string }

export type PeakInfo = { peak: boolean; minutesToChange: number }

export type ExternalEngine = 'claude' | 'codex'

export type ExternalSession = { pid: number; engine: ExternalEngine; etime: string; cwdHint: string | null }

export type QuotaComposite = {
  claude: ClaudeQuota
  glm: GlmQuota
  codex: CodexQuota
  peak: PeakInfo
}

export type CommandResult = { stdout: string; exitCode: number }
export type CommandRunner = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<CommandResult>

async function runCommand(cmd: string[], opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
  const [command, ...args] = cmd
  if (command === undefined) return { stdout: '', exitCode: 1 }

  const proc = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 10_000)
  try {
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { stdout, exitCode }
  } finally {
    clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readNonCacheTokens(block: Record<string, unknown>): number | null {
  const counts = block.tokenCounts
  if (!isRecord(counts)) return null
  const input = typeof counts.inputTokens === 'number' ? counts.inputTokens : null
  const output = typeof counts.outputTokens === 'number' ? counts.outputTokens : null
  if (input === null && output === null) return null
  return (input ?? 0) + (output ?? 0)
}

function readBlockPercent(block: Record<string, unknown>): number | null {
  const status = block.tokenLimitStatus
  if (!isRecord(status) || typeof status.percentUsed !== 'number') return null
  return status.percentUsed
}

function readModelBreakdown(entry: Record<string, unknown>) {
  if (!Array.isArray(entry.modelBreakdowns)) return null
  let tokens = 0
  let otherTokens = 0
  let costUSD = 0
  let otherCostUSD = 0
  let nonCacheTokens = 0
  for (const row of entry.modelBreakdowns) {
    if (!isRecord(row)) continue
    const count = (key: string) => typeof row[key] === 'number' ? row[key] : 0
    const total = count('inputTokens') + count('outputTokens') + count('cacheCreationTokens') + count('cacheReadTokens')
    if (typeof row.modelName === 'string' && row.modelName.startsWith('claude-')) {
      tokens += total
      costUSD += count('cost')
      nonCacheTokens += count('inputTokens') + count('outputTokens')
    } else {
      otherTokens += total
      otherCostUSD += count('cost')
    }
  }
  return { tokens, otherTokens, costUSD, otherCostUSD, nonCacheTokens }
}

export function parseCcusageBlocksJson(raw: string): ClaudeEstimate {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) {
      return { available: false, reason: 'unexpected ccusage blocks shape' }
    }
    const active = parsed.blocks.find((block) => isRecord(block) && block.isActive === true)
    if (active === undefined) {
      return {
        available: true, active: false, tokens: 0, otherTokens: 0,
        costUSD: null, resetsAt: null, blockPercent: null, nonCacheTokens: null,
      }
    }
    const breakdown = readModelBreakdown(active)
    const tokens = typeof active.totalTokens === 'number' ? active.totalTokens : 0
    const costUSD = typeof active.costUSD === 'number' ? active.costUSD : null
    const resetsAt = typeof active.endTime === 'string' ? active.endTime : null
    return {
      available: true,
      active: true,
      tokens: breakdown?.tokens ?? tokens,
      otherTokens: breakdown?.otherTokens ?? 0,
      costUSD: breakdown?.costUSD ?? costUSD,
      resetsAt,
      blockPercent: readBlockPercent(active),
      nonCacheTokens: breakdown?.nonCacheTokens ?? readNonCacheTokens(active),
    }
  } catch {
    return { available: false, reason: 'malformed ccusage blocks json' }
  }
}

export function parseCcusageDailyJson(raw: string): ClaudeEstimate {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.daily) || parsed.daily.length === 0) {
      return { available: false, reason: 'unexpected ccusage daily shape' }
    }
    const latest = parsed.daily[parsed.daily.length - 1]
    if (!isRecord(latest)) return { available: false, reason: 'unexpected ccusage daily entry shape' }
    const breakdown = readModelBreakdown(latest)
    const tokens = typeof latest.totalTokens === 'number' ? latest.totalTokens : 0
    const costUSD = typeof latest.totalCost === 'number' ? latest.totalCost : null
    return {
      available: true,
      active: false,
      tokens: breakdown?.tokens ?? tokens,
      otherTokens: breakdown?.otherTokens ?? 0,
      costUSD: breakdown?.costUSD ?? costUSD,
      resetsAt: null,
      blockPercent: null,
    }
  } catch {
    return { available: false, reason: 'malformed ccusage daily json' }
  }
}

async function fetchClaudeEstimate(run: CommandRunner, now: Date): Promise<ClaudeEstimate> {
  let blockQuota: ClaudeEstimate | null = null
  try {
    const blocks = await run(['npx', 'ccusage@latest', 'blocks', '--json', '--breakdown'], { timeoutMs: 10_000 })
    if (blocks.exitCode === 0) {
      const parsed = parseCcusageBlocksJson(blocks.stdout)
      if (parsed.available) {
        const active = JSON.parse(blocks.stdout).blocks.find(
          (block: unknown) => isRecord(block) && block.isActive === true,
        )
        if (!parsed.active || (isRecord(active) && readModelBreakdown(active) !== null)) return parsed
        blockQuota = parsed
      }
    }
  } catch {}

  try {
    const since = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
    const daily = await run(
      ['npx', 'ccusage@latest', 'daily', '--json', '--breakdown', '--since', since],
      { timeoutMs: 10_000 },
    )
    if (daily.exitCode === 0) {
      const parsed = parseCcusageDailyJson(daily.stdout)
      if (blockQuota?.available && parsed.available) {
        const latest = JSON.parse(daily.stdout).daily.at(-1)
        const breakdown = isRecord(latest) ? readModelBreakdown(latest) : null
        if (breakdown === null) return blockQuota
        const totalTokens = breakdown.tokens + breakdown.otherTokens
        if (totalTokens === 0) return blockQuota
        const share = breakdown.tokens / totalTokens
        const tokens = Math.round(blockQuota.tokens * share)
        const totalCost = breakdown.costUSD + breakdown.otherCostUSD
        const costShare = totalCost > 0 ? breakdown.costUSD / totalCost : share
        return {
          ...blockQuota,
          tokens,
          otherTokens: blockQuota.tokens - tokens,
          costUSD: blockQuota.costUSD === null ? null : blockQuota.costUSD * costShare,
          nonCacheTokens: blockQuota.nonCacheTokens == null ? null : Math.round(blockQuota.nonCacheTokens * share),
          blockPercent: blockQuota.blockPercent === null ? null : blockQuota.blockPercent * share,
        }
      }
      if (parsed.available) return parsed
    }
  } catch {}

  return blockQuota ?? { available: false, reason: 'ccusage unavailable' }
}

export function zaiOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.protocol}//${url.host}`
  } catch {
    return baseUrl
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatZaiDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

export function glmUsageWindow(now: Date): { startTime: string; endTime: string } {
  return { startTime: formatZaiDateTime(new Date(now.getTime() - DAY_MS)), endTime: formatZaiDateTime(now) }
}

type GlmLimitPercentages = { fiveHourPct: number; monthlyPct: number | null }

export function parseGlmLimitPayload(payload: unknown): GlmLimitPercentages | null {
  if (!isRecord(payload)) return null
  const container = isRecord(payload.data) ? payload.data : payload
  const limits = container.limits
  if (!Array.isArray(limits)) return null

  let fiveHourPct: number | null = null
  let monthlyPct: number | null = null
  const creditEntries: Array<Record<string, unknown>> = []
  for (const item of limits) {
    if (!isRecord(item) || typeof item.percentage !== 'number') continue
    if (item.type === 'TOKENS_LIMIT') fiveHourPct = item.percentage
    if (item.type === 'TIME_LIMIT') monthlyPct = item.percentage
    if (item.type === 'CREDIT_LIMIT') creditEntries.push(item)
  }

  // 2026-08 schema: CREDIT_LIMIT rows; unit 3 = hour window (number 5 → 5h), unit 6 = month.
  if (fiveHourPct === null) {
    for (const item of creditEntries) {
      const pct = item.percentage as number
      if (item.unit === 3) fiveHourPct = pct
      else if (item.unit === 6) monthlyPct = monthlyPct ?? pct
    }
    if (fiveHourPct === null && creditEntries.length > 0) {
      fiveHourPct = creditEntries[0].percentage as number
    }
  }

  if (fiveHourPct === null) return null
  return { fiveHourPct, monthlyPct }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export async function fetchGlmQuota(
  secrets: Secrets,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
): Promise<GlmQuota> {
  if (secrets.zaiAuthToken === null || secrets.zaiAuthToken === '') {
    return { available: false, reason: 'zaiAuthToken not configured' }
  }

  const origin = zaiOrigin(secrets.zaiBaseUrl)
  const headers = { Authorization: secrets.zaiAuthToken, 'Accept-Language': 'en-US,en' }

  try {
    const limitResponse = await fetchImpl(`${origin}/api/monitor/usage/quota/limit`, { headers })
    if (!limitResponse.ok) return { available: false, reason: `quota/limit responded ${limitResponse.status}` }

    const limitJson: unknown = await limitResponse.json()
    const parsed = parseGlmLimitPayload(limitJson)
    if (parsed === null) return { available: false, reason: 'unexpected quota/limit response shape' }

    const { startTime, endTime } = glmUsageWindow(now)
    const modelUsageUrl =
      `${origin}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(startTime)}` +
      `&endTime=${encodeURIComponent(endTime)}`
    // Fetched per spec for parity with the reference plugin; failures here never block the percentages above.
    await fetchImpl(modelUsageUrl, { headers }).catch(() => null)

    return { available: true, fiveHourPct: parsed.fiveHourPct, monthlyPct: parsed.monthlyPct }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : 'glm quota network error' }
  }
}

export type ClaudeCacheReader = () => Promise<{ raw: string; mtimeMs: number } | null>
const readClaudeCache: ClaudeCacheReader = async () => {
  const path = join(homedir(), '.cache/ccstatusline/usage.json')
  const info = await stat(path)
  if (info.size > 64_000) return null
  return { raw: await readFile(path, 'utf8'), mtimeMs: info.mtimeMs }
}
export const CLAUDE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000
export function parseClaudeCache(cache: { raw: string; mtimeMs: number } | null, now: Date): UsageLimits | null {
  if (!cache || !Number.isFinite(cache.mtimeMs) || cache.mtimeMs > now.getTime() || now.getTime() - cache.mtimeMs > CLAUDE_CACHE_MAX_AGE_MS) return null
  try {
    const data: unknown = JSON.parse(cache.raw)
    if (!isRecord(data)) return null
    const fiveHourPct = usagePercent(data.sessionUsage), weeklyPct = usagePercent(data.weeklyUsage)
    if (fiveHourPct === null && weeklyPct === null) return null
    return { fiveHourPct, weeklyPct, fiveHourResetsAt: resetIso(data.sessionResetAt), weeklyResetsAt: resetIso(data.weeklyResetAt), source: 'ccstatusline cache', observedAt: new Date(cache.mtimeMs).toISOString() }
  } catch { return null }
}
export async function fetchClaudeQuota(run: CommandRunner = runCommand, now: Date = new Date(), readCache: ClaudeCacheReader = run === runCommand ? readClaudeCache : async () => null): Promise<ClaudeQuota> {
  const [estimate, cache] = await Promise.all([fetchClaudeEstimate(run, now), readCache().then(value => parseClaudeCache(value, now)).catch(() => null)])
  if (!cache) return estimate
  if (estimate.available) return { ...estimate, ...cache }
  return { available: true, active: false, tokens: null, otherTokens: null, costUSD: null, resetsAt: null, blockPercent: null, ...cache, reason: 'ccusage accounting unavailable' }
}
export async function fetchCodexQuota(run: CommandRunner = runCommand, collect: (() => Promise<UsageLimits>) | null = run === runCommand ? readCodexLimits : null): Promise<CodexQuota> {
  const limits = collect ? collect().catch(() => ({ reason: 'Codex usage limits unavailable' })) : Promise.resolve({})
  try {
    const result = await run([resolveBinary('codex'), 'login', 'status'], { timeoutMs: 5_000 })
    return { available: true, authed: result.exitCode === 0, ...await limits }
  } catch {
    await limits
    return { available: false, reason: 'Codex authentication status unavailable' }
  }
}

const PEAK_START_MIN = 14 * 60
const PEAK_END_MIN = 18 * 60
const MINUTES_PER_DAY = 24 * 60
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000

export function glmPeak(now: Date): PeakInfo {
  const shifted = new Date(now.getTime() + UTC8_OFFSET_MS)
  const day = shifted.getUTCDay()
  const minutesOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const nowMinuteOfWeek = day * MINUTES_PER_DAY + minutesOfDay

  const isWeekday = day >= 1 && day <= 5
  const peak = isWeekday && minutesOfDay >= PEAK_START_MIN && minutesOfDay < PEAK_END_MIN

  let minutesToChange = MINUTES_PER_WEEK
  for (let weekday = 1; weekday <= 5; weekday += 1) {
    for (const transition of [weekday * MINUTES_PER_DAY + PEAK_START_MIN, weekday * MINUTES_PER_DAY + PEAK_END_MIN]) {
      let delta = transition - nowMinuteOfWeek
      if (delta <= 0) delta += MINUTES_PER_WEEK
      if (delta < minutesToChange) minutesToChange = delta
    }
  }

  return { peak, minutesToChange }
}

export function parsePsOutput(
  raw: string,
  ownedPids: ReadonlySet<number>,
): Array<{ pid: number; etime: string; engine: ExternalEngine }> {
  const results: Array<{ pid: number; etime: string; engine: ExternalEngine }> = []
  const lines = raw.split('\n').slice(1)

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed)
    if (match === null) continue
    const [, pidText, etime, command] = match as [string, string, string, string]
    const pid = Number.parseInt(pidText, 10)
    if (!Number.isInteger(pid) || ownedPids.has(pid)) continue
    if (/(^|\/)ps(\s|$)/.test(command) || /\bgrep\b/.test(command)) continue

    const engine: ExternalEngine | null = /\bcodex\b/.test(command)
      ? 'codex'
      : /\bclaude\b/.test(command)
        ? 'claude'
        : null
    if (engine === null) continue

    results.push({ pid, etime, engine })
  }

  return results
}

export function parseLsofCwd(raw: string): string | null {
  for (const line of raw.split('\n')) {
    if (line.startsWith('n')) return line.slice(1)
  }
  return null
}

async function lsofCwdHint(pid: number, run: CommandRunner): Promise<string | null> {
  try {
    const result = await run(['lsof', '-p', String(pid), '-a', '-d', 'cwd', '-Fn'], { timeoutMs: 3_000 })
    if (result.exitCode !== 0) return null
    return parseLsofCwd(result.stdout)
  } catch {
    return null
  }
}

export async function fetchExternalSessions(
  ownedPids: ReadonlySet<number> = new Set(),
  run: CommandRunner = runCommand,
): Promise<ExternalSession[]> {
  try {
    const result = await run(['ps', '-axo', 'pid,etime,command'], { timeoutMs: 5_000 })
    if (result.exitCode !== 0) return []

    const candidates = parsePsOutput(result.stdout, ownedPids)
    return await Promise.all(
      candidates.map(async (candidate) => ({ ...candidate, cwdHint: await lsofCwdHint(candidate.pid, run) })),
    )
  } catch {
    return []
  }
}

export type Clock = () => number

export type QuotaCache<T> = {
  get(): Promise<T>
  invalidate(): void
}

export function createQuotaCache<T>(fetcher: () => Promise<T>, ttlMs = 60_000, clock: Clock = Date.now): QuotaCache<T> {
  let cached: { value: T; expiresAt: number } | null = null

  return {
    async get() {
      const now = clock()
      if (cached !== null && cached.expiresAt > now) return cached.value
      const value = await fetcher()
      cached = { value, expiresAt: now + ttlMs }
      return value
    },
    invalidate() {
      cached = null
    },
  }
}

export async function fetchQuotaComposite(secrets: Secrets, now: Date = new Date()): Promise<QuotaComposite> {
  const [claude, glm, codex] = await Promise.all([fetchClaudeQuota(), fetchGlmQuota(secrets, now), fetchCodexQuota()])
  return { claude, glm, codex, peak: glmPeak(now) }
}
