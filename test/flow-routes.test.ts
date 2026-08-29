import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { createArchiveStore } from '../server/archive'
import { SESSION_COOKIE, completeSetup, resetLoginLimiter } from '../server/auth'
import { createJobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { createPlanStore } from '../server/plans'
import { flowRoutes } from '../server/routes/flow'
import { jobsRoutes } from '../server/routes/jobs'
import { createTerminalRegistry } from '../server/terminals'
import { initScratchGitRepo } from './support/scratch-git-repo'

const PASSWORD = 'correct-horse-battery'
const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })

type PlanBody = {
  label: string
  steps: Array<{ title: string; assignee: string; status: string }>
  next: string | null
  updatedAt: number
}

type StageBody = [string, string]

type FlowSessionBody = {
  spec: StageBody
  impl: StageBody
  codex: StageBody
  verify: StageBody
  merged: StageBody
  plan: PlanBody | null
  currentActivity: string | null
  activityJobId: string | null
  archived: boolean
  finished: boolean
}

type FlowBody = {
  source: string
  current: string
  sessions: Record<string, FlowSessionBody>
  reviewCount: number
  mergedToday: number
  archivedCount: number
}

const PLAN_STEPS = [
  { title: 'Spec the parser', assignee: 'claude', status: 'done' },
  { title: 'Implement it', assignee: 'glm', status: 'active' },
  { title: 'Cross-review', assignee: 'codex' },
]

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

function patch(path: string, body: unknown, cookie: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'PATCH',
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

  test('carries the live activity line and job id of the session', async () => {
    const cookie = await authCookie()
    const manager = createJobManager()
    const app = new Elysia()
      .use(jobsRoutes(manager, echoResolver))
      .use(flowRoutes(manager, createTerminalRegistry()))

    const prompt =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"description":"Run the suite"}}]}}'
    const created = await app.handle(
      post('/api/jobs', { engine: 'glm', cwd: repo, prompt, label: 'activity-flow' }, cookie),
    )
    const job = (await created.json()) as { id: string }

    const deadline = Date.now() + 3_000
    for (;;) {
      if (manager.getJob(job.id)?.status !== 'running') break
      if (Date.now() > deadline) throw new Error('job did not settle')
      await new Promise((wait) => setTimeout(wait, 20))
    }

    const body = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(body.sessions['activity-flow']?.currentActivity).toBe('Bash · Run the suite')
    expect(body.sessions['activity-flow']?.activityJobId).toBe(job.id)
  })
})

describe('session plans', () => {
  function planApp(store = createPlanStore()): Elysia {
    return new Elysia().use(flowRoutes(createJobManager(), createTerminalRegistry(), store))
  }

  test('requires a session on both plan endpoints', async () => {
    const app = planApp()
    expect((await app.handle(new Request('http://localhost/api/flow/x/plan', { method: 'POST' }))).status).toBe(401)
    expect(
      (await app.handle(new Request('http://localhost/api/flow/x/plan/0', { method: 'PATCH' }))).status,
    ).toBe(401)
  })

  test('attaches a plan to a label and serves it back on the flow response', async () => {
    const cookie = await authCookie()
    const app = planApp()

    const attached = await app.handle(
      post('/api/flow/plan-demo/plan', { steps: PLAN_STEPS, next: 'human verify on uat' }, cookie),
    )
    expect(attached.status).toBe(200)
    const plan = (await attached.json()) as PlanBody
    expect(plan.label).toBe('plan-demo')
    expect(plan.steps).toEqual([
      { title: 'Spec the parser', assignee: 'claude', status: 'done' },
      { title: 'Implement it', assignee: 'glm', status: 'active' },
      { title: 'Cross-review', assignee: 'codex', status: 'pending' },
    ])
    expect(plan.next).toBe('human verify on uat')

    const flow = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(flow.current).toBe('plan-demo')
    expect(flow.sessions['plan-demo']?.plan?.steps.length).toBe(3)
    expect(flow.sessions['plan-demo']?.currentActivity).toBeNull()
    expect(flow.sessions['plan-demo']?.spec?.[0]).toBe('done')
  })

  test('rejects a malformed plan body', async () => {
    const cookie = await authCookie()
    const app = planApp()

    expect((await app.handle(post('/api/flow/plan-demo/plan', { steps: [] }, cookie))).status).toBe(400)
    expect(
      (await app.handle(post('/api/flow/plan-demo/plan', { steps: [{ title: 'a', assignee: 'nobody' }] }, cookie)))
        .status,
    ).toBe(400)
  })

  test('patches one step status and reflects it on the flow response', async () => {
    const cookie = await authCookie()
    const app = planApp()
    await app.handle(post('/api/flow/plan-demo/plan', { steps: PLAN_STEPS }, cookie))

    const patched = await app.handle(patch('/api/flow/plan-demo/plan/2', { status: 'done' }, cookie))
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as PlanBody).steps.map((step) => step.status)).toEqual([
      'done',
      'active',
      'done',
    ])

    const flow = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(flow.sessions['plan-demo']?.plan?.steps[2]?.status).toBe('done')
  })

  test('404s an unknown label or index and 400s an unknown status', async () => {
    const cookie = await authCookie()
    const app = planApp()
    await app.handle(post('/api/flow/plan-demo/plan', { steps: PLAN_STEPS }, cookie))

    expect((await app.handle(patch('/api/flow/nobody-home/plan/0', { status: 'done' }, cookie))).status).toBe(404)
    expect((await app.handle(patch('/api/flow/plan-demo/plan/9', { status: 'done' }, cookie))).status).toBe(404)
    expect((await app.handle(patch('/api/flow/plan-demo/plan/0', { status: 'blocked' }, cookie))).status).toBe(400)
  })

  test('survives a manager reload — a fresh store rereads the persisted plan', async () => {
    const cookie = await authCookie()
    await planApp().handle(post('/api/flow/plan-demo/plan', { steps: PLAN_STEPS }, cookie))

    const reloaded = planApp()
    const flow = (await (await reloaded.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(flow.sessions['plan-demo']?.plan?.steps.map((step) => step.title)).toEqual([
      'Spec the parser',
      'Implement it',
      'Cross-review',
    ])
  })
})

