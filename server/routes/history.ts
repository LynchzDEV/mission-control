import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { chatHome } from '../chat-home'
import { buildHistory } from '../history'
import type { JobManager } from '../jobs'
import type { ExternalSession } from '../quota'
import { readConfig } from '../secrets'
import type { TerminalRegistry } from '../terminals'
import { listSessions } from '../transcripts'

const TRANSCRIPTS_PER_FOLDER = 20

export type HistoryDeps = {
  manager: Pick<JobManager, 'listJobs'>
  registry: Pick<TerminalRegistry, 'list'>
  knownDirectories: () => string[]
  external: () => Promise<ExternalSession[]>
  projectsDir?: string
  home?: string
}

async function realHome(home: string): Promise<string> {
  try {
    return await realpath(home)
  } catch {
    return home
  }
}

async function configuredChatHome(home: string): Promise<string[]> {
  try {
    const status = chatHome(await readConfig(), [], await realHome(home))
    return status.ok ? [status.path] : []
  } catch {
    return []
  }
}

export function historyRoutes(deps: HistoryDeps) {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/history', async () => {
      const jobs = deps.manager.listJobs()
      const terminals = deps.registry.list()
      const directories = [...new Set([...await configuredChatHome(deps.home ?? homedir()), ...deps.knownDirectories()])]
      const [transcripts, outside] = await Promise.all([
        Promise.all(directories.map(async cwd => ({
          cwd,
          sessions: await listSessions(cwd, { projectsDir: deps.projectsDir, limit: TRANSCRIPTS_PER_FOLDER }).catch(() => []),
        }))),
        deps.external().catch(() => []),
      ])
      return { items: buildHistory({ jobs, terminals, transcripts, outside, now: Date.now() }) }
    })
}
