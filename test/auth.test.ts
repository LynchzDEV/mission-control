import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  attemptLogin,
  completeSetup,
  createRateLimiter,
  hashPassword,
  isSetupComplete,
  issueSessionToken,
  parseCookieHeader,
  resetLoginLimiter,
  signSessionToken,
  verifyCookieHeader,
  verifyPasswordHash,
  verifySessionToken,
} from '../server/auth'
import { readAuthRecord } from '../server/secrets'

const PASSWORD = 'correct-horse-battery'
const SECRET = 'a'.repeat(64)

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-auth-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  resetLoginLimiter()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  resetLoginLimiter()
  await rm(dir, { recursive: true, force: true })
})

describe('password hashing', () => {
  test('hash verifies against the original password only', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash).not.toContain(PASSWORD)
    expect(await verifyPasswordHash(PASSWORD, hash)).toBe(true)
    expect(await verifyPasswordHash(`${PASSWORD}!`, hash)).toBe(false)
  })
})

describe('session tokens', () => {
  test('a freshly signed token verifies', () => {
    const token = signSessionToken(SECRET, Date.now() + 60_000)
    expect(verifySessionToken(SECRET, token)).toBe(true)
  })

  test('a tampered token is rejected', () => {
    const expiry = Date.now() + 60_000
    const token = signSessionToken(SECRET, expiry, 'nonce')
    const [, nonce, signature] = token.split('.') as [string, string, string]

    expect(verifySessionToken(SECRET, `${expiry + 60_000}.${nonce}.${signature}`)).toBe(false)
    expect(verifySessionToken(SECRET, `${expiry}.${nonce}x.${signature}`)).toBe(false)
    const flippedLast = signature.slice(-1) === '0' ? '1' : '0'
    expect(verifySessionToken(SECRET, `${expiry}.${nonce}.${signature.slice(0, -1)}${flippedLast}`)).toBe(false)
    expect(verifySessionToken('b'.repeat(64), token)).toBe(false)
  })

  test('a valid signature with appended junk is rejected', () => {
    const token = signSessionToken(SECRET, Date.now() + 60_000)
    expect(verifySessionToken(SECRET, `${token}x`)).toBe(false)
    expect(verifySessionToken(SECRET, `${token}00`)).toBe(false)
    expect(verifySessionToken(SECRET, token.toUpperCase())).toBe(false)
  })

  test('an expired token is rejected', () => {
    const token = signSessionToken(SECRET, Date.now() - 1)
    expect(verifySessionToken(SECRET, token)).toBe(false)
  })

  test('malformed tokens are rejected without throwing', () => {
    for (const bad of ['', 'x', 'a.b', 'a.b.c.d', 'notanumber.nonce.deadbeef', '..']) {
      expect(verifySessionToken(SECRET, bad)).toBe(false)
    }
  })
})

describe('cookie header parsing', () => {
  test('extracts named cookies and tolerates junk', () => {
    expect(parseCookieHeader('a=1; mc_session=tok; b=2').mc_session).toBe('tok')
    expect(parseCookieHeader(null)).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
    expect(parseCookieHeader('novalue')).toEqual({})
  })
})

describe('rate limiter', () => {
  test('locks after the configured failures and releases after the window', () => {
    let clock = 1_000_000
    const limiter = createRateLimiter({ now: () => clock })

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect(limiter.recordFailure('ip').locked).toBe(false)
    }
    expect(limiter.recordFailure('ip').locked).toBe(true)
    expect(limiter.check('ip')).toEqual({ locked: true, retryAfterMs: LOCKOUT_MS })

    clock += LOCKOUT_MS - 1
    expect(limiter.check('ip').locked).toBe(true)

    clock += 1
    expect(limiter.check('ip')).toEqual({ locked: false, retryAfterMs: 0 })
    expect(limiter.recordFailure('ip').locked).toBe(false)
  })

  test('lockout is scoped per key', () => {
    const limiter = createRateLimiter({ now: () => 0 })
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) limiter.recordFailure('a')
    expect(limiter.check('a').locked).toBe(true)
    expect(limiter.check('b').locked).toBe(false)
  })

  test('reset clears a locked key', () => {
    const limiter = createRateLimiter({ now: () => 0 })
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) limiter.recordFailure('a')
    limiter.reset('a')
    expect(limiter.check('a').locked).toBe(false)
  })
})

describe('setup', () => {
  test('rejects short passwords and leaves setup incomplete', async () => {
    const result = await completeSetup('x'.repeat(MIN_PASSWORD_LENGTH - 1))
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(await isSetupComplete()).toBe(false)
  })

  test('rejects non-string passwords', async () => {
    expect(await completeSetup(undefined)).toMatchObject({ ok: false, status: 400 })
    expect(await completeSetup(12345678901)).toMatchObject({ ok: false, status: 400 })
  })

  test('stores a hash plus cookie secret and never the plaintext', async () => {
    const result = await completeSetup(PASSWORD)
    expect(result.ok).toBe(true)
    expect(await isSetupComplete()).toBe(true)

    const record = await readAuthRecord()
    expect(record.passwordHash).toContain('argon2id')
    expect(JSON.stringify(record)).not.toContain(PASSWORD)
    expect(record.cookieSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  test('refuses to run twice', async () => {
    await completeSetup(PASSWORD)
    expect(await completeSetup('another-long-password')).toMatchObject({ ok: false, status: 409 })
  })
})

describe('login', () => {
  test('requires setup first', async () => {
    expect(await attemptLogin(PASSWORD, 'ip')).toMatchObject({ ok: false, status: 409 })
  })

  test('accepts the right password and rejects the wrong one', async () => {
    await completeSetup(PASSWORD)
    expect(await attemptLogin(PASSWORD, 'ip')).toMatchObject({ ok: true })
    expect(await attemptLogin('wrong-password-here', 'ip')).toMatchObject({ ok: false, status: 401 })
  })

  test('locks out after five failures', async () => {
    await completeSetup(PASSWORD)
    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect(await attemptLogin('wrong-password-here', 'ip')).toMatchObject({ status: 401 })
    }
    expect(await attemptLogin('wrong-password-here', 'ip')).toMatchObject({ status: 429 })
    expect(await attemptLogin(PASSWORD, 'ip')).toMatchObject({ ok: false, status: 429 })
    expect(await attemptLogin(PASSWORD, 'other-ip')).toMatchObject({ ok: true })
  })
})

describe('verifyCookieHeader', () => {
  test('rejects everything before setup', async () => {
    const token = signSessionToken(SECRET, Date.now() + 60_000)
    expect(await verifyCookieHeader(`${SESSION_COOKIE}=${token}`)).toBe(false)
    expect(await verifyCookieHeader(null)).toBe(false)
  })

  test('accepts a session issued after setup and rejects tampering', async () => {
    await completeSetup(PASSWORD)
    const token = await issueSessionToken()

    expect(await verifyCookieHeader(`${SESSION_COOKIE}=${token}`)).toBe(true)
    expect(await verifyCookieHeader(`${SESSION_COOKIE}=${token}x`)).toBe(false)
    expect(await verifyCookieHeader('other=value')).toBe(false)
    expect(await verifyCookieHeader(null)).toBe(false)
  })

  test('rejects a session signed with a foreign secret', async () => {
    await completeSetup(PASSWORD)
    const forged = signSessionToken(SECRET, Date.now() + 60_000)
    expect(await verifyCookieHeader(`${SESSION_COOKIE}=${forged}`)).toBe(false)
  })
})
