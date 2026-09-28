import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { buildHistory } from '../history'
import type { JobManager } from '../jobs'
import { createQuotaCache } from '../quota'
import type { TerminalRegistry } from '../terminals'
import { listUserSessions } from '../transcripts'

const SESSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_LIMIT = 60

export type HistoryDeps = {
  manager: Pick<JobManager, 'listJobs'>
  registry: Pick<TerminalRegistry, 'list' | 'ended'>
  projectsDir?: string
  scanTtlMs?: number
  now?: () => number
}

export function historyRoutes(deps: HistoryDeps) {
  const now = deps.now ?? Date.now
  const scan = createQuotaCache(() => listUserSessions({ projectsDir: deps.projectsDir, since: now() - SESSION_WINDOW_MS, limit: SESSION_LIMIT }), deps.scanTtlMs ?? 10_000)
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/history', async () => {
      const sessions = await scan.get().catch(() => [])
      return { items: buildHistory({ jobs: deps.manager.listJobs(), terminals: deps.registry.list(), ended: deps.registry.ended(), sessions }) }
    })
}
