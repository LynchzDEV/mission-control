import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createConnectionStore } from '../server/agent-connections'
import { createApp } from '../server/index'
import { modelsCache } from '../server/routes/models'
import { readApiToken } from '../server/secrets'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-providers-route-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  app = await createApp()
  modelsCache.invalidate()
})

afterEach(async () => {
  modelsCache.invalidate()
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('GET /api/providers', () => {
  test('lists built-ins and saved connections', async () => {
    await createConnectionStore(dir).save({ id: 'qwen', name: 'Qwen Code', adapter: 'acp', command: 'qwen', args: ['--acp'], models: ['qwen3-coder'] })
    const response = await app.handle(new Request('http://localhost/api/providers'))
    expect(response.status).toBe(200)
    const { providers } = (await response.json()) as { providers: Array<{ id: string }> }
    expect(providers.map(p => p.id)).toEqual(['claude', 'glm', 'codex', 'qwen'])
  })

  test('403 for a rebinding host without a token', async () => {
    const response = await app.handle(new Request('http://rebind.example/api/providers'))
    expect(response.status).toBe(403)
  })

  test('the bearer token may read it', async () => {
    const response = await app.handle(new Request('http://rebind.example/api/providers', { headers: { host: 'rebind.example:7777', authorization: `Bearer ${await readApiToken()}` } }))
    expect(response.status).toBe(200)
  })
})
