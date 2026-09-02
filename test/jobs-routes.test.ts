import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { SESSION_COOKIE, completeSetup, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import { createJobManager } from '../server/jobs'
import type { JobManager } from '../server/jobs'
import type { EngineResolver, EngineResolverParams } from '../server/jobs-engine-iface'
import { engineArgs } from '../server/jobs-engine-iface'
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

  test('passes an optional model to the resolver and stores it on the record', async () => {
    const cookie = await authCookie()
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'with-model', model: 'opus' }, cookie),
    )
    expect(created.status).toBe(200)
    expect(calls[0]?.model).toBe('opus')
    expect(((await created.json()) as { model: string | null }).model).toBe('opus')

    const { jobs } = (await (await app.handle(get('/api/jobs', cookie))).json()) as {
      jobs: Array<{ label: string; model: string | null }>
    }
    expect(jobs.find((row) => row.label === 'with-model')?.model).toBe('opus')
  })

  test('defaults the record model to null when none is sent', async () => {
    const cookie = await authCookie()
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'no-model' }, cookie),
    )
    expect(((await created.json()) as { model: string | null }).model).toBeNull()
    expect(calls[0]?.model).toBeUndefined()
  })

  test('rejects a model longer than 100 characters', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'l', model: 'x'.repeat(101) }, cookie),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'model too long' })
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

describe('POST /api/jobs/:id/reviewed', () => {
  test('rejects an unauthenticated request', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/reviewed', {}))
    expect(response.status).toBe(401)
  })

  test('404s for an unknown job id', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/reviewed', {}, cookie))
    expect(response.status).toBe(404)
  })

  test('stamps reviewedAt, keeps it stable on a repeat call, and drops the job from the flow queue', async () => {
    const cookie = await authCookie()
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'glm', cwd: repo, prompt: 'hi', label: 'reviewed-me' }, cookie),
    )
    const job = (await created.json()) as { id: string }
    const finished = await pollUntilDone(app, cookie, job.id)
    expect(finished.status).toBe('done')

    const listed = await app.handle(get('/api/jobs', cookie))
    const { jobs } = (await listed.json()) as { jobs: Array<{ id: string; reviewedAt: number | null }> }
    expect(jobs.find((entry) => entry.id === job.id)?.reviewedAt).toBeNull()

    const marked = await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}, cookie))
    expect(marked.status).toBe(200)
    const reviewed = (await marked.json()) as { reviewedAt: number }
    expect(typeof reviewed.reviewedAt).toBe('number')

    const again = await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}, cookie))
    expect(((await again.json()) as { reviewedAt: number }).reviewedAt).toBe(reviewed.reviewedAt)

    const relisted = await app.handle(get('/api/jobs', cookie))
    const listedAgain = (await relisted.json()) as { jobs: Array<{ id: string; reviewedAt: number | null }> }
    expect(listedAgain.jobs.find((entry) => entry.id === job.id)?.reviewedAt).toBe(reviewed.reviewedAt)
    expect(manager.getJob(job.id)?.reviewedAt).toBe(reviewed.reviewedAt)
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

describe('GET /api/jobs/:id/activity', () => {
  const STREAM_LINE =
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"server/flow.ts"}}]}}'

  test('rejects an unauthenticated request and 404s an unknown id', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)

    expect((await app.handle(get('/api/jobs/nope/activity'))).status).toBe(401)
    expect((await app.handle(get('/api/jobs/nope/activity', cookie))).status).toBe(404)
  })

  test('parses the job log into a feed and reports the running activity on the list row', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: STREAM_LINE, label: 'activity-smoke' }, cookie),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, cookie, job.id)

    const feed = (await (await app.handle(get(`/api/jobs/${job.id}/activity`, cookie))).json()) as {
      status: string
      currentActivity: string | null
      events: Array<{ kind: string; title: string; detail: string }>
    }
    expect(feed.status).toBe('done')
    expect(feed.events).toEqual([{ kind: 'tool', title: 'Edit', detail: 'server/flow.ts' }])
    expect(feed.currentActivity).toBe('Edit · server/flow.ts')

    const { jobs } = (await (await app.handle(get('/api/jobs', cookie))).json()) as {
      jobs: Array<{ id: string; currentActivity: string | null }>
    }
    expect(jobs.find((row) => row.id === job.id)?.currentActivity).toBe('Edit · server/flow.ts')
  })

  test('returns an empty feed for a job whose output is not stream-json', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'plain text output', label: 'plain' }, cookie),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, cookie, job.id)

    const feed = (await (await app.handle(get(`/api/jobs/${job.id}/activity`, cookie))).json()) as {
      currentActivity: string | null
      events: unknown[]
    }
    expect(feed.events).toEqual([])
    expect(feed.currentActivity).toBeNull()
  })
})

const SESSION_LINE = '{"type":"system","subtype":"init","session_id":"sess-1"}'

// Echoes one real init line so the pump finds a session id exactly the way it does for claude.
const sessionResolver: EngineResolver = () => ({ cmd: 'echo', args: [SESSION_LINE], env: {} })

function capturingResolver(calls: EngineResolverParams[]): EngineResolver {
  return (params) => {
    calls.push(params)
    return { cmd: 'echo', args: [SESSION_LINE], env: {} }
  }
}

async function dispatch(
  app: Elysia,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await app.handle(post('/api/jobs', body, cookie))
  return (await response.json()) as { id: string }
}