describe('session archiving', () => {
  function archiveApp(archives = createArchiveStore()) {
    const manager = createJobManager()
    const app = new Elysia()
      .use(jobsRoutes(manager, echoResolver))
      .use(flowRoutes(manager, createTerminalRegistry(), createPlanStore(), archives))
    return { manager, app }
  }

  async function finishedJob(
    app: Elysia,
    manager: ReturnType<typeof createJobManager>,
    cookie: string,
    label: string,
  ): Promise<void> {
    const created = await app.handle(
      post('/api/jobs', { engine: 'glm', cwd: repo, prompt: 'hi', label }, cookie),
    )
    const job = (await created.json()) as { id: string }
    const deadline = Date.now() + 3_000
    for (;;) {
      if (manager.getJob(job.id)?.status !== 'running') break
      if (Date.now() > deadline) throw new Error('job did not settle')
      await new Promise((wait) => setTimeout(wait, 20))
    }
    await app.handle(post(`/api/jobs/${job.id}/reviewed`, {}, cookie))
  }

  test('requires a session on both archive endpoints', async () => {
    const { app } = archiveApp()
    expect(
      (await app.handle(new Request('http://localhost/api/flow/x/archive', { method: 'POST' }))).status,
    ).toBe(401)
    expect(
      (await app.handle(new Request('http://localhost/api/flow/x/unarchive', { method: 'POST' }))).status,
    ).toBe(401)
  })

  test('a finished session archives, is excluded by default, and reappears with includeArchived', async () => {
    const cookie = await authCookie()
    const { app, manager } = archiveApp()
    await finishedJob(app, manager, cookie, 'archive-smoke')

    const before = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(before.sessions['archive-smoke']?.finished).toBe(true)
    expect(before.sessions['archive-smoke']?.archived).toBe(false)

    expect((await app.handle(post('/api/flow/archive-smoke/archive', {}, cookie))).status).toBe(200)

    const defaultView = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(defaultView.sessions['archive-smoke']).toBeUndefined()
    expect(defaultView.archivedCount).toBe(1)

    const withArchived = (await (await app.handle(get('/api/flow?includeArchived=1', cookie))).json()) as FlowBody
    expect(withArchived.sessions['archive-smoke']?.archived).toBe(true)
    expect(withArchived.archivedCount).toBe(1)

    expect((await app.handle(post('/api/flow/archive-smoke/unarchive', {}, cookie))).status).toBe(200)
    const restored = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(restored.sessions['archive-smoke']?.archived).toBe(false)
    expect(restored.archivedCount).toBe(0)
  })

  test('archiving persists across a store reload', async () => {
    const cookie = await authCookie()
    const archives = createArchiveStore()
    const { app, manager } = archiveApp(archives)
    await finishedJob(app, manager, cookie, 'archive-reload')
    await app.handle(post('/api/flow/archive-reload/archive', {}, cookie))

    const reloadedArchives = createArchiveStore()
    expect(reloadedArchives.isArchived('archive-reload')).toBe(true)
  })

  test('mergedToday still counts an archived session', async () => {
    const cookie = await authCookie()
    const { app, manager } = archiveApp()
    await finishedJob(app, manager, cookie, 'archive-merged')

    const before = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(before.mergedToday).toBe(1)

    await app.handle(post('/api/flow/archive-merged/archive', {}, cookie))

    const after = (await (await app.handle(get('/api/flow', cookie))).json()) as FlowBody
    expect(after.mergedToday).toBe(1)
  })
})
