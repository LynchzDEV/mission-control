import { basename } from 'node:path'

import type { QueueEngineDeps } from './queue-engine'
import { listFolderRepos } from './queue-folder'
import type { QueueItem } from './queue-store'
import { isPlainRepoName, MAX_QUEUE_REPOS } from './repo-names'

export const MAX_REPO_RERUNS = 3

export type RepoGrant = { repos: string[] } | { fail: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export async function availableRepos(folder: string): Promise<string[]> {
  const listing = await listFolderRepos(folder)
  return listing.ok ? listing.repos : []
}

async function unknownName(folder: string, names: readonly string[]): Promise<string | undefined> {
  const bad = names.find(name => !isPlainRepoName(name))
  if (bad !== undefined) return bad
  const listed = await availableRepos(folder)
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
