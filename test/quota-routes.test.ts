import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-quota-routes-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  app = await createApp()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

function rebound(path: string): Request {
  return new Request(`http://rebind.example${path}`)
}

describe('quota routes are mounted and guarded', () => {
  test('GET /api/quota refuses a rebinding host', async () => {
    const response = await app.handle(rebound('/api/quota'))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'local access only' })
  })

  test('GET /api/sessions/external refuses a rebinding host', async () => {
    const response = await app.handle(rebound('/api/sessions/external'))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'local access only' })
  })
})
