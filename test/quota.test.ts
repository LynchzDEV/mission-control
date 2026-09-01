import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  type CommandResult,
  createQuotaCache,
  fetchClaudeQuota,
  fetchCodexQuota,
  fetchExternalSessions,
  fetchGlmQuota,
  formatZaiDateTime,
  glmPeak,
  glmUsageWindow,
  parseCcusageBlocksJson,
  parseCcusageDailyJson,
  parseGlmLimitPayload,
  parseLsofCwd,
  parsePsOutput,
  zaiOrigin,
} from '../server/quota'
import { DEFAULT_ZAI_BASE_URL, type Secrets } from '../server/secrets'

const FIXTURES = join(import.meta.dir, 'fixtures', 'quota')

function fixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text()
}

function secrets(patch: Partial<Secrets> = {}): Secrets {
  return { zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, ...patch }
}

describe('ccusage blocks parsing', () => {
  test('reports the active block tokens, reset time, and block percent', async () => {
    const result = parseCcusageBlocksJson(await fixture('ccusage-blocks-active.json'))
    expect(result).toEqual({
      available: true,
      active: true,
      tokens: 95718961,
      nonCacheTokens: 89214,
      costUSD: 101.02,
      resetsAt: '2026-08-28T11:00:00.000Z',
      blockPercent: 68.4,
    })
  })

  test('blockPercent is null when the active block carries no tokenLimitStatus', () => {
    const noLimit = JSON.stringify({
      blocks: [
        {
          id: '2026-08-28T06:00:00.000Z',
          startTime: '2026-08-28T06:00:00.000Z',
          endTime: '2026-08-28T11:00:00.000Z',
          isActive: true,
          isGap: false,
          costUSD: 101.02,
          totalTokens: 95718961,
        },
      ],
    })
    const result = parseCcusageBlocksJson(noLimit)
    expect(result).toMatchObject({ available: true, active: true, blockPercent: null })
  })

  test('reports inactive with zero tokens when no block is active', async () => {
    const result = parseCcusageBlocksJson(await fixture('ccusage-blocks-inactive.json'))
    expect(result).toEqual({
      available: true,
      active: false,
      tokens: 0,
      nonCacheTokens: null,
      costUSD: null,
      resetsAt: null,
      blockPercent: null,
    })
  })

  test('malformed output never throws, always available:false', async () => {
    const result = parseCcusageBlocksJson(await fixture('malformed.txt'))
    expect(result.available).toBe(false)
  })

  test('valid json missing the blocks array is available:false', () => {
    expect(parseCcusageBlocksJson('{"nope":true}').available).toBe(false)
  })
})

describe('ccusage daily fallback parsing', () => {
  test('uses the most recent day as the fallback figure', async () => {
    const result = parseCcusageDailyJson(await fixture('ccusage-daily.json'))
    expect(result).toEqual({
      available: true,
      active: false,
      tokens: 196433023,
      costUSD: 235.0491458000002,
      resetsAt: null,
      blockPercent: null,
    })
  })

  test('malformed output never throws', async () => {
    expect(parseCcusageDailyJson(await fixture('malformed.txt')).available).toBe(false)
    expect(parseCcusageDailyJson('{"daily":[]}').available).toBe(false)
  })
})

function runner(script: Record<string, CommandResult | (() => CommandResult) | Error>) {
  return async (cmd: string[]): Promise<CommandResult> => {
    const key = [cmd[0]?.split('/').pop(), ...cmd.slice(1)].join(' ')
    const entry = script[key]
    if (entry === undefined) throw new Error(`unscripted command: ${key}`)
    if (entry instanceof Error) throw entry
    return typeof entry === 'function' ? entry() : entry
  }
}

