import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { SESSION_COOKIE, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import { readApiToken } from '../server/secrets'
import { initScratchGitRepo } from './support/scratch-git-repo'

const PASSWORD = 'correct-horse-battery'

let configDir: string
let repo: string
let app: Elysia
let cookie: string
let apiToken: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-api-token-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  process.env.MC_FAKE_ENGINES = '1'
  resetLoginLimiter()

  repo = await mkdtemp(join(homedir(), 'mc-api-token-scratch-'))
  await initScratchGitRepo(repo)

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
  delete process.env.MC_FAKE_ENGINES
  resetLoginLimiter()
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function bearer(path: string, method = 'GET', body?: unknown): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${apiToken}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('bearer token scope', () => {
  test('works for POST and GET /api/jobs', async () => {
    const created = await app.handle(
      bearer('/api/jobs', 'POST', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'token-job' }),
    )
    expect(created.status).toBe(200)

    const listed = await app.handle(bearer('/api/jobs'))
    expect(listed.status).toBe(200)
    const { jobs } = (await listed.json()) as { jobs: Array<{ label: string }> }
    expect(jobs.some((entry) => entry.label === 'token-job')).toBe(true)
  })

  // /api/quota and /api/meta's scope is covered by the allowToken() unit tests in auth.test.ts —
  // hitting either real route here would shell out to ccusage, same tradeoff meta.test.ts documents.
  test('works for GET /api/flow', async () => {
    const response = await app.handle(bearer('/api/flow'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { source: string }
    expect(body.source).toBe('live')
  })

  test('is rejected on /api/secrets and /api/terminals', async () => {
    expect((await app.handle(bearer('/api/secrets'))).status).toBe(401)
    expect((await app.handle(bearer('/api/terminals'))).status).toBe(401)
    expect((await app.handle(bearer('/api/secrets/api-token/reveal', 'POST', {}))).status).toBe(401)
  })

  test('a wrong token is rejected everywhere', async () => {
    const headers = { authorization: 'Bearer mct_wrong-token-value' }
    expect((await app.handle(new Request('http://localhost/api/jobs', { headers }))).status).toBe(401)
    expect((await app.handle(new Request('http://localhost/api/flow', { headers }))).status).toBe(401)
  })

  test('reveal still requires a cookie even with a valid bearer token on an unrelated request', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/secrets/api-token/reveal', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}` },
      }),
    )
    expect(response.status).toBe(401)
  })

  test('works for POST /api/flow/:label/archive and /unarchive', async () => {
    const archived = await app.handle(bearer('/api/flow/token-archive-smoke/archive', 'POST', {}))
    expect(archived.status).toBe(200)
    const unarchived = await app.handle(bearer('/api/flow/token-archive-smoke/unarchive', 'POST', {}))
    expect(unarchived.status).toBe(200)
  })

  test('the cookie flow still works alongside the token scope', async () => {
    const response = await app.handle(new Request('http://localhost/api/jobs', { headers: { cookie } }))
    expect(response.status).toBe(200)
  })
})
