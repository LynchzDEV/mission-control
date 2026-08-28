import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { deriveFlow, planOnlySession, sessionKey, type SessionFlow } from '../flow'
import type { JobManager, JobRecord } from '../jobs'
import { createPlanStore, isStepStatus, parsePlanInput, type Plan, type PlanStore } from '../plans'
import type { TerminalRegistry } from '../terminals'

export type { SessionFlow, Stage, StageState } from '../flow'

export type FlowSession = SessionFlow & {
  plan: Plan | null
  currentActivity: string | null
  activityJobId: string | null
}

export type FlowResponse = {
  source: 'live'
  current: string
  sessions: Record<string, FlowSession>
  reviewCount: number
  mergedToday: number
}

function activityJob(jobs: readonly JobRecord[], label: string): JobRecord | null {
  const owned = jobs.filter((job) => sessionKey(job) === label)
  if (owned.length === 0) return null
  const running = owned.filter((job) => job.status === 'running')
  const pool = running.length > 0 ? running : owned
  return pool.reduce((best, job) => (job.startedAt > best.startedAt ? job : best))
}

export function flowSnapshot(
  manager: JobManager,
  registry: TerminalRegistry,
  plans: PlanStore,
  now: number = Date.now(),
): FlowResponse {
  const jobs = manager.listJobs()
  const derived = deriveFlow({ jobs, terminals: registry.list(), now })
  const stored = plans.all()

  const labels = [...new Set([...Object.keys(derived.sessions), ...Object.keys(stored)])]
  const sessions: Record<string, FlowSession> = {}
  for (const label of labels) {
    const job = activityJob(jobs, label)
    sessions[label] = {
      ...(derived.sessions[label] ?? planOnlySession()),
      plan: stored[label] ?? null,
      currentActivity: job === null ? null : manager.currentActivity(job.id),
      activityJobId: job?.id ?? null,
    }
  }

  const current = derived.current !== '' ? derived.current : (labels[0] ?? '')
  return { ...derived, source: 'live', sessions, current }
}

export function flowRoutes(
  manager: JobManager,
  registry: TerminalRegistry,
  plans: PlanStore = createPlanStore(),
): Elysia {
  return new Elysia()
    .onBeforeHandle(requireSession)
    .get('/api/flow', () => flowSnapshot(manager, registry, plans))
    .post('/api/flow/:label/plan', async ({ params, body, set }) => {
      const parsed = parsePlanInput(body)
      if (!parsed.ok) {
        set.status = 400
        return { error: parsed.error }
      }
      return await plans.attach(decodeURIComponent(params.label), parsed.value)
    })
    .patch('/api/flow/:label/plan/:index', async ({ params, body, set }) => {
      const status = (body as { status?: unknown } | null)?.status
      if (!isStepStatus(status)) {
        set.status = 400
        return { error: 'status must be pending, active, or done' }
      }
      const result = await plans.patchStep(
        decodeURIComponent(params.label),
        Number.parseInt(params.index, 10),
        status,
      )
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.plan
    })
}
