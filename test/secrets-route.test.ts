import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { SESSION_COOKIE, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import { configPath } from '../server/secrets'

const PASSWORD = 'correct-horse-battery'
const TOKEN = 'zai-token-must-never-be-echoed'

let dir: string
let app: Elysia
let cookie: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-secrets-route-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  resetLoginLimiter()
  app = await createApp()

  const setup = await app.handle(
    new Request('http://localhost/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  )
  const jar = setup.headers.getSetCookie()
  cookie = (jar.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) as string).split(';')[0] as string
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  resetLoginLimiter()
  await rm(dir, { recursive: true, force: true })
})

function post(body: unknown, withCookie = true): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (withCookie) headers.cookie = cookie
  return new Request('http://localhost/api/secrets', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function get(withCookie = true): Request {
  return new Request(
    'http://localhost/api/secrets',
    withCookie ? { headers: { cookie } } : undefined,
  )
}

describe('session guard', () => {
  test('both verbs are 401 without a session', async () => {
    expect((await app.handle(get(false))).status).toBe(401)
    expect((await app.handle(post({ zaiAuthToken: TOKEN }, false))).status).toBe(401)
  })
})

describe('GET /api/secrets', () => {
  test('returns the public view only', async () => {
    const body = await (await app.handle(get())).json()
    expect(body).toEqual({
      zaiBaseUrl: 'https://api.z.ai/api/anthropic',
      zaiAuthTokenConfigured: false,
      apiTokenConfigured: true,
      bind: '127.0.0.1:7777',
    })
  })
})

describe('POST /api/secrets/api-token/reveal', () => {
  test('requires a cookie', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/secrets/api-token/reveal', { method: 'POST' }),
    )
    expect(response.status).toBe(401)
  })

  test('returns the token value once per call', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/secrets/api-token/reveal', {
        method: 'POST',
        headers: { cookie },
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { apiToken: string }
    expect(body.apiToken.startsWith('mct_')).toBe(true)
  })
})

describe('POST /api/secrets/api-token/rotate', () => {
  test('requires a cookie', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/secrets/api-token/rotate', { method: 'POST' }),
    )
    expect(response.status).toBe(401)
  })

  test('invalidates the previous token', async () => {
    const revealed = await app.handle(
      new Request('http://localhost/api/secrets/api-token/reveal', { method: 'POST', headers: { cookie } }),
    )
    const before = ((await revealed.json()) as { apiToken: string }).apiToken

    const rotated = await app.handle(
      new Request('http://localhost/api/secrets/api-token/rotate', { method: 'POST', headers: { cookie } }),
    )
    expect(rotated.status).toBe(200)
    const after = ((await rotated.json()) as { apiToken: string }).apiToken
    expect(after).not.toBe(before)

    const rejected = await app.handle(
      new Request('http://localhost/api/jobs', { headers: { authorization: `Bearer ${before}` } }),
    )
    expect(rejected.status).toBe(401)
  })
})

describe('POST /api/secrets', () => {
  test('accepts a token, stores it, and never echoes the value', async () => {
    const response = await app.handle(post({ zaiAuthToken: TOKEN }))
    expect(response.status).toBe(200)

    const written = await response.text()
    expect(written).not.toContain(TOKEN)
    expect(JSON.parse(written)).toEqual({
      ok: true,
      zaiBaseUrl: 'https://api.z.ai/api/anthropic',
      zaiAuthTokenConfigured: true,
      apiTokenConfigured: true,
      bind: '127.0.0.1:7777',
    })

    const stored: unknown = JSON.parse(await readFile(configPath('secrets.json'), 'utf8'))
    expect((stored as { zaiAuthToken: string }).zaiAuthToken).toBe(TOKEN)

    const readBack = await (await app.handle(get())).text()
    expect(readBack).not.toContain(TOKEN)
    expect(JSON.parse(readBack).zaiAuthTokenConfigured).toBe(true)
  })

  test('updates the base url and a non-wildcard bind address', async () => {
    const response = await app.handle(
      post({ zaiBaseUrl: 'https://proxy.example.com/anthropic', bind: '100.101.102.103:7788' }),
    )
    expect(response.status).toBe(200)

    const body = await (await app.handle(get())).json()
    expect(body.zaiBaseUrl).toBe('https://proxy.example.com/anthropic')
    expect(body.bind).toBe('100.101.102.103:7788')
  })

  test('rejects a 0.0.0.0 bind without confirmAnyInterface', async () => {
    const response = await app.handle(post({ bind: '0.0.0.0:7788' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'any-interface bind requires confirmAnyInterface:true',
    })

    const body = await (await app.handle(get())).json()
    expect(body.bind).toBe('127.0.0.1:7777')
  })

  test('accepts a 0.0.0.0 bind when confirmAnyInterface is true', async () => {
    const response = await app.handle(post({ bind: '0.0.0.0:7788', confirmAnyInterface: true }))
    expect(response.status).toBe(200)

    const body = await (await app.handle(get())).json()
    expect(body.bind).toBe('0.0.0.0:7788')
  })

  test('accepts a tailscale-style non-wildcard IP without confirmAnyInterface', async () => {
    const response = await app.handle(post({ bind: '100.64.1.2:7788' }))
    expect(response.status).toBe(200)

    const body = await (await app.handle(get())).json()
    expect(body.bind).toBe('100.64.1.2:7788')
  })

  test('a partial write leaves the other values alone', async () => {
    await app.handle(post({ zaiAuthToken: TOKEN, zaiBaseUrl: 'https://one.example.com' }))
    await app.handle(post({ zaiBaseUrl: 'https://two.example.com' }))

    const body = await (await app.handle(get())).json()
    expect(body.zaiBaseUrl).toBe('https://two.example.com')
    expect(body.zaiAuthTokenConfigured).toBe(true)
  })

  test('rejects an empty patch', async () => {
    const response = await app.handle(post({}))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'nothing to update' })
  })

  test('rejects a blank token instead of clearing the stored one', async () => {
    await app.handle(post({ zaiAuthToken: TOKEN }))
    const response = await app.handle(post({ zaiAuthToken: '   ' }))
    expect(response.status).toBe(400)
    expect((await (await app.handle(get())).json()).zaiAuthTokenConfigured).toBe(true)
  })

  test('rejects a non-http base url', async () => {
    const response = await app.handle(post({ zaiBaseUrl: 'file:///etc/passwd' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'zaiBaseUrl must be an http(s) url' })
  })

  test('rejects a malformed bind address', async () => {
    const response = await app.handle(post({ bind: 'not-a-bind' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'bind must be host:port' })
  })
})
