import { access, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { QueueEngineDeps } from './queue-engine'
import { branchLabel } from './queue-prompts'
import type { QueueItem } from './queue-store'

export class WorktreeGone extends Error {
  constructor(reason: string) {
    super(`Its worktree is gone and could not be restored: ${reason}`)
    this.name = 'WorktreeGone'
  }
}

export type StoredWorktree = Pick<QueueItem, 'repo' | 'repos'> & { worktree: string }
type Preparers = Pick<QueueEngineDeps, 'prepareWorktree' | 'prepareWorkspace'>

const hasGitEntry = async (_repo: string, worktree: string): Promise<boolean> => lstat(join(worktree, '.git')).then(() => true, () => false)

export const fileExists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

function prepareIn(deps: Preparers, item: Pick<QueueItem, 'repo' | 'repos'>, label: string): Promise<{ worktree: string }> {
  if (item.repos === undefined) return deps.prepareWorktree(item.repo, label)
  if (deps.prepareWorkspace === undefined) return Promise.reject(new Error('This Mission Control cannot build multi-repo items'))
  return deps.prepareWorkspace(item.repo, item.repos, label)
}

export function freshWorktree(deps: Preparers): (item: QueueItem) => Promise<{ worktree: string }> {
  return item => prepareIn(deps, item, branchLabel(item))
}

export function worktreeRestorer(deps: Preparers & Pick<QueueEngineDeps, 'isWorktree'>): (item: StoredWorktree) => Promise<string> {
  const isWorktree = deps.isWorktree ?? hasGitEntry
  return async (item) => {
    if (item.repos === undefined && await isWorktree(item.repo, item.worktree)) return item.worktree
    try {
      return (await prepareIn(deps, item, basename(item.worktree))).worktree
    } catch (error) {
      throw new WorktreeGone(error instanceof Error ? error.message : String(error))
    }
  }
}
