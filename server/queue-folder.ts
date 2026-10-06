import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isPlainRepoName, MAX_QUEUE_REPOS } from './repo-workspace'
import { validateWorkspaceCwd } from './workspace'

export { MAX_QUEUE_REPOS }

export type FolderListing = { ok: true; path: string; isRepo: boolean; repos: string[] } | { ok: false; error: string }
export type ResolvedFolder = { ok: true; path: string; repos?: string[] } | { ok: false; error: string }

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return code === 0 ? out.trim() : null
}

async function isRepoRoot(dir: string): Promise<boolean> {
  const top = await gitOutput(dir, ['rev-parse', '--show-toplevel'])
  if (top === null) return false
  const [realTop, realDir] = await Promise.all([realpath(top).catch(() => null), realpath(dir).catch(() => null)])
  return realTop !== null && realTop === realDir
}

export async function listFolderRepos(folder: string, home: string = homedir()): Promise<FolderListing> {
  const checked = await validateWorkspaceCwd(folder, home, { requireGit: false })
  if (!checked.ok) return checked
  if (await gitOutput(checked.path, ['rev-parse', '--git-dir']) !== null) return { ok: true, path: checked.path, isRepo: true, repos: [] }
  const entries = await readdir(checked.path, { withFileTypes: true }).catch(() => [])
  const names = entries.filter(entry => entry.isDirectory() && isPlainRepoName(entry.name)).map(entry => entry.name)
  const found = await Promise.all(names.map(async name => (await isRepoRoot(join(checked.path, name)) ? name : null)))
  return { ok: true, path: checked.path, isRepo: false, repos: found.filter((name): name is string => name !== null).sort() }
}

function namesProblem(repos: readonly string[]): string | null {
  if (repos.length === 0) return 'Tick at least one repo this ticket touches'
  if (repos.length > MAX_QUEUE_REPOS) return `Pick at most ${MAX_QUEUE_REPOS} repos for one item`
  const bad = repos.find(name => !isPlainRepoName(name))
  if (bad !== undefined) return `Not a repo name: ${bad}`
  const twice = repos.find((name, index) => repos.indexOf(name) !== index)
  return twice === undefined ? null : `${twice} is ticked twice`
}

const missingText = (missing: readonly string[]): string =>
  missing.length === 1 ? `${missing[0]} is not a repo in this folder` : `${missing.join(', ')} are not repos in this folder`

export async function resolveQueueFolder(folder: string, repos: readonly string[] | undefined, home: string = homedir()): Promise<ResolvedFolder> {
  if (repos === undefined) {
    const checked = await validateWorkspaceCwd(folder, home, { requireGit: true })
    return checked.ok ? { ok: true, path: checked.path } : checked
  }
  const problem = namesProblem(repos)
  if (problem !== null) return { ok: false, error: problem }
  const listing = await listFolderRepos(folder, home)
  if (!listing.ok) return listing
  if (listing.isRepo) return { ok: false, error: 'This folder is a git repo itself, so leave the repos out' }
  const missing = repos.filter(name => !listing.repos.includes(name))
  if (missing.length > 0) return { ok: false, error: missingText(missing) }
  return { ok: true, path: listing.path, repos: [...repos].sort() }
}
