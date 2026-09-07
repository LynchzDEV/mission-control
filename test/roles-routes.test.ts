import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { SESSION_COOKIE, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import { parseRoles } from '../server/routes/roles'
import { DEFAULT_ROLES, readConfig } from '../server/secrets'

const PASSWORD = 'correct-horse-battery'

let dir: string
let app: Elysia
let cookie: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-roles-route-'))
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

function request(method: string, body?: unknown, withCookie = true): Request {
  const headers: Record<string, string> = {}
  if (withCookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request('http://localhost/api/roles', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('parseRoles', () => {
  test('accepts any engine per role and rejects unknown or missing engines', () => {
    expect(parseRoles({ plan: 'glm', execute: 'glm', review: 'glm' })).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'glm', model: null },
        execute: { engine: 'glm', model: null },
        review: { engine: 'glm', model: null },
      },
    })
    expect(parseRoles({ plan: 'claude', execute: 'gpt', review: 'codex' }).ok).toBe(false)
    expect(parseRoles({ plan: 'claude', review: 'codex' }).ok).toBe(false)
    expect(parseRoles(null).ok).toBe(false)
  })

  test('accepts the nested form with an optional model, trimmed, empty to null', () => {
    expect(
      parseRoles({
        plan: { engine: 'claude', model: ' opus ' },
        execute: { engine: 'glm', model: '   ' },
        review: { engine: 'codex', model: 'gpt-5.1' },
      }),
    ).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'claude', model: 'opus' },
        execute: { engine: 'glm', model: null },
        review: { engine: 'codex', model: 'gpt-5.1' },
      },
    })
    expect(parseRoles({ plan: { engine: 'claude' }, execute: 'glm', review: 'codex' })).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'claude', model: null },
        execute: { engine: 'glm', model: null },
        review: { engine: 'codex', model: null },
      },
    })
  })

  test('accepts the flat settings-form shape with role_model keys', () => {
    expect(
      parseRoles({ plan: 'claude', plan_model: 'fable', execute: 'glm', execute_model: '', review: 'codex' }),
    ).toEqual({
      ok: true,
      roles: {
        plan: { engine: 'claude', model: 'fable' },
        execute: { engine: 'glm', model: null },
        review: { engine: 'codex', model: null },
      },
    })
  })

  test('rejects a model longer than 100 characters', () => {
    expect(parseRoles({ plan: 'claude', plan_model: 'x'.repeat(101), execute: 'glm', review: 'codex' })).toEqual({
      ok: false,
      error: 'plan model too long',
    })
  })

  test('parses autoReview from booleans or on/off strings, and rejects junk', () => {
    expect(parseRoles({ plan: 'claude', execute: 'glm', review: 'codex', autoReview: true })).toEqual({
      ok: true,
      roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: null } },
      autoReview: true,
    })
    expect(parseRoles({ plan: 'claude', execute: 'glm', review: 'codex', autoReview: 'off' })).toEqual({
      ok: true,
      roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: null } },
      autoReview: false,
    })
    expect(parseRoles({ plan: 'claude', execute: 'glm', review: 'codex', autoReview: 'nope' }).ok).toBe(false)
  })
})

describe('/api/roles', () => {
  test('GET returns defaults and requires a session', async () => {
    expect((await app.handle(request('GET', undefined, false))).status).toBe(401)
    const response = await app.handle(request('GET'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...DEFAULT_ROLES, autoReview: false })
  })

  test('POST persists the full nested mapping and GET reflects it', async () => {
    const next = {
      plan: { engine: 'claude', model: null },
      execute: { engine: 'codex', model: 'gpt-5.1' },
      review: { engine: 'claude', model: null },
    }
    const saved = await app.handle(request('POST', next))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ ...next, autoReview: false })
    expect((await readConfig()).roles).toEqual(next)
    expect(await (await app.handle(request('GET'))).json()).toEqual({ ...next, autoReview: false })
  })

  test('POST accepts the flat settings form and returns the nested shape', async () => {
    const saved = await app.handle(
      request('POST', { plan: 'claude', plan_model: 'opus', execute: 'glm', review: 'codex' }),
    )
    expect(saved.status).toBe(200)
    const nested = {
      plan: { engine: 'claude', model: 'opus' },
      execute: { engine: 'glm', model: null },
      review: { engine: 'codex', model: null },
    }
    expect(await saved.json()).toEqual({ ...nested, autoReview: false })
    expect((await readConfig()).roles).toEqual(nested)
  })

  test('POST autoReview on persists and a later POST without the field leaves it unchanged', async () => {
    const saved = await app.handle(
      request('POST', { plan: 'claude', execute: 'glm', review: 'codex', autoReview: 'on' }),
    )
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({
      plan: { engine: 'claude', model: null },
      execute: { engine: 'glm', model: null },
      review: { engine: 'codex', model: null },
      autoReview: true,
    })
    expect((await readConfig()).autoReview).toBe(true)

    const after = await app.handle(request('POST', { plan: 'codex', execute: 'glm', review: 'claude' }))
    expect(await after.json()).toEqual({
      plan: { engine: 'codex', model: null },
      execute: { engine: 'glm', model: null },
      review: { engine: 'claude', model: null },
      autoReview: true,
    })
  })

  test('POST rejects a partial or invalid mapping without touching storage', async () => {
    expect((await app.handle(request('POST', { plan: 'claude' }))).status).toBe(400)
    expect((await app.handle(request('POST', { plan: 'claude', execute: 'nope', review: 'codex' }))).status).toBe(400)
    expect((await readConfig()).roles).toEqual(DEFAULT_ROLES)
  })
})
