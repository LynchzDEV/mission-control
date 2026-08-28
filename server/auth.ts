import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { readApiToken, readAuthRecord, writeAuthRecord } from './secrets'

const TOKEN_SCOPED_GET_ONLY_PATHS = new Set(['/api/flow', '/api/quota', '/api/meta'])
const TOKEN_SCOPED_PREFIX = '/api/jobs'

// The one shared gate for what a Bearer API token may touch — extend this, not requireSession's callers.
export function allowToken(pathname: string, method: string): boolean {
  const upperMethod = method.toUpperCase()
  if (pathname === TOKEN_SCOPED_PREFIX || pathname.startsWith(`${TOKEN_SCOPED_PREFIX}/`)) {
    return upperMethod === 'GET' || upperMethod === 'POST'
  }
  return TOKEN_SCOPED_GET_ONLY_PATHS.has(pathname) && upperMethod === 'GET'
}

function extractBearerToken(header: string | null): string | null {
  if (header === null) return null
  const match = /^Bearer (.+)$/.exec(header)
  return match?.[1] ?? null
}

export async function verifyBearerToken(header: string | null): Promise<boolean> {
  const provided = extractBearerToken(header)
  if (provided === null || provided === '') return false
  const expected = await readApiToken()
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

export const MIN_PASSWORD_LENGTH = 10
export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_MS = 60_000
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'mc_session'

export type Clock = () => number

export type LockState = {
  locked: boolean
  retryAfterMs: number
}

export type RateLimiter = {
  check(key: string): LockState
  recordFailure(key: string): LockState
  reset(key?: string): void
}

type Attempt = {
  failures: number
  lockedUntil: number
}

export function createRateLimiter(
  options: { now?: Clock; maxAttempts?: number; lockoutMs?: number } = {},
): RateLimiter {
  const now = options.now ?? Date.now
  const maxAttempts = options.maxAttempts ?? MAX_FAILED_ATTEMPTS
  const lockoutMs = options.lockoutMs ?? LOCKOUT_MS
  const attempts = new Map<string, Attempt>()

  const current = (key: string): Attempt => {
    const existing = attempts.get(key)
    if (existing === undefined) return { failures: 0, lockedUntil: 0 }
    if (existing.lockedUntil !== 0 && existing.lockedUntil <= now()) {
      attempts.delete(key)
      return { failures: 0, lockedUntil: 0 }
    }
    return existing
  }

  return {
    check(key) {
      const attempt = current(key)
      const remaining = attempt.lockedUntil - now()
      return remaining > 0
        ? { locked: true, retryAfterMs: remaining }
        : { locked: false, retryAfterMs: 0 }
    },
    recordFailure(key) {
      const attempt = current(key)
      const failures = attempt.failures + 1
      const lockedUntil = failures >= maxAttempts ? now() + lockoutMs : attempt.lockedUntil
      attempts.set(key, { failures, lockedUntil })
      const remaining = lockedUntil - now()
      return remaining > 0
        ? { locked: true, retryAfterMs: remaining }
        : { locked: false, retryAfterMs: 0 }
    },
    reset(key) {
      if (key === undefined) attempts.clear()
      else attempts.delete(key)
    },
  }
}

const loginLimiter = createRateLimiter()

export function resetLoginLimiter(key?: string): void {
  loginLimiter.reset(key)
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

export function verifyPasswordHash(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash)
}

export async function isSetupComplete(): Promise<boolean> {
  const record = await readAuthRecord()
  return record.passwordHash !== null
}

export function signSessionToken(secret: string, expiresAt: number, nonce?: string): string {
  const payload = `${expiresAt}.${nonce ?? randomBytes(16).toString('hex')}`
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${signature}`
}

export function verifySessionToken(secret: string, token: string, now = Date.now()): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [rawExpiry, nonce, signature] = parts as [string, string, string]
  if (nonce === '' || !/^[0-9]+$/.test(rawExpiry)) return false

  const expected = createHmac('sha256', secret).update(`${rawExpiry}.${nonce}`).digest('hex')
  if (signature.length !== expected.length) return false
  const provided = Buffer.from(signature, 'ascii')
  const reference = Buffer.from(expected, 'ascii')
  if (!timingSafeEqual(provided, reference)) return false

  return Number.parseInt(rawExpiry, 10) > now
}

export function parseCookieHeader(raw: string | null | undefined): Record<string, string> {
  const jar: Record<string, string> = {}
  if (typeof raw !== 'string' || raw === '') return jar
  for (const segment of raw.split(';')) {
    const separator = segment.indexOf('=')
    if (separator <= 0) continue
    const name = segment.slice(0, separator).trim()
    if (name === '') continue
    jar[name] = decodeURIComponent(segment.slice(separator + 1).trim())
  }
  return jar
}

async function cookieSecret(): Promise<string> {
  const record = await readAuthRecord()
  if (record.cookieSecret !== null) return record.cookieSecret
  const generated = randomBytes(32).toString('hex')
  await writeAuthRecord({ cookieSecret: generated })
  return generated
}

export async function issueSessionToken(now = Date.now()): Promise<string> {
  return signSessionToken(await cookieSecret(), now + SESSION_TTL_MS)
}

export async function verifyCookieHeader(raw: string | null | undefined): Promise<boolean> {
  const token = parseCookieHeader(raw)[SESSION_COOKIE]
  if (token === undefined) return false
  const record = await readAuthRecord()
  if (record.passwordHash === null || record.cookieSecret === null) return false
  return verifySessionToken(record.cookieSecret, token)
}

export type SetupResult =
  | { ok: true; token: string }
  | { ok: false; status: number; error: string }

export async function completeSetup(password: unknown): Promise<SetupResult> {
  if (await isSetupComplete()) {
    return { ok: false, status: 409, error: 'already configured' }
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, status: 400, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` }
  }
  await writeAuthRecord({
    passwordHash: await hashPassword(password),
    cookieSecret: randomBytes(32).toString('hex'),
  })
  return { ok: true, token: await issueSessionToken() }
}

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; status: number; error: string; retryAfterMs?: number }

export async function attemptLogin(password: unknown, key: string): Promise<LoginResult> {
  const gate = loginLimiter.check(key)
  if (gate.locked) {
    return { ok: false, status: 429, error: 'too many attempts', retryAfterMs: gate.retryAfterMs }
  }

  const record = await readAuthRecord()
  if (record.passwordHash === null) {
    return { ok: false, status: 409, error: 'setup required' }
  }

  const valid =
    typeof password === 'string' && (await verifyPasswordHash(password, record.passwordHash))
  if (!valid) {
    const state = loginLimiter.recordFailure(key)
    return state.locked
      ? { ok: false, status: 429, error: 'too many attempts', retryAfterMs: state.retryAfterMs }
      : { ok: false, status: 401, error: 'invalid password' }
  }

  loginLimiter.reset(key)
  return { ok: true, token: await issueSessionToken() }
}

export type GuardContext = {
  request: Request
  set: { status?: number | string }
}

export async function requireSession(context: GuardContext) {
  if (await verifyCookieHeader(context.request.headers.get('cookie'))) return

  const { pathname } = new URL(context.request.url)
  if (
    allowToken(pathname, context.request.method) &&
    (await verifyBearerToken(context.request.headers.get('authorization')))
  ) {
    return
  }

  context.set.status = 401
  return { error: 'unauthorized' }
}
