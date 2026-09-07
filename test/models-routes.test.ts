import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { SESSION_COOKIE, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import { readApiToken } from '../server/secrets'

const PASSWORD = 'correct-horse-battery'

let dir: string
let app: Elysia
let cookie: string
let apiToken: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-models-route-'))
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
  apiToken = await readApiToken()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  resetLoginLimiter()
  await rm(dir, { recursive: true, force: true })
})

describe('GET /api/models', () => {
  test('401 without a session cookie', async () => {
    const response = await app.handle(new Request('http://localhost/api/models'))
    expect(response.status).toBe(401)
  })

  test('200 with all three engines', async () => {
    const response = await app.handle(new Request('http://localhost/api/models', { headers: { cookie } }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['claude', 'codex', 'glm'])
    for (const engine of ['claude', 'codex', 'glm']) {
      expect(Array.isArray(body[engine])).toBe(true)
    }
  })

  test('a Bearer API token can read it', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/models', { headers: { authorization: `Bearer ${apiToken}` } }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { claude: string[] }
    expect(Array.isArray(body.claude)).toBe(true)
  })
})
