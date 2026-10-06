import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureDiffStat } from '../server/jobs'
import { prepareRepoWorkspace, workspaceDiffStat, workspaceRepos } from '../server/repo-workspace'
import { workspaceSnapshot } from '../server/workflow-runner'
import { validateWorkspaceCwd } from '../server/workspace'
import { git, repoAt } from './support/git-repos'

let parent: string
let scratch: string

beforeEach(async () => {
  parent = await mkdtemp(join(homedir(), 'mc-repo-workspace-test-'))
  scratch = await mkdtemp(join(tmpdir(), 'mc-repo-workspace-scratch-'))
})
afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const twoRepos = async () => { await repoAt(join(parent, 'b')); await repoAt(join(parent, 'a')) }

test('a workspace holds one worktree per ticked repo, all on the same branch', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-fix-login-7-a8c0')
  expect(worktree).toBe(join(parent, '.worktree', 'queue-fix-login-7-a8c0'))
  for (const name of ['a', 'b']) {
    expect(git(join(worktree, name), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-fix-login-7-a8c0')
    expect(await readFile(join(worktree, name, 'README.md'), 'utf8')).toBe('hello\n')
  }
  expect(await workspaceRepos(worktree)).toEqual(['a', 'b'])
  expect(await validateWorkspaceCwd(worktree)).toEqual({ ok: true, path: worktree })
  expect(git(join(parent, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
})

test('a plain folder without the workspace record still fails the git check', async () => {
  await mkdir(join(parent, 'loose'))
  expect(await workspaceRepos(join(parent, 'loose'))).toBeNull()
  expect(await validateWorkspaceCwd(join(parent, 'loose'))).toEqual({ ok: false, error: 'cwd is not a git repository' })
})

test('preparing again recreates only the child worktree deleted by hand', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await writeFile(join(worktree, 'a', 'work.txt'), 'kept')
  await rm(join(worktree, 'b'), { recursive: true, force: true })
  expect((await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')).worktree).toBe(worktree)
  expect(await readFile(join(worktree, 'a', 'work.txt'), 'utf8')).toBe('kept')
  expect(git(join(worktree, 'b'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-x-7-a8c0')
})

test('the changes are the union across child repos, prefixed by repo name, unchanged repos left out', async () => {
  await twoRepos()
  await repoAt(join(parent, 'c'))
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b', 'c'], 'queue-x-7-a8c0')
  expect(await workspaceDiffStat(worktree, ['a', 'b', 'c'])).toBeNull()
  await writeFile(join(worktree, 'a', 'README.md'), 'hello\nworld\n')
  await mkdir(join(worktree, 'c', 'app'))
  await writeFile(join(worktree, 'c', 'app', 'new.rb'), 'x = 1\n')
  const stat = await workspaceDiffStat(worktree, ['a', 'b', 'c'])
  expect(stat).toBe([' a/README.md | 1 +', ' c/app/new.rb | new', ' 2 files changed, 1 insertion(+)'].join('\n'))
  expect(stat).not.toContain('b/')
})

test('a job settled in a workspace reports the union of its repos as its diff stat; a single repo keeps git\'s own stat', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  await writeFile(join(worktree, 'b', 'README.md'), 'changed\n')
  expect(await captureDiffStat(worktree)).toBe([' b/README.md | 2 +-', ' 1 file changed, 1 insertion(+), 1 deletion(-)'].join('\n'))
  await writeFile(join(parent, 'a', 'README.md'), 'changed\n')
  expect(await captureDiffStat(join(parent, 'a'))).toBe(git(join(parent, 'a'), 'diff', '--stat', 'HEAD'))
  expect(await captureDiffStat(scratch)).toBeNull()
})

test('the run fingerprint of a workspace changes when any child repo changes', async () => {
  await twoRepos()
  const { worktree } = await prepareRepoWorkspace(parent, ['a', 'b'], 'queue-x-7-a8c0')
  const before = await workspaceSnapshot(worktree)
  expect(await workspaceSnapshot(worktree)).toEqual(before)
  await writeFile(join(worktree, 'b', 'extra.txt'), 'new')
  const after = await workspaceSnapshot(worktree)
  expect(after.diffHash).not.toBe(before.diffHash)
  expect(after.head).toMatch(/^a:[0-9a-f]{40} b:[0-9a-f]{40}$/)
  await expect(workspaceSnapshot(scratch)).rejects.toThrow()
})
