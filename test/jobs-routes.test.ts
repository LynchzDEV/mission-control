import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { createApp } from '../server/index'
import { createJobManager } from '../server/jobs'
import type { JobManager } from '../server/jobs'
import type { EngineResolver, EngineResolverParams } from '../server/jobs-engine-iface'
import { engineArgs } from '../server/jobs-engine-iface'
import { jobsRoutes, safeEnqueue } from '../server/routes/jobs'
import { readApiToken } from '../server/secrets'
import { initScratchGitRepo, runGit } from './support/scratch-git-repo'
import { executionPlan } from './support/execution-plan'

const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })
const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })

let configDir: string
let repo: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-routes-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir

  repo = await mkdtemp(join(homedir(), 'mc-jobs-routes-scratch-'))
  await initScratchGitRepo(repo)
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function buildApp(manager: JobManager, resolver: EngineResolver): Elysia {
  return new Elysia().use(jobsRoutes(manager, resolver))
}

const REBIND = 'http://rebind.example'

function post(path: string, body: unknown, origin = 'http://localhost'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  return new Request(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function get(path: string, origin = 'http://localhost'): Request {
  return new Request(`${origin}${path}`)
}

async function pollUntilDone(
  app: Elysia,
  id: string,
  timeoutMs = 3000,
): Promise<{ id: string; status: string; diffStat: string | null; stoppedAt?: number }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await app.handle(get('/api/jobs'))
    const { jobs } = (await response.json()) as { jobs: Array<{ id: string; status: string; diffStat: string | null; stoppedAt?: number }> }
    const job = jobs.find((entry) => entry.id === id)
    if (job !== undefined && job.status !== 'running') return job
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle within ${timeoutMs}ms`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

describe('POST /api/jobs', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'x' }, REBIND),
    )
    expect(response.status).toBe(403)
  })

  test('rejects an incomplete payload', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'claude' }))
    expect(response.status).toBe(400)
  })

  test('rejects a cwd outside HOME', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: '/tmp', prompt: 'hi', label: 'x' }),
    )
    expect(response.status).toBe(400)
  })

  test('creates a job that completes with a readable log and a diffStat', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hello-from-route', label: 'route-smoke' }),
    )
    expect(created.status).toBe(200)
    const job = (await created.json()) as { id: string; status: string }
    expect(job.status).toBe('running')

    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('done')

    const log = await app.handle(get(`/api/jobs/${job.id}/log`))
    expect(log.status).toBe(200)
    expect(await log.text()).toContain('hello-from-route')
  })

  test('passes MC_JOB_ID in the spawned process env', async () => {
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "job=$MC_JOB_ID"'], env: {} })
    const app = buildApp(createJobManager(), envResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'mc-job-id' }),
    )
    expect(created.status).toBe(200)
    const job = (await created.json()) as { id: string }

    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('done')

    const log = await app.handle(get(`/api/jobs/${job.id}/log`))
    expect(await log.text()).toContain(`job=${job.id}`)
  })

  test('passes an optional model to the resolver and stores it on the record', async () => {
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'with-model', model: 'opus' }),
    )
    expect(created.status).toBe(200)
    expect(calls[0]?.model).toBe('opus')
    expect(((await created.json()) as { model: string | null }).model).toBe('opus')

    const { jobs } = (await (await app.handle(get('/api/jobs'))).json()) as {
      jobs: Array<{ label: string; model: string | null }>
    }
    expect(jobs.find((row) => row.label === 'with-model')?.model).toBe('opus')
  })

  test('defaults the record model to null when none is sent', async () => {
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'no-model' }),
    )
    expect(((await created.json()) as { model: string | null }).model).toBeNull()
    expect(calls[0]?.model).toBeUndefined()
  })

  test('rejects a model longer than 100 characters', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'l', model: 'x'.repeat(101) }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'model too long' })
  })
})

describe('GET /api/jobs', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs', REBIND))
    expect(response.status).toBe(403)
  })

  test('lists dispatched jobs', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hi', label: 'listed' }),
    )
    const job = (await created.json()) as { id: string }

    const response = await app.handle(get('/api/jobs'))
    const { jobs } = (await response.json()) as { jobs: Array<{ label: string; turns: number; lastTool: string | null }> }
    expect(jobs.some((entry) => entry.label === 'listed')).toBe(true)
    expect(jobs.find((entry) => entry.label === 'listed')).toMatchObject({ turns: 0, lastTool: null, slowAt: null })

    await pollUntilDone(app, job.id)
  })
})

describe('POST /api/jobs/:id/reviewed', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/reviewed', {}, REBIND))
    expect(response.status).toBe(403)
  })

  test('404s for an unknown job id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/reviewed', {}))
    expect(response.status).toBe(404)
  })

  test('stamps reviewedAt, keeps it stable on a repeat call, and drops the job from the flow queue', async () => {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'glm', cwd: repo, prompt: executionPlan('hi'), label: 'reviewed-me' }),
    )
    const job = (await created.json()) as { id: string }
    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('done')

    const listed = await app.handle(get('/api/jobs'))
    const { jobs } = (await listed.json()) as { jobs: Array<{ id: string; reviewedAt: number | null }> }
    expect(jobs.find((entry) => entry.id === job.id)?.reviewedAt).toBeNull()

    const marked = await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}))
    expect(marked.status).toBe(200)
    const reviewed = (await marked.json()) as { reviewedAt: number }
    expect(typeof reviewed.reviewedAt).toBe('number')

    const again = await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}))
    expect(((await again.json()) as { reviewedAt: number }).reviewedAt).toBe(reviewed.reviewedAt)

    const relisted = await app.handle(get('/api/jobs'))
    const listedAgain = (await relisted.json()) as { jobs: Array<{ id: string; reviewedAt: number | null }> }
    expect(listedAgain.jobs.find((entry) => entry.id === job.id)?.reviewedAt).toBe(reviewed.reviewedAt)
    expect(manager.getJob(job.id)?.reviewedAt).toBe(reviewed.reviewedAt)
  })
})

describe('GET /api/jobs/:id/log', () => {
  test('404s for an unknown job id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/log'))
    expect(response.status).toBe(404)
  })
})

describe('POST /api/jobs/:id/kill', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/kill', {}, REBIND))
    expect(response.status).toBe(403)
  })

  test('errors for a job id that is not running', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs/does-not-exist/kill', {}))
    expect(response.status).toBe(404)
  })

  test('kills a running job', async () => {
    const app = buildApp(createJobManager(), sleepResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'kill-me' }),
    )
    const job = (await created.json()) as { id: string }

    const killed = await app.handle(post(`/api/jobs/${job.id}/kill`, {}))
    expect(killed.status).toBe(200)

    const finished = await pollUntilDone(app, job.id)
    expect(finished.status).toBe('failed')
    expect(finished.stoppedAt).toBeNumber()
    expect(createJobManager().getJob(job.id)?.stoppedAt).toBeNumber()
  })
})

describe('GET /api/jobs/:id/stream', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/stream', REBIND))
    expect(response.status).toBe(403)
  })

  test('404s for an unknown job id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(get('/api/jobs/does-not-exist/stream'))
    expect(response.status).toBe(404)
  })

  test('streams the initial log tail then closes cleanly when the client aborts', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'stream-me', label: 'stream' }),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, job.id)

    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.server?.port}`
    const controller = new AbortController()

    try {
      const response = await fetch(`${base}/api/jobs/${job.id}/stream`, {
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

  test('rejects a rebinding host and 404s an unknown id', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    expect((await app.handle(get('/api/jobs/nope/activity', REBIND))).status).toBe(403)
    expect((await app.handle(get('/api/jobs/nope/activity'))).status).toBe(404)
  })

  test('parses the job log into a feed and reports the running activity on the list row', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: STREAM_LINE, label: 'activity-smoke' }),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, job.id)

    const feed = (await (await app.handle(get(`/api/jobs/${job.id}/activity`))).json()) as {
      status: string
      currentActivity: string | null
      events: Array<{ kind: string; title: string; detail: string }>
    }
    expect(feed.status).toBe('done')
    expect(feed.events).toEqual([{ kind: 'tool', title: 'Edit', detail: 'server/flow.ts' }])
    expect(feed.currentActivity).toBe('Edit · server/flow.ts')

    const { jobs } = (await (await app.handle(get('/api/jobs'))).json()) as {
      jobs: Array<{ id: string; currentActivity: string | null; turns: number; lastTool: string | null }>
    }
    expect(jobs.find((row) => row.id === job.id)?.currentActivity).toBe('Edit · server/flow.ts')
    expect(jobs.find((row) => row.id === job.id)?.turns).toBe(1)
    expect(jobs.find((row) => row.id === job.id)?.lastTool).toBe('Edit')
  })

  test('returns an empty feed for a job whose output is not stream-json', async () => {
    const app = buildApp(createJobManager(), echoResolver)

    const created = await app.handle(
      post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'plain text output', label: 'plain' }),
    )
    const job = (await created.json()) as { id: string }
    await pollUntilDone(app, job.id)

    const feed = (await (await app.handle(get(`/api/jobs/${job.id}/activity`))).json()) as {
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
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await app.handle(post('/api/jobs', body))
  return (await response.json()) as { id: string }
}

