import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-http-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  app = await createApp()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

function get(path: string, cookie?: string): Request {
  return new Request(
    `http://localhost${path}`,
    cookie === undefined ? undefined : { headers: { cookie } },
  )
}

describe('health', () => {
  test('GET /api/health is public and returns ok', async () => {
    const response = await app.handle(get('/api/health'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('GET /api/health ignores a leftover session cookie and still answers', async () => {
    const response = await app.handle(get('/api/health', 'mc_session=1.2.3'))
    expect(response.status).toBe(200)
  })
})

describe('local access', () => {
  test('GET / serves the app shell to a local browser', async () => {
    const response = await app.handle(get('/'))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-page="app"')
  })
  test('a foreign Origin is refused on data routes', async () => {
    const response = await app.handle(new Request('http://127.0.0.1/api/jobs', { headers: { host: '127.0.0.1:7777', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }))
    expect(response.status).toBe(403)
  })
  test('a rebinding Host is refused everywhere but health', async () => {
    expect((await app.handle(new Request('http://rebind.example/api/jobs', { headers: { host: 'rebind.example:7777' } }))).status).toBe(403)
    expect((await app.handle(new Request('http://rebind.example/api/health', { headers: { host: 'rebind.example:7777' } }))).status).toBe(200)
  })
  test('login, setup and logout endpoints no longer exist', async () => {
    for (const path of ['/api/setup', '/api/login', '/api/logout']) {
      const response = await app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
      expect(response.status).toBe(404)
    }
  })
})

describe('real socket', () => {
  test('serves health and a guarded route over an ephemeral port with no login', async () => {
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.server?.port}`

    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(200)
      expect((await fetch(`${base}/api/jobs`)).status).toBe(200)
      expect((await fetch(`${base}/api/jobs`, { headers: { host: 'rebind.example:7777' } })).status).toBe(403)
    } finally {
      server.stop()
    }
  })
})
