import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { SESSION_COOKIE, completeSetup, resetLoginLimiter } from '../server/auth'
import { createJobManager, type JobRecord } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { createPlanRunner, type PlanRunner } from '../server/plan-runner'
import { createPlanStore } from '../server/plans'
import { runsRoutes } from '../server/routes/runs'
import { initScratchGitRepo } from './support/scratch-git-repo'

const PASSWORD = 'correct horse battery'
const PREAMBLE = '## Decisions\n1. as written.\n## Preserve\n- all (server/index.ts).\nDone means all of these hold, verified by you before you report:\n1. pass.'
const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })

let configDir: string
let repo: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-runs-routes-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  resetLoginLimiter()
  repo = await mkdtemp(join(homedir(), 'mc-runs-routes-scratch-'))
  await initScratchGitRepo(repo)
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  resetLoginLimiter()
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

async function authCookie(): Promise<string> {
  const result = await completeSetup(PASSWORD)
  if (!result.ok) throw new Error('setup failed')
  return `${SESSION_COOKIE}=${result.token}`
}

function build(): { app: Elysia; runner: PlanRunner } {
  let runner!: PlanRunner
  const manager = createJobManager({ onJobSettled: (record: JobRecord) => void runner.onJobSettled(record) })
  runner = createPlanRunner({ manager, resolver: sleepResolver, plans: createPlanStore() })
  return { app: new Elysia().use(runsRoutes(runner)), runner }
}

function request(path: string, method: string, body?: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  return new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

describe('/api/flow/:label/run', () => {
  test('requires a session', async () => {
    const { app } = build()
    expect((await app.handle(request('/api/flow/x/run', 'POST', {}))).status).toBe(401)
    expect((await app.handle(request('/api/flow/x/run', 'GET'))).status).toBe(401)
  })

  test('400 on a malformed body, 422 with misses on a thin task', async () => {
    const cookie = await authCookie()
    const { app } = build()
    const malformed = await app.handle(request('/api/flow/t/run', 'POST', { engine: 'glm', cwd: repo, preamble: PREAMBLE, tasks: [] }, cookie))
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'tasks must be a non-empty array' })
    const thin = await app.handle(request('/api/flow/t/run', 'POST', { engine: 'glm', cwd: repo, preamble: 'x', tasks: [{ title: 'a', prompt: 'b' }] }, cookie))
    expect(thin.status).toBe(422)
    const body = (await thin.json()) as { error: string; misses: string[] }
    expect(body.error).toBe('spec lint failed for task 1')
    expect(body.misses[0]).toBe('missing "## Decisions" section')
  })

  test('starts a run, reads it back, refuses a duplicate, and stops it', async () => {
    const cookie = await authCookie()
    const { app, runner } = build()
    const payload = { engine: 'glm', cwd: repo, preamble: PREAMBLE, tasks: [{ title: 'first', prompt: 'edit server/index.ts' }] }
    const started = await app.handle(request('/api/flow/my%20ticket/run', 'POST', payload, cookie))
    expect(started.status).toBe(200)
    const run = (await started.json()) as { label: string; status: string; tasks: Array<{ status: string; jobId: string }> }
    expect(run.label).toBe('my ticket'); expect(run.status).toBe('running'); expect(run.tasks[0]!.status).toBe('running')

    const read = await app.handle(request('/api/flow/my%20ticket/run', 'GET', undefined, cookie))
    expect(((await read.json()) as { status: string }).status).toBe('running')
    expect((await app.handle(request('/api/flow/nope/run', 'GET', undefined, cookie))).status).toBe(404)
    expect((await app.handle(request('/api/flow/my%20ticket/run', 'POST', payload, cookie))).status).toBe(409)

    const stopped = await app.handle(request('/api/flow/my%20ticket/run/stop', 'POST', undefined, cookie))
    expect(stopped.status).toBe(200)
    expect(runner.get('my ticket')?.status).toBe('stopped')
    expect((await app.handle(request('/api/flow/my%20ticket/run/stop', 'POST', undefined, cookie))).status).toBe(409)
  })
})
