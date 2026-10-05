import { basename } from 'node:path'

import { git as runGit } from './job-worktrees'
import type { QueueItem } from './queue-store'

export type TreeCommit = { sha: string; subject: string }
export type TreeLane = { itemId: string; branch: string; worktree: string; forkSha: string | null; commits: TreeCommit[] }
export type TreeRepo = { repo: string; base: { branch: string; commits: TreeCommit[] }; lanes: TreeLane[] }
export type QueueTree = { repos: TreeRepo[] }
type Git = (cwd: string, ...args: string[]) => Promise<string>
type Lane = { itemId: string; worktree: string }

export const BASE_COMMITS = 8
const LOG_FORMAT = '--format=%h%x09%s'
const SHORT_SHA = 7

function parseCommits(output: string): TreeCommit[] {
  return output.split('\n').filter(line => line.length > 0).map(line => {
    const tab = line.indexOf('\t')
    return tab < 0 ? { sha: line, subject: '' } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
  })
}

async function readBase(git: Git, repo: string): Promise<TreeRepo['base']> {
  try {
    const branch = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    const log = await git(repo, 'log', '-n', String(BASE_COMMITS), LOG_FORMAT, '--end-of-options', branch)
    return { branch, commits: parseCommits(log) }
  } catch {
    return { branch: '', commits: [] }
  }
}

async function readLane(git: Git, base: string, { itemId, worktree }: Lane): Promise<TreeLane> {
  try {
    const branch = await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')
    const fork = await git(worktree, 'merge-base', '--', base, 'HEAD')
    const log = await git(worktree, 'log', LOG_FORMAT, '--end-of-options', `${base}..HEAD`)
    return { itemId, branch, worktree, forkSha: fork.slice(0, SHORT_SHA), commits: parseCommits(log) }
  } catch {
    return { itemId, branch: basename(worktree), worktree, forkSha: null, commits: [] }
  }
}

function lanesByRepo(items: QueueItem[]): Map<string, Lane[]> {
  const groups = new Map<string, Lane[]>()
  for (const item of items) {
    if (item.worktree === null) continue
    groups.set(item.repo, [...(groups.get(item.repo) ?? []), { itemId: item.id, worktree: item.worktree }])
  }
  return groups
}

async function readRepo(git: Git, repo: string, lanes: Lane[]): Promise<TreeRepo> {
  const base = await readBase(git, repo)
  return { repo, base, lanes: await Promise.all(lanes.map(lane => readLane(git, base.branch, lane))) }
}

export async function queueTree(items: QueueItem[], git: Git = runGit): Promise<QueueTree> {
  const groups = [...lanesByRepo(items)]
  return { repos: await Promise.all(groups.map(([repo, lanes]) => readRepo(git, repo, lanes))) }
}
