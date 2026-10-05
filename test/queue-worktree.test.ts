import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { commitPath, git, isWorktreeOf, prepareWorktree } from '../server/job-worktrees'
import { initScratchGitRepo } from './support/scratch-git-repo'

let repo: string, other: string
beforeEach(async () => {
  repo = await mkdtemp(join(homedir(), 'mc-queue-worktree-'))
  other = await mkdtemp(join(homedir(), 'mc-queue-worktree-other-'))
  await initScratchGitRepo(repo)
  await initScratchGitRepo(other)
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(other, { recursive: true, force: true })
})

test('isWorktreeOf accepts a worktree of the repo', async () => {
  const { worktree } = await prepareWorktree(repo, 'queue-task-1-a8c0')
  expect(await isWorktreeOf(repo, worktree)).toBe(true)
})

test('isWorktreeOf refuses a missing folder, a plain folder inside the repo and another repo\'s worktree', async () => {
  expect(await isWorktreeOf(repo, join(repo, '.worktree', 'gone'))).toBe(false)
  const plain = join(repo, '.worktree', 'plain')
  await mkdir(join(plain, '.mission-control'), { recursive: true })
  expect(await isWorktreeOf(repo, plain)).toBe(false)
  const { worktree } = await prepareWorktree(other, 'queue-task-1-a8c0')
  expect(await isWorktreeOf(repo, worktree)).toBe(false)
})

test('prepareWorktree brings back a worktree deleted by hand with its branch commits', async () => {
  const { worktree } = await prepareWorktree(repo, 'queue-task-1-a8c0')
  await writeFile(join(worktree, 'work.txt'), 'done\n')
  await commitPath(worktree, 'queue: work')
  const head = await git(worktree, 'rev-parse', 'HEAD')
  await rm(worktree, { recursive: true, force: true })
  const again = await prepareWorktree(repo, 'queue-task-1-a8c0')
  expect(again.worktree).toBe(worktree)
  expect(existsSync(join(worktree, 'work.txt'))).toBe(true)
  expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(head)
  expect(await isWorktreeOf(repo, worktree)).toBe(true)
})