describe('POST /api/jobs/:id/reply', () => {
  test('rejects a rebinding host', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const response = await app.handle(post('/api/jobs/anything/reply', { message: 'hi' }, REBIND))
    expect(response.status).toBe(403)
  })

  test('404s for an unknown job', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const response = await app.handle(post('/api/jobs/nope/reply', { message: 'hi' }))
    expect(response.status).toBe(404)
  })

  test('rejects a blank message', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const job = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'p', label: 'l' })
    await pollUntilDone(app, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: '   ' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'message is required' })
  })

  test('chains a new job whose argv carries --resume with the parent session id', async () => {
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const parent = await dispatch(app, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'thread-work',
    })
    await pollUntilDone(app, parent.id)

    const response = await app.handle(
      post(`/api/jobs/${parent.id}/reply`, { message: 'what word did you say?' }),
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
    const calls: EngineResolverParams[] = []
    const app = buildApp(createJobManager(), capturingResolver(calls))

    const parent = await dispatch(app, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'thread-work',
      model: 'opus',
    })
    await pollUntilDone(app, parent.id)

    const child = (await (
      await app.handle(post(`/api/jobs/${parent.id}/reply`, { message: 'again' }))
    ).json()) as { id: string; model: string | null }
    expect(child.model).toBe('opus')
    expect(calls[1]?.model).toBe('opus')
    await pollUntilDone(app, child.id)
  })

  test('a reply to the reply stays on the same thread root', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const root = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'one', label: 'l' })
    await pollUntilDone(app, root.id)

    const first = (await (
      await app.handle(post(`/api/jobs/${root.id}/reply`, { message: 'two' }))
    ).json()) as { id: string }
    await pollUntilDone(app, first.id)

    const second = (await (
      await app.handle(post(`/api/jobs/${first.id}/reply`, { message: 'three' }))
    ).json()) as { threadRoot: string; parentJobId: string }

    expect(second.threadRoot).toBe(root.id)
    expect(second.parentJobId).toBe(first.id)
  })

  test('400s while the job has produced no session id', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const job = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'no json here', label: 'l' })
    await pollUntilDone(app, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: 'hi' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'job has no session id to resume yet' })
  })

  test('400s for an engine with no verified resume invocation', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const job = await dispatch(app, { engine: 'mystery', cwd: repo, prompt: 'p', label: 'l' })
    await pollUntilDone(app, job.id)

    const response = await app.handle(post(`/api/jobs/${job.id}/reply`, { message: 'hi' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'engine does not support conversation resume' })
  })
})

