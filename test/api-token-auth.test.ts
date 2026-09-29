import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { allowToken } from '../server/auth'
import { createApp } from '../server/index'
import { readApiToken } from '../server/secrets'
import { initScratchGitRepo } from './support/scratch-git-repo'

const NON_LOCAL = 'http://rebind.example'

let configDir: string
let repo: string
let app: Elysia
let apiToken: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-api-token-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  process.env.MC_FAKE_ENGINES = '1'

  repo = await mkdtemp(join(homedir(), 'mc-api-token-scratch-'))
  await initScratchGitRepo(repo)

  app = await createApp()
  apiToken = await readApiToken()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  delete process.env.MC_FAKE_ENGINES
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function bearer(path: string, method = 'GET', body?: unknown): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${apiToken}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`${NON_LOCAL}${path}`, {
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
  test('works for GET /api/studio/runs', async () => {
    const response = await app.handle(bearer('/api/studio/runs'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { runs: unknown[] }
    expect(body.runs).toEqual([])
  })

  test('is rejected on /api/secrets and /api/terminals', async () => {
    expect((await app.handle(bearer('/api/secrets'))).status).toBe(403)
    expect((await app.handle(bearer('/api/terminals'))).status).toBe(403)
    expect((await app.handle(bearer('/api/secrets/api-token/reveal', 'POST', {}))).status).toBe(403)
  })

  test('a wrong token is rejected everywhere', async () => {
    const headers = { authorization: 'Bearer mct_wrong-token-value' }
    expect((await app.handle(new Request(`${NON_LOCAL}/api/jobs`, { headers }))).status).toBe(403)
    expect((await app.handle(new Request(`${NON_LOCAL}/api/studio/runs`, { headers }))).status).toBe(403)
  })

  test('reveal stays out of token scope even with a valid bearer token', async () => {
    const response = await app.handle(
      new Request(`${NON_LOCAL}/api/secrets/api-token/reveal`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}` },
      }),
    )
    expect(response.status).toBe(403)
  })

  test('a plain local request works alongside the token scope', async () => {
    const response = await app.handle(new Request('http://localhost/api/jobs'))
    expect(response.status).toBe(200)
  })
})

test('dispatch tokens can read workflow versions but cannot edit policy or connections', async () => {
  expect((await app.handle(bearer('/api/studio/workflows'))).status).toBe(200)
  expect((await app.handle(bearer('/api/studio/policy'))).status).toBe(200)
  expect((await app.handle(bearer('/api/studio/runs'))).status).toBe(200)
  for (const path of ['/api/studio/workflows', '/api/studio/policy', '/api/studio/connections', '/api/studio/default', '/api/studio/drafts', '/api/studio/drafts/unknown/stop']) {
    expect((await app.handle(bearer(path, 'POST', {}))).status).toBe(403)
  }
})

test('dispatch tokens can approve, reject, pause and resume runs but not flip the approval switch or subscribe to studio events', () => {
  for (const action of ['approve', 'reject', 'pause', 'resume']) expect(allowToken(`/api/studio/runs/abc/${action}`, 'POST')).toBe(true)
  expect(allowToken('/api/studio/runs/abc/approve', 'GET')).toBe(false)
  expect(allowToken('/api/flow-approval', 'PUT')).toBe(false)
  expect(allowToken('/api/studio/events', 'GET')).toBe(false)
})

test('dispatch tokens can propose a change to a run but not save it as a workflow', () => {
  expect(allowToken('/api/studio/runs/x/changes', 'POST')).toBe(true)
  expect(allowToken('/api/studio/runs/x/changes', 'GET')).toBe(false)
  expect(allowToken('/api/studio/runs/x/save', 'POST')).toBe(false)
})

test('dispatch tokens can read and report an In Session step', () => {
  expect(allowToken('/api/studio/runs/x/steps/plan', 'POST')).toBe(true)
  expect(allowToken('/api/studio/runs/x/steps/plan', 'GET')).toBe(true)
  expect(allowToken('/api/studio/runs/x/steps/plan', 'DELETE')).toBe(false)
})
