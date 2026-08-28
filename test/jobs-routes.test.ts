import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { SESSION_COOKIE, completeSetup, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import { createJobManager } from '../server/jobs'
import type { JobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { jobsRoutes, safeEnqueue } from '../server/routes/jobs'
import { initScratchGitRepo } from './support/scratch-git-repo'

const PASSWORD = 'correct-horse-battery'

const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })
const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })

let configDir: string
let repo: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-routes-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  resetLoginLimiter()

  repo = await mkdtemp(join(homedir(), 'mc-jobs-routes-scratch-'))
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

function buildApp(manager: JobManager, resolver: EngineResolver): Elysia {
  return new Elysia().use(jobsRoutes(manager, resolver))
}

function post(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  return new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {}
  if (cookie !== undefined) headers.cookie = cookie
  return new Request(`http://localhost${path}`, { headers })
}

async function pollUntilDone(
  app: Elysia,
  cookie: string,
  id: string,
  timeoutMs = 3000,
): Promise<{ id: string; status: string; diffStat: string | null }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await app.handle(get('/api/jobs', cookie))
    const { jobs } = (await response.json()) as { jobs: Array<{ id: string; status: string; diffStat: string | null }> }
    const job = jobs.find((entry) => entry.id === id)
    if (job !== undefined && job.status !== 'running') return job
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle within ${timeoutMs}ms`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

describe('POST /api/jobs', () => {
  test('rejects an unauthenticated request', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'x' }),
    )
    expect(response.status).toBe(401)
  })

  test('rejects an incomplete payload', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'claude' }, cookie))
    expect(response.status).toBe(400)
  })

  test('rejects a cwd outside HOME', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: '/tmp', prompt: 'hi', label: 'x' }, cookie),
    )
    expect(response.status).toBe(400)
  })

  test('creates a job that completes with a readable log and a diffStat', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hello-from-route', label: 'route-smoke' }, cookie),
    )
    expect(created.status).toBe(200)
    const job = (await created.json()) as { id: string; status: string }
    expect(job.status).toBe('running')

    const finished = await pollUntilDone(app, cookie, job.id)
    expect(finished.status).toBe('done')

    const log = await app.handle(get(`/api/jobs/${job.id}/log`, cookie))
    expect(log.status).toBe(200)
    expect(await log.text()).toContain('hello-from-route')
  })
})

describe('GET /api/jobs', () => {
  test('rejects an unauthenticated request', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs'))
    expect(response.status).toBe(401)
  })

  test('lists dispatched jobs', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'listed' }, cookie),
    )
    const job = (await created.json()) as { id: string }

    const response = await app.handle(get('/api/jobs', cookie))
    const { jobs } = (await response.json()) as { jobs: Array<{ label: string }> }
    expect(jobs.some((entry) => entry.label === 'listed')).toBe(true)

    await pollUntilDone(app, cookie, job.id)
  })
})

describe('GET /api/jobs/:id/log', () => {
  test('404s for an unknown job id', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/log', cookie))
    expect(response.status).toBe(404)
  })
})

describe('POST /api/jobs/:id/kill', () => {
  test('rejects an unauthenticated request', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/kill', {}))
    expect(response.status).toBe(401)
  })

  test('errors for a job id that is not running', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/kill', {}, cookie))
    expect(response.status).toBe(404)
  })

  test('kills a running job', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), sleepResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'kill-me' }, cookie),
    )
    const job = (await created.json()) as { id: string }

    const killed = await app.handle(post(`/api/jobs/${job.id}/kill`, {}, cookie))
    expect(killed.status).toBe(200)

    const finished = await pollUntilDone(app, cookie, job.id)
    expect(finished.status).toBe('failed')
  })
})

describe('GET /api/jobs/:id/stream', () => {
  test('rejects an unauthenticated request', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/stream'))
    expect(response.status).toBe(401)
  })

  test('404s for an unknown job id', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/stream', cookie))
    expect(response.status).toBe(404)
  })

  test('streams the initial log tail then closes cleanly when the client aborts', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'stream-me', label: 'stream' }, cookie),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, cookie, job.id)

    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.server?.port}`
    const controller = new AbortController()

    try {
      const response = await fetch(`${base}/api/jobs/${job.id}/stream`, {
        headers: { cookie },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')

      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      const { value } = await reader!.read()
      const chunk = new TextDecoder().decode(value)
      expect(chunk).toContain('data:')
      expect(chunk).toContain('stream-me')

      controller.abort()
      await expect(reader!.read()).rejects.toBeDefined()
    } finally {
      server.stop(true)
    }
  })
})

describe('safeEnqueue', () => {
  test('skips enqueue once already closed', () => {
    let called = false
    safeEnqueue({ enqueue: () => (called = true) }, () => true, 'chunk')
    expect(called).toBe(false)
  })

  test('enqueues when not closed', () => {
    let received: string | null = null
    safeEnqueue<string>({ enqueue: (chunk) => (received = chunk) }, () => false, 'chunk')
    expect(received).toBe('chunk')
  })

  test('swallows a throw from enqueue on an already-torn-down controller', () => {
    const torndown = {
      enqueue: () => {
        throw new TypeError('Invalid state: Controller is already closed')
      },
    }
    expect(() => safeEnqueue(torndown, () => false, 'chunk')).not.toThrow()
  })
})

describe('mounted in the real app', () => {
  test('createApp wires the jobs routes behind the session guard', async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-routes-config-'))
    process.env.MISSION_CONTROL_CONFIG_DIR = configDir
    const app = await createApp()

    const unauthed = await app.handle(get('/api/jobs'))
    expect(unauthed.status).toBe(401)

    const setup = await app.handle(post('/api/setup', { password: PASSWORD }))
    const jar = setup.headers.getSetCookie()
    const cookie = jar.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0]
    expect(cookie).toBeDefined()

    const listed = await app.handle(get('/api/jobs', cookie))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ jobs: [] })
  })
})
