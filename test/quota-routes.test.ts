import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-quota-routes-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  resetLoginLimiter()
  app = await createApp()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  resetLoginLimiter()
  await rm(dir, { recursive: true, force: true })
})

function get(path: string): Request {
  return new Request(`http://localhost${path}`)
}

describe('quota routes are mounted and guarded', () => {
  test('GET /api/quota requires a session', async () => {
    const response = await app.handle(get('/api/quota'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  test('GET /api/sessions/external requires a session', async () => {
    const response = await app.handle(get('/api/sessions/external'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })
})
