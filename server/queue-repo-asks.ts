import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'

import { gitTimed } from './job-worktrees'

import type { QueueEngineDeps } from './queue-engine'
import { listFolderRepos } from './queue-folder'
import type { QueueItem } from './queue-store'
import { isPlainRepoName, MAX_QUEUE_REPOS } from './repo-names'
import { mapLimited, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS } from './repo-probe'

export const MAX_REPO_RERUNS = 3

export type RepoGrant = { repos: string[] } | { fail: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function unknownName(folder: string, names: readonly string[]): Promise<string | undefined> {
  const bad = names.find(name => !isPlainRepoName(name))
  if (bad !== undefined) return bad
  const listing = await listFolderRepos(folder)
  const listed = listing.ok ? listing.repos : []
  return names.find(name => !listed.includes(name))
}

export async function grantRepos(deps: Pick<QueueEngineDeps, 'prepareWorkspace'>, item: QueueItem, asked: readonly string[], withQuestions: boolean): Promise<RepoGrant> {
  const current = item.repos ?? []
  const fresh = asked.filter(name => !current.includes(name))
  if (fresh.length === 0) return withQuestions ? { repos: current } : { fail: `The plan asked again for ${asked.join(', ')}, which it already has; stopped so it does not loop` }
  if (!withQuestions && (item.repoReruns ?? 0) >= MAX_REPO_RERUNS) return { fail: `The plan asked for repos ${MAX_REPO_RERUNS} times already; tick the repos yourself and requeue` }
  if (current.length + fresh.length > MAX_QUEUE_REPOS) return { fail: `The plan asked for more than ${MAX_QUEUE_REPOS} repos` }
  const unknown = await unknownName(item.repo, fresh)
  if (unknown !== undefined) return { fail: `The plan asked for ${unknown}, which is not a repo in ${item.repo}` }
  if (deps.prepareWorkspace === undefined || item.worktree === null) return { fail: 'This Mission Control cannot build multi-repo items' }
  const repos = [...current, ...fresh]
  try {
    await deps.prepareWorkspace(item.repo, repos, basename(item.worktree))
  } catch (error) {
    return { fail: message(error) }
  }
  return { repos }
}

export const SINGLE_REPO_ASK = 'This item builds in one repo; add it with the parent folder to let it use more'

export async function reposToOffer(folder: string): Promise<string[]> {
  const listing = await listFolderRepos(folder)
  if (!listing.ok) throw new Error(`Cannot read the repos in ${folder}: ${listing.error}`)
  if (listing.repos.length === 0) throw new Error(`${folder} has no repos inside it any more`)
  return listing.repos
}

async function realRepoState(dir: string): Promise<string> {
  try {
    const [head, status] = await Promise.all([gitTimed(dir, PROBE_TIMEOUT_MS, ['rev-parse', 'HEAD']), gitTimed(dir, PROBE_TIMEOUT_MS, ['status', '--porcelain=v1', '-z'])])
    return createHash('sha256').update(`${head}\0${status}`).digest('hex')
  } catch {
    return 'unreadable'
  }
}

export async function realRepoStates(folder: string, names: readonly string[]): Promise<Record<string, string>> {
  const states = await mapLimited(names, PROBE_CONCURRENCY, name => realRepoState(join(folder, name)))
  return Object.fromEntries(names.map((name, index) => [name, states[index]!]))
}

export async function movedRealRepos(item: QueueItem): Promise<string[]> {
  if (item.realBaseline === undefined) return []
  const names = Object.keys(item.realBaseline)
  const now = await realRepoStates(item.repo, names)
  return names.filter(name => now[name] !== item.realBaseline![name])
}

export const movedText = (item: QueueItem, moved: readonly string[]): string =>
  `${moved.join(', ')} in ${item.repo} changed while ${item.title} was building — check it wasn't the agent`

export async function adoptionProblem(item: QueueItem, added: readonly string[]): Promise<string | null> {
  const unknown = await unknownName(item.repo, added)
  if (unknown !== undefined) return `The run recorded ${unknown}, which is not a repo in ${item.repo}`
  return (item.repos ?? []).length + added.length > MAX_QUEUE_REPOS ? `The run added repos past the limit of ${MAX_QUEUE_REPOS}` : null
}
