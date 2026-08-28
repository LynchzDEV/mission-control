import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { MAX_FAILED_ATTEMPTS, SESSION_COOKIE, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'

const PASSWORD = 'correct-horse-battery'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-http-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  resetLoginLimiter()
  app = await createApp()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  resetLoginLimiter()
  await rm(dir, { recursive: true, force: true })
})

function post(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  return new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function get(path: string, cookie?: string): Request {
  return new Request(
    `http://localhost${path}`,
    cookie === undefined ? undefined : { headers: { cookie } },
  )
}

function sessionCookie(response: Response): string {
  const jar = response.headers.getSetCookie()
  const session = jar.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
  expect(session).toBeDefined()
  return (session as string).split(';')[0] as string
}

describe('unauthenticated access', () => {
  test('GET /api/health is 401', async () => {
    const response = await app.handle(get('/api/health'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  test('GET /api/health with a forged cookie is 401', async () => {
    const response = await app.handle(get('/api/health', `${SESSION_COOKIE}=1.2.3`))
    expect(response.status).toBe(401)
  })

  test('GET / serves the setup page before any password exists', async () => {
    const response = await app.handle(get('/'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toContain('data-page="setup"')
  })
})

describe('setup then login then health', () => {
  test('completes the whole flow and reaches an authed endpoint', async () => {
    const setup = await app.handle(post('/api/setup', { password: PASSWORD }))
    expect(setup.status).toBe(200)
    expect(await setup.json()).toEqual({ ok: true })

    const setupJar = setup.headers.getSetCookie()
    expect(setupJar.some((entry) => entry.includes('HttpOnly'))).toBe(true)
    expect(setupJar.some((entry) => entry.includes('SameSite=Lax'))).toBe(true)

    const login = await app.handle(post('/api/login', { password: PASSWORD }))
    expect(login.status).toBe(200)

    const cookie = sessionCookie(login)
    const health = await app.handle(get('/api/health', cookie))
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })

    const shell = await app.handle(get('/', cookie))
    expect(await shell.text()).toContain('data-page="app"')
  })

  test('GET / serves the login page once a password exists but no session is presented', async () => {
    await app.handle(post('/api/setup', { password: PASSWORD }))
    const response = await app.handle(get('/'))
    expect(await response.text()).toContain('data-page="login"')
  })

  test('setup is refused a second time', async () => {
    await app.handle(post('/api/setup', { password: PASSWORD }))
    const again = await app.handle(post('/api/setup', { password: 'another-long-password' }))
    expect(again.status).toBe(409)
  })

  test('setup rejects a short password', async () => {
    const response = await app.handle(post('/api/setup', { password: 'short' }))
    expect(response.status).toBe(400)
    expect(await app.handle(get('/'))).toHaveProperty('status', 200)
  })

  test('logout clears the session cookie', async () => {
    const setup = await app.handle(post('/api/setup', { password: PASSWORD }))
    const cookie = sessionCookie(setup)

    const logout = await app.handle(post('/api/logout', {}, cookie))
    expect(logout.status).toBe(200)
    expect(logout.headers.getSetCookie().some((entry) => entry.includes(`${SESSION_COOKIE}=;`))).toBe(
      true,
    )
  })
})

describe('login rate limiting', () => {
  test('locks out after five failures and answers 429', async () => {
    await app.handle(post('/api/setup', { password: PASSWORD }))

    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      const response = await app.handle(post('/api/login', { password: 'wrong-password-here' }))
      expect(response.status).toBe(401)
    }

    const locked = await app.handle(post('/api/login', { password: 'wrong-password-here' }))
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBe('60')

    const correctButLocked = await app.handle(post('/api/login', { password: PASSWORD }))
    expect(correctButLocked.status).toBe(429)
  })
})

describe('real socket', () => {
  test('serves the flow over an ephemeral port', async () => {
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.server?.port}`

    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(401)

      const setup = await fetch(`${base}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      })
      expect(setup.status).toBe(200)

      const health = await fetch(`${base}/api/health`, {
        headers: { cookie: sessionCookie(setup) },
      })
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })
    } finally {
      server.stop()
    }
  })
})
