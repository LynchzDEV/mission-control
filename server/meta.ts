export const BLOCK_MS = 5 * 60 * 60 * 1000
export const BLOCK_TOTAL = '5:00'
export const MAX_TOKEN_SAMPLES = 10

export type BlockClock = { elapsed: string; total: string; pct: number }

export type TokenSample = { at: number; tokens: number }

export type TokenSampler = {
  record(tokens: number, at: number): void
  samples(): TokenSample[]
  tokensPerMin(): number | null
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatClock(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  return `${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`
}

export function blockClock(resetsAt: string | null, now: number): BlockClock | null {
  if (resetsAt === null) return null
  const endsAt = Date.parse(resetsAt)
  if (Number.isNaN(endsAt)) return null

  const elapsedMs = Math.min(BLOCK_MS, Math.max(0, now - (endsAt - BLOCK_MS)))
  return {
    elapsed: formatClock(elapsedMs),
    total: BLOCK_TOTAL,
    pct: Math.round((elapsedMs / BLOCK_MS) * 1000) / 10,
  }
}

export function tokensPerMinute(samples: readonly TokenSample[]): number | null {
  if (samples.length < 2) return null

  const meanAt = samples.reduce((sum, sample) => sum + sample.at, 0) / samples.length
  const meanTokens = samples.reduce((sum, sample) => sum + sample.tokens, 0) / samples.length

  let covariance = 0
  let variance = 0
  for (const sample of samples) {
    const minutes = (sample.at - meanAt) / 60_000
    covariance += minutes * (sample.tokens - meanTokens)
    variance += minutes * minutes
  }
  if (variance === 0) return null
  return covariance / variance
}

export function createTokenSampler(max: number = MAX_TOKEN_SAMPLES): TokenSampler {
  let samples: TokenSample[] = []

  return {
    record(tokens, at) {
      const previous = samples[samples.length - 1]
      // A drop means ccusage rolled into a fresh 5h block; the old slope no longer applies.
      if (previous !== undefined && tokens < previous.tokens) samples = []
      samples.push({ at, tokens })
      if (samples.length > max) samples = samples.slice(samples.length - max)
    },
    samples() {
      return [...samples]
    },
    tokensPerMin() {
      return tokensPerMinute(samples)
    },
  }
}