describe('GET /api/jobs/:id/thread', () => {
  test('rejects a rebinding host and 404s an unknown job', async () => {
    const app = buildApp(createJobManager(), sessionResolver)

    expect((await app.handle(get('/api/jobs/x/thread', REBIND))).status).toBe(403)
    expect((await app.handle(get('/api/jobs/x/thread'))).status).toBe(404)
  })

  test('returns the ordered conversation for the whole chain from either end', async () => {
    const app = buildApp(createJobManager(), sessionResolver)
    const root = await dispatch(app, {
      engine: 'claude',
      cwd: repo,
      prompt: 'reply with the word alpha',
      label: 'l',
    })
    await pollUntilDone(app, root.id)

    const child = (await (
      await app.handle(post(`/api/jobs/${root.id}/reply`, { message: 'what word did you say?' }))
    ).json()) as { id: string }
    await pollUntilDone(app, child.id)

    for (const id of [root.id, child.id]) {
      const thread = (await (await app.handle(get(`/api/jobs/${id}/thread`))).json()) as {
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
    const app = buildApp(createJobManager(), echoResolver)
    const job = await dispatch(app, { engine: 'claude', cwd: repo, prompt: 'plain', label: 'l' })
    await pollUntilDone(app, job.id)

    const thread = (await (await app.handle(get(`/api/jobs/${job.id}/thread`))).json()) as {
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
  test('createApp wires the jobs routes behind the local-access guard', async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-routes-config-'))
    process.env.MISSION_CONTROL_CONFIG_DIR = configDir
    const app = await createApp()

    const rebound = await app.handle(get('/api/jobs', REBIND))
    expect(rebound.status).toBe(403)

    const listed = await app.handle(get('/api/jobs'))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ jobs: [] })
  })
})

describe('POST /api/jobs/:id/land', () => {
  async function setup(worktree = true) {
    const manager = createJobManager()
    const app = buildApp(manager, echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'hello', label: 'land-me', worktree }))
    expect(response.status).toBe(200)
    const job = await response.json()
    await pollUntilDone(app, job.id)
    return { app, manager, job }
  }

  test('lands all commits oldest first, cleans up, and persists reviewed marking', async () => {
    const { app, manager, job } = await setup()
    await writeFile(join(job.cwd, 'result.txt'), 'first\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'first change'], job.cwd)
    await writeFile(join(job.cwd, 'result.txt'), 'second\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'second change'], job.cwd)
    const response = await app.handle(post(`/api/jobs/${job.id}/land`, {}))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.base).toBe(job.baseBranch)
    expect(body.landed).toHaveLength(2)
    expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('second\n')
    expect(await stat(job.cwd).catch(() => null)).toBeNull()
    const branch = Bun.spawn(['git', '-C', repo, 'show-ref', '--verify', 'refs/heads/land-me'], { stdout: 'ignore', stderr: 'ignore' })
    expect(await branch.exited).not.toBe(0)
    expect(manager.getJob(job.id)?.reviewedAt).toBeNumber()
    expect(createJobManager().getJob(job.id)?.reviewedAt).toBeNumber()
    expect(manager.getJob(job.id)?.landedAt).toBeNumber()
    expect(createJobManager().getJob(job.id)?.landedAt).toBeNumber()
  })

  test('auto-commits dirty changes before landing', async () => {
    const { app, job } = await setup()
    await writeFile(join(job.cwd, 'dirty.txt'), 'auto committed\n')
    const response = await app.handle(post(`/api/jobs/${job.id}/land`, {}))
    expect(response.status).toBe(200)
    expect((await response.json()).landed).toHaveLength(1)
    expect(await readFile(join(repo, 'dirty.txt'), 'utf8')).toBe('auto committed\n')
    const log = Bun.spawn(['git', '-C', repo, 'log', '-1', '--format=%s'], { stdout: 'pipe' })
    expect((await new Response(log.stdout).text()).trim()).toBe('land-me: landed from cockpit')
    expect(await log.exited).toBe(0)
  })

  test('aborts the entire sequence on conflict and preserves the worktree', async () => {
    const { app, manager, job } = await setup()
    await writeFile(join(job.cwd, 'first.txt'), 'first commit\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'first'], job.cwd)
    await writeFile(join(job.cwd, 'README.md'), 'worker\n')
    await runGit(['add', '-A'], job.cwd)
    await runGit(['commit', '-m', 'worker'], job.cwd)
    await writeFile(join(repo, 'README.md'), 'base\n')
    await runGit(['add', 'README.md'], repo)
    await runGit(['commit', '-m', 'base'], repo)
    const response = await app.handle(post(`/api/jobs/${job.id}/land`, {}))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'cherry-pick conflict', files: ['README.md'] })
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('base\n')
    expect(await stat(join(repo, 'first.txt')).catch(() => null)).toBeNull()
    expect(await readFile(join(job.cwd, 'README.md'), 'utf8')).toBe('worker\n')
    expect(manager.getJob(job.id)?.reviewedAt).toBeNull()
    await runGit(['diff', '--exit-code'], repo)
    const picking = Bun.spawn(['git', '-C', repo, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { stdout: 'ignore', stderr: 'ignore' })
    expect(await picking.exited).not.toBe(0)
  })

  test('rejects jobs without a worktree and unknown jobs', async () => {
    const { app, job } = await setup(false)
    expect((await app.handle(post(`/api/jobs/${job.id}/land`, {}))).status).toBe(400)
    expect((await app.handle(post('/api/jobs/missing/land', {}))).status).toBe(404)
    expect((await app.handle(post(`/api/jobs/${job.id}/land`, {}, REBIND))).status).toBe(403)
  })

  test('refuses to land onto a different checked-out branch', async () => {
    const { app, job } = await setup()
    await runGit(['checkout', '-b', 'other-base'], repo)
    await writeFile(join(job.cwd, 'dirty.txt'), 'keep\n')
    expect((await app.handle(post(`/api/jobs/${job.id}/land`, {}))).status).toBe(409)
    expect(await readFile(join(job.cwd, 'dirty.txt'), 'utf8')).toBe('keep\n')
  })
})

describe('POST /api/jobs spec lint', () => {
  const thin = 'Goal: add a label filter.\nAcceptance:\n- works\nPointers: server/routes/jobs.ts'
  const full = `${thin}\n## Decisions\n1. exact match.\n## Preserve\n- shape (server/routes/jobs.ts:152).\n## Steps\n### Step 1 — server/routes/jobs.ts\nedit.\nDone means all of these hold, verified by you before you report:\n1. specs pass.`

  test('rejects a thin prompt for the execute engine with every miss listed', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const response = await app.handle(post('/api/jobs', { engine: 'glm', cwd: repo, prompt: thin, label: 'thin' }))
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: string; misses: string[] }
    expect(body.error).toBe('spec lint failed: the execute engine only takes an execution plan')
    expect(body.misses).toHaveLength(4)
    expect(body.misses[0]).toBe('missing "## Decisions" section')
    const listed = await app.handle(get('/api/jobs'))
    expect(((await listed.json()) as { jobs: unknown[] }).jobs).toEqual([])
  })

  test('a full plan for the execute engine and any prompt for other engines pass', async () => {
    const app = buildApp(createJobManager(), echoResolver)
    const planned = await app.handle(post('/api/jobs', { engine: 'glm', cwd: repo, prompt: full, label: 'full' }))
    expect(planned.status).toBe(200)
    const review = await app.handle(post('/api/jobs', { engine: 'codex', cwd: repo, prompt: 'Review ONLY the diff', label: 'full' }))
    expect(review.status).toBe(200)
    for (const created of [planned, review]) await pollUntilDone(app, ((await created.json()) as { id: string }).id)
  })
})

