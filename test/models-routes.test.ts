import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'
import { readApiToken } from '../server/secrets'

let dir: string
let app: Elysia
let apiToken: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-models-route-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  app = await createApp()
  apiToken = await readApiToken()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('GET /api/models', () => {
  test('403 for a rebinding host', async () => {
    const response = await app.handle(new Request('http://rebind.example/api/models'))
    expect(response.status).toBe(403)
  })

  test('200 with all three engines', async () => {
    const response = await app.handle(new Request('http://localhost/api/models'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['claude', 'codex', 'glm'])
    for (const engine of ['claude', 'codex', 'glm']) {
      expect(Array.isArray(body[engine])).toBe(true)
    }
  })

  test('a Bearer API token can read it', async () => {
    const response = await app.handle(
      new Request('http://rebind.example/api/models', { headers: { authorization: `Bearer ${apiToken}` } }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { claude: string[] }
    expect(Array.isArray(body.claude)).toBe(true)
  })
})