describe('POST /api/jobs/:id/reply', () => {
  test('rejects an unauthenticated request', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const response = await app.handle(post('/api/jobs/anything/reply', { message: 'hi' }))
    expect(response.status).toBe(401)
  })

  test('404s for an unknown job', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), sessionResolver)
    const response = await app.handle(post('/api/jobs/nope/reply', { message: 'hi' }, cookie))
    expect(response.status).toBe(404)
  })

  test('rejects a blank message', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), sessionResolver)
    const job = await dispatch(app, cookie, { engine: 'claude', cwd: repo, prompt: 'p', label: 'l' })
    await pollUntilDone(app, cookie, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: '   ' }, cookie))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'message is required' })
  })

  test('chains a new job whose argv carries --resume with the parent session id', async () => {
    const cookie = await authCookie()
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const parent = await dispatch(app, cookie, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'thread-work',
    })
    await pollUntilDone(app, cookie, parent.id)

    const response = await app.handle(
      post(`/api/jobs/${parent.id}/reply`, { message: 'what word did you say?' }, cookie),
    )
    expect(response.status).toBe(200)
    const child = (await response.json()) as {
      id: string
      engine: string
      cwd: string
      label: string
      prompt: string
      parentJobId: string
      threadRoot: string
    }

    expect(child.id).not.toBe(parent.id)
    expect(child.engine).toBe('claude')
    expect(child.label).toBe('thread-work')
    expect(child.prompt).toBe('what word did you say?')
    expect(child.parentJobId).toBe(parent.id)
    expect(child.threadRoot).toBe(parent.id)

    expect(calls[1]?.resumeSessionId).toBe('sess-1')
    expect(engineArgs('claude', 'what word did you say?', calls[1]?.resumeSessionId)).toEqual([
      '--resume',
      'sess-1',
      '-p',
      'what word did you say?',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
    expect(calls[0]?.resumeSessionId).toBeUndefined()
  })

  test('a reply inherits the parent model', async () => {
    const cookie = await authCookie()
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const parent = await dispatch(app, cookie, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'thread-work',
      model: 'opus',
    })
    await pollUntilDone(app, cookie, parent.id)

    const child = (await (
      await app.handle(post(`/api/jobs/${parent.id}/reply`, { message: 'again' }, cookie))
    ).json()) as { id: string; model: string | null }
    expect(child.model).toBe('opus')
    expect(calls[1]?.model).toBe('opus')
    await pollUntilDone(app, cookie, child.id)
  })

  test('a reply to the reply stays on the same thread root', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), sessionResolver)
    const root = await dispatch(app, cookie, { engine: 'claude', cwd: repo, prompt: 'one', label: 'l' })
    await pollUntilDone(app, cookie, root.id)

    const first = (await (
      await app.handle(post(`/api/jobs/${root.id}/reply`, { message: 'two' }, cookie))
    ).json()) as { id: string }
    await pollUntilDone(app, cookie, first.id)

    const second = (await (
      await app.handle(post(`/api/jobs/${first.id}/reply`, { message: 'three' }, cookie))
    ).json()) as { threadRoot: string; parentJobId: string }

    expect(second.threadRoot).toBe(root.id)
    expect(second.parentJobId).toBe(first.id)
  })

  test('400s while the job has produced no session id', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const job = await dispatch(app, cookie, { engine: 'claude', cwd: repo, prompt: 'no json here', label: 'l' })
    await pollUntilDone(app, cookie, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: 'hi' }, cookie))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'job has no session id to resume yet' })
  })

  test('400s for an engine with no verified resume invocation', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), sessionResolver)
    const job = await dispatch(app, cookie, { engine: 'mystery', cwd: repo, prompt: 'p', label: 'l' })
    await pollUntilDone(app, cookie, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: 'hi' }, cookie))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'engine does not support conversation resume' })
  })
})

describe('GET /api/jobs/:id/thread', () => {
  test('rejects an unauthenticated request and 404s an unknown job', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), sessionResolver)

    expect((await app.handle(get('/api/jobs/x/thread'))).status).toBe(401)
    expect((await app.handle(get('/api/jobs/x/thread', cookie))).status).toBe(404)
  })

  test('returns the ordered conversation for the whole chain from either end', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), sessionResolver)
    const root = await dispatch(app, cookie, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'l',
    })
    await pollUntilDone(app, cookie, root.id)

    const child = (await (
      await app.handle(post(`/api/jobs/${root.id}/reply`, { message: 'what word did you say?' }, cookie))
    ).json()) as { id: string }
    await pollUntilDone(app, cookie, child.id)

    for (const id of [root.id, child.id]) {
      const thread = (await (await app.handle(get(`/api/jobs/${id}/thread`, cookie))).json()) as {
        rootId: string
        engine: string
        running: boolean
        canReply: boolean
        sessionId: string | null
        messages: Array<{ role: string; kind: string; text: string; jobId: string }>
      }

      expect(thread.rootId).toBe(root.id)
      expect(thread.engine).toBe('claude')
      expect(thread.running).toBe(false)
      expect(thread.canReply).toBe(true)
      expect(thread.sessionId).toBe('sess-1')

      const prompts = thread.messages.filter((message) => message.role === 'user')
      expect(prompts.map((message) => message.text)).toEqual([
        'reply with the word alpha',
        'what word did you say?',
      ])
      expect(prompts.map((message) => message.jobId)).toEqual([root.id, child.id])
    }
  })

  test('reports canReply false while no session id has appeared', async () => {
    const cookie = await authCookie()
    const app = buildApp(createJobManager(), echoResolver)
    const job = await dispatch(app, cookie, { engine: 'claude', cwd: repo, prompt: 'plain', label: 'l' })
    await pollUntilDone(app, cookie, job.id)

    const thread = (await (await app.handle(get(`/api/jobs/${job.id}/thread`, cookie))).json()) as {
      canReply: boolean
      sessionId: string | null
      messages: unknown[]
    }
    expect(thread.canReply).toBe(false)
    expect(thread.sessionId).toBeNull()
    expect(thread.messages).toHaveLength(1)
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
