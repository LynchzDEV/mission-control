import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { SESSION_COOKIE, completeSetup, resetLoginLimiter } from '../server/auth'
import { createJobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { flowRoutes } from '../server/routes/flow'
import { jobsRoutes } from '../server/routes/jobs'
import { createTerminalRegistry } from '../server/terminals'
import { initScratchGitRepo } from './support/scratch-git-repo'

const PASSWORD = 'correct-horse-battery'
const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })

type FlowBody = {
  source: string
  current: string
  sessions: Record<string, Record<string, [string, string]>>
  reviewCount: number
  mergedToday: number
}

let configDir: string
let repo: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-flow-routes-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  resetLoginLimiter()
  repo = await mkdtemp(join(homedir(), 'mc-flow-routes-scratch-'))
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
  if (!result.ok) throw new Error('test harness setup failed')
  return `${SESSION_COOKIE}=${result.token}`
}

function post(path: string, body: unknown, cookie: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
}

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {}
  if (cookie !== undefined) headers.cookie = cookie
  return new Request(`http://localhost${path}`, { headers })
}

describe('GET /api/flow', () => {
  test('requires a session', async () => {
    const app = new Elysia().use(flowRoutes(createJobManager(), createTerminalRegistry()))
    expect((await app.handle(get('/api/flow'))).status).toBe(401)
  })

  test('derives a live session from a dispatched job and follows it through review', async () => {
    const cookie = await authCookie()
    const manager = createJobManager()
    const app = new Elysia()
      .use(jobsRoutes(manager, echoResolver))
      .use(flowRoutes(manager, createTerminalRegistry()))

    const created = await app.handle(
      post('/api/jobs', { engine: 'glm', cwd: repo, prompt: 'hi', label: 'flow-smoke' }, cookie),
    )
    const job = (await created.json()) as { id: string }

    const deadline = Date.now() + 3_000
    for (;;) {
      if (manager.getJob(job.id)?.status !== 'running') break
      if (Date.now() > deadline) throw new Error('job did not settle')
      await new Promise((wait) => setTimeout(wait, 20))
    }

    const before = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(before.source).toBe('live')
    expect(before.current).toBe('flow-smoke')
    expect(before.sessions['flow-smoke']?.spec?.[0]).toBe('done')
    expect(before.sessions['flow-smoke']?.impl?.[0]).toBe('done')
    expect(before.sessions['flow-smoke']?.codex).toEqual(['queued', 'CODEX · QUEUED'])
    expect(before.sessions['flow-smoke']?.merged?.[0]).toBe('future')

    await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}, cookie))

    const after = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(after.sessions['flow-smoke']?.merged?.[0]).toBe('done')
    expect(after.reviewCount).toBe(0)
  })
})
