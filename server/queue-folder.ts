import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isPlainRepoName, MAX_QUEUE_REPOS, repoNamesProblem } from './repo-names'
import { mapLimited, PROBE_CONCURRENCY, probeRepo, type RepoProbe } from './repo-probe'
import { validateWorkspaceCwd } from './workspace'

export { MAX_QUEUE_REPOS }

export type FolderListing = { ok: true; path: string; isRepo: boolean; repos: string[]; skipped: number } | { ok: false; error: string }
export type ResolvedFolder = { ok: true; path: string; repos?: string[] } | { ok: false; error: string }

async function insideGit(dir: string): Promise<boolean> {
  const proc = Bun.spawn(['git', '-C', dir, 'rev-parse', '--git-dir'], { stdout: 'ignore', stderr: 'ignore' })
  return (await proc.exited) === 0
}

export type ListingOptions = { timeoutMs?: number; probe?: RepoProbe }

export async function listFolderRepos(folder: string, home: string = homedir(), options: ListingOptions = {}): Promise<FolderListing> {
  const checked = await validateWorkspaceCwd(folder, home, { requireGit: false })
  if (!checked.ok) return checked
  if (await insideGit(checked.path)) return { ok: true, path: checked.path, isRepo: true, repos: [], skipped: 0 }
  const entries = await readdir(checked.path, { withFileTypes: true }).catch(() => [])
  const names = entries.filter(entry => entry.isDirectory() && isPlainRepoName(entry.name)).map(entry => entry.name)
  const results = await mapLimited(names, PROBE_CONCURRENCY, name => probeRepo(join(checked.path, name), options.timeoutMs, options.probe))
  const repos = names.filter((_, index) => results[index] === 'repo').sort()
  return { ok: true, path: checked.path, isRepo: false, repos, skipped: results.filter(result => result === 'timeout').length }
}

const missingText = (missing: readonly string[]): string =>
  missing.length === 1 ? `${missing[0]} is not a repo in this folder` : `${missing.join(', ')} are not repos in this folder`

export async function resolveQueueFolder(folder: string, repos: readonly string[] | undefined, home: string = homedir()): Promise<ResolvedFolder> {
  if (repos === undefined) {
    const checked = await validateWorkspaceCwd(folder, home, { requireGit: true })
    return checked.ok ? { ok: true, path: checked.path } : checked
  }
  const problem = repoNamesProblem(repos)
  if (problem !== null) return { ok: false, error: problem }
  const listing = await listFolderRepos(folder, home)
  if (!listing.ok) return listing
  if (listing.isRepo) return { ok: false, error: 'This folder is a git repo itself, so leave the repos out' }
  const missing = repos.filter(name => !listing.repos.includes(name))
  if (missing.length > 0) return { ok: false, error: missingText(missing) }
  return { ok: true, path: listing.path, repos: [...repos].sort() }
}
