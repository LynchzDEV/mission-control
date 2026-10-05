import { access, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { QueueEngineDeps } from './queue-engine'
import type { QueueItem } from './queue-store'

export class WorktreeGone extends Error {
  constructor(reason: string) {
    super(`Its worktree is gone and could not be restored: ${reason}`)
    this.name = 'WorktreeGone'
  }
}

export type StoredWorktree = Pick<QueueItem, 'repo' | 'worktree'> & { worktree: string }

const hasGitEntry = async (_repo: string, worktree: string): Promise<boolean> => lstat(join(worktree, '.git')).then(() => true, () => false)

export const fileExists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

export function worktreeRestorer(deps: Pick<QueueEngineDeps, 'prepareWorktree' | 'isWorktree'>): (item: StoredWorktree) => Promise<string> {
  const isWorktree = deps.isWorktree ?? hasGitEntry
  return async (item) => {
    if (await isWorktree(item.repo, item.worktree)) return item.worktree
    try {
      return (await deps.prepareWorktree(item.repo, basename(item.worktree))).worktree
    } catch (error) {
      throw new WorktreeGone(error instanceof Error ? error.message : String(error))
    }
  }
}