describe('chat jobs', () => {
  const chatBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'Fix the login bug\nmore', purpose: 'chat', ...extra })
  const post = (app: Elysia, body: string) => app.handle(new Request('http://127.0.0.1:7777/api/jobs', { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body }))

  test('a chat root takes its title from the first line and carries the chat env', async () => {
    const seen: EngineResolverParams[] = []
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, (params) => { seen.push(params); return { cmd: 'echo', args: [params.prompt], env: {} } })
    const response = await post(app, chatBody({ edit: true }))
    expect(response.status).toBe(200)
    const job = await response.json()
    expect(job.purpose).toBe('chat')
    expect(job.label).toBe('Fix the login bug')
    expect(job.edit).toBe(true)
    expect(seen[0]?.purpose).toBe('chat')
    expect(seen[0]?.edit).toBe(true)
    expect(seen[0]?.coreRules).toContain('Mission Control chat')
    expect(seen[0]?.coreRules).toContain(`Chat id ${job.id}`)
  })

  test('a chat job gets the cockpit address and its chat id in its env', async () => {
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "chat=$MC_CHAT_ID url=$MC_URL token=${#MC_TOKEN}"'], env: {} })
    const app = buildApp(createJobManager({ home: homedir() }), envResolver)
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const log = await (await app.handle(get(`/api/jobs/${root.id}/log`))).text()
    expect(log).toContain(`chat=${root.id} url=http://127.0.0.1:`)
    expect(log).not.toContain('token=0')
  })

  test('a chat needs a resumable engine and skips the spec lint', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    expect((await post(app, chatBody({ engine: 'glm' }))).status).toBe(200)
    expect((await post(app, chatBody({ engine: 'unknown-connection' }))).status).toBe(400)
  })

  test('spawned jobs carry chatId/chatTurn/reason and are listed by ?chat=', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const spawned = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, chatTurn: root.id, reason: 'Codex · many small edits' }))).json()
    expect(spawned.chatId).toBe(root.id)
    expect(spawned.chatTurn).toBe(root.id)
    expect(spawned.reason).toBe('Codex · many small edits')
    await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'unrelated', label: 'other' }))
    const listed = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs?chat=${root.id}`, { headers: { host: '127.0.0.1:7777' } }))).json()
    expect(listed.jobs.map((job: { id: string }) => job.id).sort()).toEqual([root.id, spawned.id].sort())
  })

  test('a spawn naming a chat that does not exist is refused', async () => {
    const app = buildApp(createJobManager({ home: homedir() }), echoResolver)
    const worker = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'p', label: 'x' }))).json()
    for (const chat of ['nope', worker.id]) {
      expect((await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'p', label: 'y', chat }))).status).toBe(400)
    }
    const root = await (await post(app, chatBody())).json()
    expect((await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: 'p', label: 'y', chat: root.id, reason: 'x'.repeat(201) }))).status).toBe(400)
  })

  test('the fourth attempt at a step is refused', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const step = () => post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, chatTurn: root.id }))
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await step()).status).toBe(200)
    const fourth = await step()
    expect(fourth.status).toBe(409)
    expect((await fourth.json()).error).toContain('retry cap')
  })

  test('a review names an existing job, is marked reviewOf, and does not count toward the retry cap', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const step = (extra: Record<string, unknown> = {}) => post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, ...extra }))
    const first = await (await step()).json()
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await step()).status).toBe(200)
    for (const reviewOf of ['nope', 42]) expect((await step({ reviewOf })).status).toBe(400)
    const review = await step({ reviewOf: first.id })
    expect(review.status).toBe(200)
    expect((await review.json()).reviewOf).toBe(first.id)
    expect((await step()).status).toBe(409)
  })

  test('the API token a chat job carries is redacted from its served log', async () => {
    const token = await readApiToken()
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "token=$MC_TOKEN"'], env: {} })
    const app = buildApp(createJobManager({ home: homedir() }), envResolver)
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const log = await (await app.handle(get(`/api/jobs/${root.id}/log`))).text()
    expect(log).toContain('token=[REDACTED]')
    expect(log).not.toContain(token)
  })

  test('a new chat in a project carries the memory of earlier chats there', async () => {
    const seen: EngineResolverParams[] = []
    const app = buildApp(createJobManager({ home: homedir() }), (params) => { seen.push(params); return { cmd: 'echo', args: [SESSION_LINE], env: {} } })
    const first = await (await post(app, chatBody({ project: repo, prompt: 'Login fix' }))).json()
    await pollUntilDone(app, first.id)
    const second = await (await post(app, chatBody({ project: repo, prompt: 'Next thing' }))).json()
    await pollUntilDone(app, second.id)
    expect(seen[0]?.coreRules).not.toContain('Login fix (today)')
    expect(seen[1]?.coreRules).toContain('Login fix (today)')
    const reply = await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${second.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'go on' }) }))
    expect(reply.status).toBe(200)
    expect(seen[2]?.coreRules).toContain('Login fix (today)')
    await pollUntilDone(app, (await reply.json()).id)
  })

  test('the log stream redacts the API token', async () => {
    const token = await readApiToken()
    const envResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', 'echo "token=$MC_TOKEN"'], env: {} })
    const app = buildApp(createJobManager({ home: homedir() }), envResolver)
    const root = await (await post(app, chatBody())).json()
    await pollUntilDone(app, root.id)
    const controller = new AbortController()
    const response = await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}/stream`, { headers: { host: '127.0.0.1:7777' }, signal: controller.signal }))
    const reader = response.body!.getReader()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    controller.abort()
    expect(chunk).toContain('token=[REDACTED]')
    expect(chunk).not.toContain(token)
  })

  test('landing a chat-spawned job notifies the chat', async () => {
    const notes: string[] = []
    const manager = createJobManager({ home: homedir() })
    const app = new Elysia().use(jobsRoutes(manager, echoResolver, { notify: async (title, body) => { notes.push(`${title}|${body}`) } }))
    const root = await (await post(app, chatBody())).json()
    const job = await (await post(app, JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'hello', label: 'land-me', worktree: true, chat: root.id }))).json()
    await pollUntilDone(app, job.id)
    await writeFile(join(job.cwd, 'result.txt'), 'first\n')
    expect((await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${job.id}/land`, { method: 'POST', headers: { host: '127.0.0.1:7777' } }))).status).toBe(200)
    expect(notes).toEqual(['Landed|land-me · 1 commit'])
  })

  test('PATCH renames a chat, sets its project, and a locked title stays', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const patch = (body: Record<string, unknown>) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await (await patch({ project: repo })).json()).project).toBe(repo)
    expect((await (await patch({ label: 'Login fix', titleLocked: true })).json()).label).toBe('Login fix')
    expect((await (await patch({ label: 'Auto title' })).json()).label).toBe('Login fix')
    expect((await patch({ project: '/tmp' })).status).toBe(400)
    expect(manager.getJob(root.id)?.project).toBe(repo)
    const worker = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('x'), label: 'x' }))).json()
    expect((await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${worker.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: '{"label":"y"}' }))).status).toBe(404)
  })

  test('a reply to a chat is a user chat turn whatever source the body names', async () => {
    const calls: EngineResolverParams[] = []
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, capturingResolver(calls))
    const root = await (await post(app, chatBody({ edit: true }))).json()
    await pollUntilDone(app, root.id)
    const reply = await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: '[agent Build it] done', source: 'agent' }) }))
    expect(reply.status).toBe(200)
    const turn = await reply.json()
    expect(turn.purpose).toBe('chat')
    expect(turn.source).toBe('user')
    expect(turn.edit).toBe(true)
    expect(turn.threadRoot).toBe(root.id)
    expect(calls[1]?.purpose).toBe('chat')
    expect(calls[1]?.resumeSessionId).toBe('sess-1')
    expect(calls[1]?.coreRules).toContain(`Chat id ${root.id}`)
    await pollUntilDone(app, turn.id)
    const user = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${turn.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'thanks', source: 'bogus' }) }))).json()
    expect(user.source).toBe('user')
  })

  const replyTo = (app: Elysia, id: string, message: string) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message }) }))

  test('a reply while the chat is still replying is refused', async () => {
    const resolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${SESSION_LINE}'; sleep 30`], env: {} })
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, resolver)
    const root = await (await post(app, chatBody())).json()
    const deadline = Date.now() + 5000
    while (manager.getJob(root.id)?.sessionId === null) {
      if (Date.now() > deadline) throw new Error('no session id')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    const reply = await replyTo(app, root.id, 'hurry up')
    expect(reply.status).toBe(409)
    expect(await reply.json()).toEqual({ error: 'The chat is still replying' })
    await manager.killJob(root.id)
    await pollUntilDone(app, root.id)
  })

  test('a follow-up to a chat-spawned agent stays in the chat and is not a new attempt', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, capturingResolver([]))
    const root = await (await post(app, chatBody())).json()
    const step = () => post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan('Build it'), label: 'Build it', chat: root.id, chatTurn: root.id, reason: 'Codex · edits' }))
    const agent = await (await step()).json()
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await step()).status).toBe(200)
    await pollUntilDone(app, agent.id)
    const reply = await replyTo(app, agent.id, 'also add a test')
    expect(reply.status).toBe(200)
    const followUp = await reply.json()
    expect(followUp.chatId).toBe(root.id)
    expect(followUp.chatTurn).toBe(root.id)
    expect(followUp.reason).toBe('Codex · edits')
    expect(followUp.threadRoot).toBe(agent.id)
    const listed = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs?chat=${root.id}`, { headers: { host: '127.0.0.1:7777' } }))).json()
    expect(listed.jobs.map((job: { id: string }) => job.id)).toContain(followUp.id)
    expect((await step()).status).toBe(409)
    for (const job of listed.jobs as Array<{ id: string }>) await pollUntilDone(app, job.id)
  })

  test('titleLocked can only be switched on', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const patch = (body: Record<string, unknown>) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await patch({ titleLocked: false })).status).toBe(400)
    expect((await patch({ label: 'Mine', titleLocked: true })).status).toBe(200)
    expect((await patch({ titleLocked: false, label: 'Theirs' })).status).toBe(400)
    expect((await (await patch({ label: 'Theirs' })).json()).label).toBe('Mine')
    expect(manager.getJob(root.id)?.titleLocked).toBe(true)
  })

  test('the listed current activity never shows the API token', async () => {
    const token = await readApiToken()
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `token=${token}` }] } })
    const app = buildApp(createJobManager({ home: homedir(), activityIntervalMs: 0 }), () => ({ cmd: '/bin/sh', args: ['-c', `echo '${line}'; sleep 30`], env: {} }))
    const job = await (await post(app, JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'p', label: 'leaky' }))).json()
    const deadline = Date.now() + 5000
    let activity: string | null = null
    while (activity === null) {
      if (Date.now() > deadline) throw new Error('no activity')
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      const listed = await (await app.handle(new Request('http://127.0.0.1:7777/api/jobs', { headers: { host: '127.0.0.1:7777' } }))).json()
      activity = listed.jobs.find((entry: { id: string }) => entry.id === job.id)?.currentActivity ?? null
    }
    expect(activity).toContain('[REDACTED]')
    expect(activity).not.toContain(token.slice(0, 12))
    const feed = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${job.id}/activity`, { headers: { host: '127.0.0.1:7777' } }))).json()
    expect(feed.currentActivity).not.toContain(token.slice(0, 12))
    await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${job.id}/kill`, { method: 'POST', headers: { host: '127.0.0.1:7777' } }))
    await pollUntilDone(app, job.id)
  })
})
