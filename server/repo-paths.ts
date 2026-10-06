import { dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'

import type { FlowShape } from './flow-shape'
import { applyPath, commitPath, gitTimed, snapshotCommit } from './job-worktrees'
import { listFolderRepos } from './queue-folder'
import { MAX_QUEUE_REPOS } from './repo-names'
import { workspaceRepos } from './repo-workspace'

const GIT_TIMEOUT = 120_000

export type RepoJoin = { applied: true; files: number } | { applied: false; conflicts: string[] }

const repoOf = (file: string): string => file.replace(/^(\.\/)+/, '').split('/')[0] ?? ''

export const shapeRepoNames = (shape: FlowShape): string[] => [...new Set(shape.paths.flatMap(path => path.files.map(repoOf)))]

export async function workspaceFolder(workspace: string): Promise<string> {
  return dirname(dirname(await realpath(workspace)))
}

export async function shapeRepoProblems(shape: FlowShape, workspace: string): Promise<string[]> {
  const repos = await workspaceRepos(workspace)
  if (repos === null) return []
  const folder = await workspaceFolder(workspace)
  const listing = await listFolderRepos(folder)
  const available = listing.ok ? listing.repos : []
  const wrong = shape.paths.flatMap(path => path.files).filter(file => !available.includes(repoOf(file)))
  if (wrong.length > 0) return wrong.map(file => `MC_SHAPE file ${file} must start with one of the repos in ${folder}: ${available.join(', ')}`)
  const all = new Set([...repos, ...shapeRepoNames(shape)])
  return all.size > MAX_QUEUE_REPOS ? [`MC_SHAPE needs more than ${MAX_QUEUE_REPOS} repos`] : []
}

export async function shapeRulesFor(workspace: string): Promise<string> {
  const repos = await workspaceRepos(workspace)
  if (repos === null) return ''
  if (repos.length > 0) return repoShapeRules(repos)
  const listing = await listFolderRepos(await workspaceFolder(workspace))
  return repoShapeRules(listing.ok ? listing.repos : [])
}

function repoShapeRules(repos: readonly string[]): string {
  return ` This run spans several repos side by side (${repos.join(', ')}): start every file with its repo folder, for example "${repos[0] ?? 'api'}/app/x.rb" or "${repos[0] ?? 'api'}/src". A path may list a repo of this folder that has no copy yet; Mission Control adds the copy before the split.`
}

export async function snapshotRepos(workspace: string, repos: readonly string[], message: string): Promise<Record<string, string>> {
  const snapshots: Record<string, string> = {}
  for (const name of repos) snapshots[name] = await snapshotCommit(join(workspace, name), message)
  return snapshots
}

export async function commitRepoPath(dir: string, repos: readonly string[], message: string): Promise<void> {
  for (const name of repos) await commitPath(join(dir, name), message)
}

export async function joinRepoPath(parentWorkspace: string, dir: string, name: string, snapshot: string, checkOnly = false): Promise<RepoJoin> {
  const head = await gitTimed(join(dir, name), GIT_TIMEOUT, ['rev-parse', 'HEAD'])
  const applied = await applyPath(join(parentWorkspace, name), snapshot, head, { checkOnly })
  return applied.applied ? { applied: true, files: applied.files } : { applied: false, conflicts: applied.conflicts.map(file => `${name}/${file}`) }
}
