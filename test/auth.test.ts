import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { allowToken, verifyBearerToken } from '../server/auth'
import { readApiToken } from '../server/secrets'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-auth-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('allowToken', () => {
  test('allows GET and POST on /api/jobs and its subpaths', () => {
    expect(allowToken('/api/jobs', 'GET')).toBe(true)
    expect(allowToken('/api/jobs', 'POST')).toBe(true)
    expect(allowToken('/api/jobs/abc/log', 'GET')).toBe(true)
    expect(allowToken('/api/jobs/abc/reviewed', 'POST')).toBe(true)
    expect(allowToken('/api/jobs/abc/kill', 'POST')).toBe(true)
  })

  test('allows GET only on /api/flow, /api/quota, /api/meta, /api/roles', () => {
    for (const path of ['/api/flow', '/api/quota', '/api/meta', '/api/roles']) {
      expect(allowToken(path, 'GET')).toBe(true)
      expect(allowToken(path, 'POST')).toBe(false)
    }
  })

  test('allows POST and GET on per-label run endpoints', () => {
    expect(allowToken('/api/flow/my-ticket/run', 'POST')).toBe(true)
    expect(allowToken('/api/flow/my-ticket/run', 'GET')).toBe(true)
    expect(allowToken('/api/flow/my-ticket/run/stop', 'POST')).toBe(true)
    expect(allowToken('/api/flow/my-ticket/run/stop', 'DELETE')).toBe(false)
  })

  test('allows POST/PATCH on per-label plan endpoints', () => {
    expect(allowToken('/api/flow/my-ticket/plan', 'POST')).toBe(true)
    expect(allowToken('/api/flow/my-ticket/plan/2', 'PATCH')).toBe(true)
    expect(allowToken('/api/flow/my-ticket/plan', 'GET')).toBe(false)
    expect(allowToken('/api/flow/my-ticket/plan/x', 'PATCH')).toBe(false)
    expect(allowToken('/api/flow/my-ticket/other', 'POST')).toBe(false)
  })

  test('allows POST on per-label archive/unarchive endpoints', () => {
    expect(allowToken('/api/flow/my-ticket/archive', 'POST')).toBe(true)
    expect(allowToken('/api/flow/my-ticket/unarchive', 'POST')).toBe(true)
    expect(allowToken('/api/flow/my-ticket/archive', 'GET')).toBe(false)
    expect(allowToken('/api/flow/my-ticket/unarchive', 'PATCH')).toBe(false)
  })

  test('is case-insensitive on method', () => {
    expect(allowToken('/api/jobs', 'get')).toBe(true)
    expect(allowToken('/api/flow', 'get')).toBe(true)
  })

  test('rejects settings, secrets, and terminals paths entirely', () => {
    for (const path of ['/api/secrets', '/api/secrets/api-token/reveal', '/api/terminals', '/settings']) {
      expect(allowToken(path, 'GET')).toBe(false)
      expect(allowToken(path, 'POST')).toBe(false)
    }
  })

  test('rejects a path that merely shares the /api/jobs prefix without a separator', () => {
    expect(allowToken('/api/jobsx', 'GET')).toBe(false)
  })

  test('rejects other methods on scoped paths', () => {
    expect(allowToken('/api/jobs', 'DELETE')).toBe(false)
    expect(allowToken('/api/flow', 'DELETE')).toBe(false)
  })
})

describe('verifyBearerToken', () => {
  test('accepts the real token and rejects a wrong one', async () => {
    const token = await readApiToken()
    expect(await verifyBearerToken(`Bearer ${token}`)).toBe(true)
    expect(await verifyBearerToken(`Bearer ${token}x`)).toBe(false)
    expect(await verifyBearerToken('Bearer wrong-token-entirely')).toBe(false)
  })

  test('rejects a missing or malformed header', async () => {
    await readApiToken()
    expect(await verifyBearerToken(null)).toBe(false)
    expect(await verifyBearerToken('')).toBe(false)
    expect(await verifyBearerToken('Bearer')).toBe(false)
    expect(await verifyBearerToken('Basic dXNlcjpwYXNz')).toBe(false)
  })
})
