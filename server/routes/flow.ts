import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { deriveFlow, type SessionFlow } from '../flow'
import type { JobManager } from '../jobs'
import type { TerminalRegistry } from '../terminals'

export type { SessionFlow, Stage, StageState } from '../flow'

export type FlowResponse = {
  source: 'live'
  current: string
  sessions: Record<string, SessionFlow>
  reviewCount: number
  mergedToday: number
}

export function flowSnapshot(
  manager: JobManager,
  registry: TerminalRegistry,
  now: number = Date.now(),
): FlowResponse {
  const derived = deriveFlow({ jobs: manager.listJobs(), terminals: registry.list(), now })
  return { source: 'live', ...derived }
}

export function flowRoutes(manager: JobManager, registry: TerminalRegistry): Elysia {
  return new Elysia()
    .onBeforeHandle(requireSession)
    .get('/api/flow', () => flowSnapshot(manager, registry))
}