describe('fetchClaudeQuota', () => {
  test('uses the blocks command when it succeeds', async () => {
    const stdout = await fixture('ccusage-blocks-active.json')
    const result = await fetchClaudeQuota(
      runner({ 'npx ccusage@latest blocks --json': { stdout, exitCode: 0 } }),
    )
    expect(result).toMatchObject({ available: true, active: true, tokens: 95718961 })
  })

  test('falls back to daily when blocks fails', async () => {
    const dailyStdout = await fixture('ccusage-daily.json')
    const result = await fetchClaudeQuota(
      runner({
        'npx ccusage@latest blocks --json': new Error('spawn ENOENT'),
        'npx ccusage daily --json': { stdout: dailyStdout, exitCode: 0 },
      }),
    )
    expect(result).toMatchObject({ available: true, tokens: 196433023 })
  })

  test('available:false when both commands fail', async () => {
    const result = await fetchClaudeQuota(
      runner({
        'npx ccusage@latest blocks --json': new Error('not found'),
        'npx ccusage daily --json': new Error('not found'),
      }),
    )
    expect(result).toEqual({ available: false, reason: 'ccusage unavailable' })
  })
})

describe('zaiOrigin', () => {
  test('strips the path down to protocol + host', () => {
    expect(zaiOrigin('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai')
    expect(zaiOrigin('https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn')
  })

  test('returns the input unchanged if unparseable', () => {
    expect(zaiOrigin('not-a-url')).toBe('not-a-url')
  })
})

describe('glmUsageWindow', () => {
  test('formats yyyy-MM-dd HH:mm:ss and spans exactly 24 hours', () => {
    const now = new Date(2026, 7, 28, 15, 30, 0)
    const { startTime, endTime } = glmUsageWindow(now)
    expect(startTime).toBe('2026-08-27 15:30:00')
    expect(endTime).toBe('2026-08-28 15:30:00')
    expect(formatZaiDateTime(now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('parseGlmLimitPayload', () => {
  test('reads TOKENS_LIMIT and TIME_LIMIT percentages', async () => {
    const payload: unknown = JSON.parse(await fixture('zai-limit-both.json'))
    expect(parseGlmLimitPayload(payload)).toEqual({ fiveHourPct: 42, monthlyPct: 7 })
  })

  test('monthlyPct is null when TIME_LIMIT is absent', async () => {
    const payload: unknown = JSON.parse(await fixture('zai-limit-tokens-only.json'))
    expect(parseGlmLimitPayload(payload)).toEqual({ fiveHourPct: 88, monthlyPct: null })
  })

  test('returns null for an unrecognized shape', async () => {
    const payload: unknown = JSON.parse(await fixture('zai-limit-malformed.json'))
    expect(parseGlmLimitPayload(payload)).toBeNull()
    expect(parseGlmLimitPayload(null)).toBeNull()
    expect(parseGlmLimitPayload('junk')).toBeNull()
  })
})

describe('fetchGlmQuota', () => {
  test('available:false when no token is configured', async () => {
    const result = await fetchGlmQuota(secrets(), new Date())
    expect(result).toEqual({ available: false, reason: 'zaiAuthToken not configured' })
  })

  test('returns percentages on a successful limit response and never leaks the token as a header key check', async () => {
    const limitPayload = JSON.parse(await fixture('zai-limit-both.json'))
    const calls: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url)
      expect((init?.headers as Record<string, string>).Authorization).toBe('zai-token')
      if (url.includes('/api/monitor/usage/quota/limit')) {
        return new Response(JSON.stringify(limitPayload), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }

    const result = await fetchGlmQuota(secrets({ zaiAuthToken: 'zai-token' }), new Date(), fetchImpl)
    expect(result).toEqual({ available: true, fiveHourPct: 42, monthlyPct: 7 })
    expect(calls.some((url) => url.includes('/api/monitor/usage/quota/limit'))).toBe(true)
    expect(calls.some((url) => url.includes('/api/monitor/usage/model-usage'))).toBe(true)
  })

  test('available:false on a non-2xx limit response', async () => {
    const fetchImpl = async () => new Response('nope', { status: 401 })
    const result = await fetchGlmQuota(secrets({ zaiAuthToken: 'zai-token' }), new Date(), fetchImpl)
    expect(result).toEqual({ available: false, reason: 'quota/limit responded 401' })
  })

  test('available:false on malformed limit json', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ nope: true }), { status: 200 })
    const result = await fetchGlmQuota(secrets({ zaiAuthToken: 'zai-token' }), new Date(), fetchImpl)
    expect(result).toEqual({ available: false, reason: 'unexpected quota/limit response shape' })
  })

  test('available:false when the network call throws', async () => {
    const fetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const result = await fetchGlmQuota(secrets({ zaiAuthToken: 'zai-token' }), new Date(), fetchImpl)
    expect(result).toEqual({ available: false, reason: 'getaddrinfo ENOTFOUND' })
  })

  test('a failing model-usage call does not block the percentages', async () => {
    const limitPayload = JSON.parse(await fixture('zai-limit-both.json'))
    const fetchImpl = async (url: string) => {
      if (url.includes('/api/monitor/usage/quota/limit')) {
        return new Response(JSON.stringify(limitPayload), { status: 200 })
      }
      throw new Error('model-usage down')
    }
    const result = await fetchGlmQuota(secrets({ zaiAuthToken: 'zai-token' }), new Date(), fetchImpl)
    expect(result).toEqual({ available: true, fiveHourPct: 42, monthlyPct: 7 })
  })
})

describe('fetchCodexQuota', () => {
  test('authed:true on exit code 0', async () => {
    const result = await fetchCodexQuota(runner({ 'codex login status': { stdout: 'Logged in', exitCode: 0 } }))
    expect(result).toEqual({ available: true, authed: true })
  })

  test('authed:false on a non-zero exit code', async () => {
    const result = await fetchCodexQuota(runner({ 'codex login status': { stdout: 'Not logged in', exitCode: 1 } }))
    expect(result).toEqual({ available: true, authed: false })
  })

  test('available:false when codex is missing', async () => {
    const result = await fetchCodexQuota(runner({ 'codex login status': new Error('spawn codex ENOENT') }))
    expect(result).toEqual({ available: false, reason: 'spawn codex ENOENT' })
  })
})

describe('glmPeak boundaries (Mon–Fri 14:00–17:59:59 UTC+8)', () => {
  const monday = (hour: number, minute: number) => new Date(Date.UTC(2026, 0, 5, hour, minute, 0))
  const saturday = (hour: number, minute: number) => new Date(Date.UTC(2026, 0, 10, hour, minute, 0))

  test('13:59 UTC+8 (05:59 UTC) is not yet peak', () => {
    expect(glmPeak(monday(5, 59))).toEqual({ peak: false, minutesToChange: 1 })
  })

  test('14:00 UTC+8 (06:00 UTC) is peak', () => {
    expect(glmPeak(monday(6, 0))).toEqual({ peak: true, minutesToChange: 240 })
  })

  test('17:59 UTC+8 (09:59 UTC) is still peak', () => {
    expect(glmPeak(monday(9, 59))).toEqual({ peak: true, minutesToChange: 1 })
  })

  test('18:00 UTC+8 (10:00 UTC) is off-peak again', () => {
    expect(glmPeak(monday(10, 0))).toEqual({ peak: false, minutesToChange: 1200 })
  })

  test('Saturday is never peak, at any hour', () => {
    expect(glmPeak(saturday(1, 0)).peak).toBe(false)
    expect(glmPeak(saturday(6, 0)).peak).toBe(false)
    expect(glmPeak(saturday(14, 0)).peak).toBe(false)
    expect(glmPeak(saturday(23, 59)).peak).toBe(false)
  })

  test('minutesToChange is always a positive number within one week', () => {
    for (const date of [monday(0, 0), monday(6, 0), saturday(12, 0)]) {
      const { minutesToChange } = glmPeak(date)
      expect(minutesToChange).toBeGreaterThan(0)
      expect(minutesToChange).toBeLessThanOrEqual(7 * 24 * 60)
    }
  })
})

describe('createQuotaCache', () => {
  test('serves cached value until ttl expires, then refetches', async () => {
    let calls = 0
    let clock = 0
    const cache = createQuotaCache(async () => {
      calls += 1
      return calls
    }, 1000, () => clock)

    expect(await cache.get()).toBe(1)
    expect(calls).toBe(1)

    expect(await cache.get()).toBe(1)
    expect(calls).toBe(1)

    clock = 999
    expect(await cache.get()).toBe(1)
    expect(calls).toBe(1)

    clock = 1000
    expect(await cache.get()).toBe(2)
    expect(calls).toBe(2)
  })

  test('invalidate forces the next get() to refetch regardless of clock', async () => {
    let calls = 0
    const cache = createQuotaCache(async () => {
      calls += 1
      return calls
    }, 60_000, () => 0)

    expect(await cache.get()).toBe(1)
    cache.invalidate()
    expect(await cache.get()).toBe(2)
  })
})

describe('external session ps parsing', () => {
  test('extracts claude/codex processes and skips self-references', async () => {
    const raw = await fixture('ps-output.txt')
    const result = parsePsOutput(raw, new Set())
    expect(result).toEqual([
      { pid: 4821, etime: '01:22:05', engine: 'claude' },
      { pid: 4899, etime: '00:05:10', engine: 'codex' },
    ])
  })

  test('excludes pids passed as owned', async () => {
    const raw = await fixture('ps-output.txt')
    const result = parsePsOutput(raw, new Set([4821]))
    expect(result).toEqual([{ pid: 4899, etime: '00:05:10', engine: 'codex' }])
  })

  test('empty or garbage input yields an empty list without throwing', () => {
    expect(parsePsOutput('', new Set())).toEqual([])
    expect(parsePsOutput('header only\nnonsense line with no pid', new Set())).toEqual([])
  })
})

describe('parseLsofCwd', () => {
  test('extracts the cwd from -Fn output', () => {
    expect(parseLsofCwd('p4821\nfcwd\nn/Users/lynchz/project\n')).toBe('/Users/lynchz/project')
  })

  test('returns null when no cwd line is present', () => {
    expect(parseLsofCwd('p4821\nfcwd\n')).toBeNull()
    expect(parseLsofCwd('')).toBeNull()
  })
})

describe('fetchExternalSessions', () => {
  test('joins ps candidates with a best-effort cwd lookup', async () => {
    const psOutput = await fixture('ps-output.txt')
    const run = async (cmd: string[]): Promise<CommandResult> => {
      if (cmd[0] === 'ps') return { stdout: psOutput, exitCode: 0 }
      if (cmd[0] === 'lsof' && cmd[2] === '4821') {
        return { stdout: 'p4821\nfcwd\nn/Users/lynchz/repo-a\n', exitCode: 0 }
      }
      if (cmd[0] === 'lsof' && cmd[2] === '4899') return { stdout: '', exitCode: 1 }
      throw new Error(`unscripted: ${cmd.join(' ')}`)
    }

    const result = await fetchExternalSessions(new Set(), run)
    expect(result).toEqual([
      { pid: 4821, etime: '01:22:05', engine: 'claude', cwdHint: '/Users/lynchz/repo-a' },
      { pid: 4899, etime: '00:05:10', engine: 'codex', cwdHint: null },
    ])
  })

  test('returns an empty list when ps itself fails', async () => {
    const run = async (): Promise<CommandResult> => {
      throw new Error('ps: not found')
    }
    expect(await fetchExternalSessions(new Set(), run)).toEqual([])
  })
})
describe('glm CREDIT_LIMIT schema (2026-08)', () => {
  test('maps unit 3 to fiveHourPct and unit 6 to monthlyPct', async () => {
    const payload = JSON.parse(await fixture('zai-limit-credit.json'))
    expect(parseGlmLimitPayload(payload)).toEqual({ fiveHourPct: 0, monthlyPct: 20 })
  })
  test('falls back to first credit entry when units are unknown', () => {
    const payload = { data: { limits: [{ type: 'CREDIT_LIMIT', unit: 99, percentage: 42 }] } }
    expect(parseGlmLimitPayload(payload)).toEqual({ fiveHourPct: 42, monthlyPct: null })
  })
})

