import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addPathWorktree, applyPath, commitPath, git, removePathWorktree, snapshotCommit } from '../server/job-worktrees'
import { initScratchGitRepo } from './support/scratch-git-repo'

let repo: string, scratch: string
beforeEach(async () => {
  repo = await mkdtemp(join(homedir(), 'mc-worktrees-repo-'))
  scratch = await mkdtemp(join(homedir(), 'mc-worktrees-dirs-'))
  await initScratchGitRepo(repo)
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const worktrees = async () => (await git(repo, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length
const branchExists = async (branch: string) => (await git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`)) !== ''

test('snapshotCommit records the whole workspace without touching the index, branch or files', async () => {
  await writeFile(join(repo, 'README.md'), 'changed\n')
  await writeFile(join(repo, 'notes.txt'), 'untracked\n')
  const status = await git(repo, 'status', '--porcelain')
  const head = await git(repo, 'rev-parse', 'HEAD')
  const snapshot = await snapshotCommit(repo, 'fixture: snapshot')
  expect(await git(repo, 'status', '--porcelain')).toBe(status)
  expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(await git(repo, 'diff', '--cached')).toBe('')
  expect((await git(repo, 'ls-tree', '-r', '--name-only', snapshot)).split('\n')).toEqual(['README.md', 'notes.txt'])
  expect(await git(repo, 'rev-parse', `${snapshot}^`)).toBe(head)
  expect(await git(repo, 'log', '-1', '--format=%an <%ae>', snapshot)).toBe('Mission Control <mission-control@localhost>')
  expect(await git(repo, 'branch', '--contains', snapshot)).toBe('')
})

test('commitPath commits changes with the internal identity and reports a clean worktree as false', async () => {
  const snapshot = await snapshotCommit(repo, 'fixture: snapshot')
  const dir = join(scratch, 'p1')
  await addPathWorktree(repo, dir, 'flow-test-p1', snapshot)
  expect(await commitPath(dir, 'fixture: nothing')).toBe(false)
  await writeFile(join(dir, 'a.txt'), 'a\n')
  expect(await commitPath(dir, 'fixture: A')).toBe(true)
  expect(await git(dir, 'log', '-1', '--format=%an %s')).toBe('Mission Control fixture: A')
  expect(await git(dir, 'status', '--porcelain')).toBe('')
  await removePathWorktree(repo, dir, 'flow-test-p1', false)
})

test('addPathWorktree replaces an existing path and removePathWorktree leaves nothing behind', async () => {
  const snapshot = await snapshotCommit(repo, 'fixture: snapshot')
  const dir = join(scratch, 'p1')
  await addPathWorktree(repo, dir, 'flow-test-p1', snapshot)
  await writeFile(join(dir, 'stale.txt'), 'stale\n')
  await addPathWorktree(repo, dir, 'flow-test-p1', snapshot)
  expect(await Bun.file(join(dir, 'stale.txt')).exists()).toBe(false)
  expect(await worktrees()).toBe(2)
  await removePathWorktree(repo, dir, 'flow-test-p1', false)
  expect(await worktrees()).toBe(1)
  expect(await branchExists('flow-test-p1')).toBe(false)
  await removePathWorktree(repo, dir, 'flow-test-p1', false)
})

test('removePathWorktree can keep the branch for later use', async () => {
  const snapshot = await snapshotCommit(repo, 'fixture: snapshot')
  const dir = join(scratch, 'p1')
  await addPathWorktree(repo, dir, 'flow-test-p1', snapshot)
  await removePathWorktree(repo, dir, 'flow-test-p1', true)
  expect(await worktrees()).toBe(1)
  expect(await branchExists('flow-test-p1')).toBe(true)
  await git(repo, 'branch', '-D', 'flow-test-p1')
})

test('applyPath brings a path into the workspace once, and counts a second apply as already applied', async () => {
  const snapshot = await snapshotCommit(repo, 'fixture: snapshot')
  const dir = join(scratch, 'p1')
  await addPathWorktree(repo, dir, 'flow-test-p1', snapshot)
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await commitPath(dir, 'fixture: A')
  expect(await applyPath(repo, snapshot, 'flow-test-p1')).toEqual({ applied: true, files: 1, conflicts: [] })
  const status = await git(repo, 'status', '--porcelain')
  expect(await applyPath(repo, snapshot, 'flow-test-p1')).toEqual({ applied: true, files: 1, conflicts: [] })
  expect(await git(repo, 'status', '--porcelain')).toBe(status)
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await git(repo, 'diff', '--cached')).toBe('')
  await removePathWorktree(repo, dir, 'flow-test-p1', false)
})

test('applyPath reports the conflicting files and changes nothing', async () => {
  const snapshot = await snapshotCommit(repo, 'fixture: snapshot')
  const dir = join(scratch, 'p1')
  await addPathWorktree(repo, dir, 'flow-test-p1', snapshot)
  await writeFile(join(dir, 'README.md'), 'from the path\n')
  await commitPath(dir, 'fixture: readme')
  await writeFile(join(repo, 'README.md'), 'from the user\n')
  expect(await applyPath(repo, snapshot, 'flow-test-p1')).toEqual({ applied: false, files: 1, conflicts: ['README.md'] })
  expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('from the user\n')
  await removePathWorktree(repo, dir, 'flow-test-p1', false)
})

test('an empty path applies with no files', async () => {
  const snapshot = await snapshotCommit(repo, 'fixture: snapshot')
  const dir = join(scratch, 'p1')
  await addPathWorktree(repo, dir, 'flow-test-p1', snapshot)
  expect(await applyPath(repo, snapshot, 'flow-test-p1')).toEqual({ applied: true, files: 0, conflicts: [] })
  await removePathWorktree(repo, dir, 'flow-test-p1', false)
})
