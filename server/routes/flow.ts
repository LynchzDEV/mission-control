import { Elysia } from 'elysia'

import {
  type ArchiveStore,
  createArchiveStore,
  sessionLastActivity,
  sessionsDueForAutoArchive,
} from '../archive'
import { requireSession } from '../auth'
import { deriveFlow, isSessionFinished, jobsForSession, planOnlySession, sessionKey, type SessionFlow } from '../flow'
import type { JobManager, JobRecord } from '../jobs'
import { createPlanStore, isStepStatus, parsePlanInput, type Plan, type PlanStore } from '../plans'
import type { TerminalRegistry } from '../terminals'

export type { SessionFlow, Stage, StageState } from '../flow'

export type FlowSession = SessionFlow & {
  plan: Plan | null
  currentActivity: string | null
  activityJobId: string | null
  archived: boolean
  finished: boolean
}

export type FlowResponse = {
  source: 'live'
  current: string
  sessions: Record<string, FlowSession>
  reviewCount: number
  mergedToday: number
  archivedCount: number
}

export type FlowSnapshotOptions = {
  now?: number
  includeArchived?: boolean
}

function activityJob(jobs: readonly JobRecord[], label: string): JobRecord | null {
  const owned = jobs.filter((job) => sessionKey(job) === label)
  if (owned.length === 0) return null
  const running = owned.filter((job) => job.status === 'running')
  const pool = running.length > 0 ? running : owned
  return pool.reduce((best, job) => (job.startedAt > best.startedAt ? job : best))
}

export async function flowSnapshot(
  manager: JobManager,
  registry: TerminalRegistry,
  plans: PlanStore,
  archives: ArchiveStore,
  options: FlowSnapshotOptions = {},
): Promise<FlowResponse> {
  const now = options.now ?? Date.now()
  const includeArchived = options.includeArchived ?? false
  const jobs = manager.listJobs()
  const derived = deriveFlow({ jobs, terminals: registry.list(), now })
  const stored = plans.all()

  const labels = [...new Set([...Object.keys(derived.sessions), ...Object.keys(stored)])]

  const due = sessionsDueForAutoArchive(
    labels
      .filter((label) => !archives.isArchived(label))
      .map((label) => {
        const plan = stored[label] ?? null
        const labelJobs = jobsForSession(jobs, label)
        return {
          label,
          finished: isSessionFinished(plan, labelJobs),
          lastActivity: sessionLastActivity(labelJobs, plan),
        }
      }),
    now,
  )
  for (const label of due) await archives.archive(label, now)

  const sessions: Record<string, FlowSession> = {}
  for (const label of labels) {
    const archived = archives.isArchived(label)
    if (archived && !includeArchived) continue
    const job = activityJob(jobs, label)
    const plan = stored[label] ?? null
    sessions[label] = {
      ...(derived.sessions[label] ?? planOnlySession()),
      plan,
      currentActivity: job === null ? null : manager.currentActivity(job.id),
      activityJobId: job?.id ?? null,
      archived,
      finished: isSessionFinished(plan, jobsForSession(jobs, label)),
    }
  }

  const visibleKeys = Object.keys(sessions)
  const current = derived.current !== '' && sessions[derived.current] !== undefined ? derived.current : (visibleKeys[0] ?? '')
  const archivedCount = labels.filter((label) => archives.isArchived(label)).length
  return { ...derived, source: 'live', sessions, current, archivedCount }
}

export function flowRoutes(
  manager: JobManager,
  registry: TerminalRegistry,
  plans: PlanStore = createPlanStore(),
  archives: ArchiveStore = createArchiveStore(),
): Elysia {
  return new Elysia()
    .onBeforeHandle(requireSession)
    .get('/api/flow', async ({ query }) => {
      const includeArchived = query?.includeArchived === '1' || query?.includeArchived === 'true'
      return await flowSnapshot(manager, registry, plans, archives, { includeArchived })
    })
    .post('/api/flow/:label/archive', async ({ params }) => {
      return await archives.archive(decodeURIComponent(params.label))
    })
    .post('/api/flow/:label/unarchive', async ({ params }) => {
      return await archives.unarchive(decodeURIComponent(params.label))
    })
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
