import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { Elysia } from 'elysia'
import { requireLocal } from '../auth'
import { chatHome } from '../chat-home'
import { rankFiles, listProjectFiles } from '../chat-files'
import type { JobManager } from '../jobs'
import { readConfig, writeConfig } from '../secrets'
import { validateWorkspaceCwd } from '../workspace'

export type ChatDeps = { knownDirectories: () => string[]; home?: string; manager?: Pick<JobManager, 'getJob'> }

async function realHome(home: string): Promise<string> {
  try {
    return await realpath(home)
  } catch {
    return home
  }
}

export function chatRoutes(deps: ChatDeps): Elysia {
  const home = () => realHome(deps.home ?? homedir())
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/chat/home', async () => chatHome(await readConfig(), deps.knownDirectories(), await home()))
    .put('/api/chat/home', async ({ body, set }) => {
      const path = typeof (body as { path?: unknown } | null)?.path === 'string' ? (body as { path: string }).path.trim() : ''
      const realHomeDir = await home()
      const check = await validateWorkspaceCwd(path, realHomeDir, { requireGit: false })
      if (!check.ok) { set.status = 400; return { error: check.error } }
      if (check.path === realHomeDir) { set.status = 400; return { error: 'Chat home cannot be your home folder' } }
      await writeConfig({ chatHome: check.path })
      return { ok: true, path: check.path }
    })
    .get('/api/chat/files', async ({ query }) => {
      const rootId = typeof query.root === 'string' ? query.root : ''
      const text = typeof query.q === 'string' ? query.q : ''
      const rootJob = rootId === '' ? undefined : deps.manager?.getJob(rootId)
      let project: string | null = rootJob?.project ?? null
      if (project === null) {
        const chat = chatHome(await readConfig(), deps.knownDirectories(), await home())
        project = chat.ok ? chat.path : null
      }
      if (project === null) return { files: [] }
      const name = basename(project)
      const files = await listProjectFiles(project)
      const ranked = rankFiles(files, text)
      return { files: ranked, project: name }
    })
}
