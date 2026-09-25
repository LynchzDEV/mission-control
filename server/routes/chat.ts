import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Elysia } from 'elysia'
import { requireLocal } from '../auth'
import { chatHome } from '../chat-home'
import { readConfig, writeConfig } from '../secrets'
import { validateWorkspaceCwd } from '../workspace'

export type ChatDeps = { knownDirectories: () => string[]; home?: string }

async function realHome(home: string): Promise<string> {
  try {
    return await realpath(home)
  } catch {
    return home
  }
}

export function chatRoutes(deps: ChatDeps): Elysia {
  const home = deps.home ?? homedir()
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/chat/home', async () => chatHome(await readConfig(), deps.knownDirectories(), home))
    .put('/api/chat/home', async ({ body, set }) => {
      const path = typeof (body as { path?: unknown } | null)?.path === 'string' ? (body as { path: string }).path.trim() : ''
      const check = await validateWorkspaceCwd(path, home, { requireGit: false })
      if (!check.ok) { set.status = 400; return { error: check.error } }
      if (check.path === await realHome(home)) { set.status = 400; return { error: 'Chat home cannot be your home folder' } }
      await writeConfig({ chatHome: check.path })
      return { ok: true, path: check.path }
    })
}
