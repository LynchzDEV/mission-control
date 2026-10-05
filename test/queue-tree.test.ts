import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BASE_COMMITS, queueTree } from '../server/queue-tree'
import type { QueueItem } from '../server/queue-store'

const IDENTITY = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false']

function run(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

async function commit(cwd: string, file: string, subject: string): Promise<void> {
  await writeFile(join(cwd, file), subject)
  run(cwd, 'add', '--', file)
  run(cwd, ...IDENTITY, 'commit', '-q', '-m', subject)
}

function item(id: string, repo: string, worktree: string | null): QueueItem {
  return {
    id, source: 'clickup-board', externalId: id, title: `Task ${id}`, url: 'u', repo, flowId: null,
    state: 'building', worktree, contextPath: null, answerPaths: [], runIds: [], currentRunId: null,
    questions: [], lastSeenId: null, error: null, createdAt: 0, updatedAt: 0,
  }
}

let repo: string
let worktree: string
beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'mc-queue-tree-')))
  run(repo, 'init', '-q', '-b', 'main')
  await commit(repo, 'a.txt', 'first on main')
  await commit(repo, 'b.txt', 'second on main')
  worktree = join(repo, '.worktree', 'queue-a')
  run(repo, 'worktree', 'add', '-q', worktree, '-b', 'queue-a')
  await commit(worktree, 'c.txt', 'lane\twork with a tab')
})
afterAll(async () => { await rm(repo, { recursive: true, force: true }) })

test('a repo shows its base branch newest first and each lane forked from it', async () => {
  const tree = await queueTree([item('a', repo, worktree)])
  expect(tree.repos).toHaveLength(1)
  const [found] = tree.repos
  expect(found.repo).toBe(repo)
  expect(found.base.branch).toBe('main')
  expect(found.base.commits.map(entry => entry.subject)).toEqual(['second on main', 'first on main'])
  expect(found.base.commits[0].sha).toBe(run(repo, 'rev-parse', '--short=7', 'main'))
  expect(found.lanes).toEqual([{
    itemId: 'a', branch: 'queue-a', worktree, forkSha: run(repo, 'rev-parse', 'main').slice(0, 7),
    commits: [{ sha: run(worktree, 'rev-parse', '--short=7', 'HEAD'), subject: 'lane\twork with a tab' }],
  }])
})

test('a missing worktree becomes an empty lane', async () => {
  const missing = join(repo, '.worktree', 'gone')
  const tree = await queueTree([item('gone', repo, missing)])
  expect(tree.repos[0].lanes).toEqual([{ itemId: 'gone', branch: 'gone', worktree: missing, forkSha: null, commits: [] }])
})

test('items without a worktree are not lanes', async () => {
  const tree = await queueTree([item('a', repo, worktree), item('later', repo, null)])
  expect(tree.repos).toHaveLength(1)
  expect(tree.repos[0].lanes.map(lane => lane.itemId)).toEqual(['a'])
  expect((await queueTree([item('later', repo, null)])).repos).toEqual([])
})

test('a repo git cannot read keeps its lanes with an empty base', async () => {
  const fail = async () => { throw new Error('not a git repository') }
  const tree = await queueTree([item('x', '/nowhere', '/nowhere/.worktree/x')], fail)
  expect(tree.repos).toEqual([{ repo: '/nowhere', base: { branch: '', commits: [] }, lanes: [{ itemId: 'x', branch: 'x', worktree: '/nowhere/.worktree/x', forkSha: null, commits: [] }] }])
})

test('items group by repo and the base log asks for BASE_COMMITS', async () => {
  const calls: string[][] = []
  const fake = async (cwd: string, ...args: string[]) => {
    calls.push([cwd, ...args])
    if (args[0] === 'rev-parse') return cwd.startsWith('/r1/') || cwd.startsWith('/r2/') ? 'lane' : 'trunk'
    if (args[0] === 'merge-base') return '0123456789abcdef'
    return ''
  }
  const tree = await queueTree([item('a', '/r1', '/r1/.worktree/a'), item('b', '/r2', '/r2/.worktree/b'), item('c', '/r1', '/r1/.worktree/c')], fake)
  expect(tree.repos.map(entry => [entry.repo, entry.lanes.map(lane => lane.itemId)])).toEqual([['/r1', ['a', 'c']], ['/r2', ['b']]])
  expect(tree.repos[0].lanes[0]).toEqual({ itemId: 'a', branch: 'lane', worktree: '/r1/.worktree/a', forkSha: '0123456', commits: [] })
  expect(calls).toContainEqual(['/r1', 'log', '-n', String(BASE_COMMITS), '--format=%h%x09%s', '--end-of-options', 'trunk'])
  expect(calls).toContainEqual(['/r1/.worktree/a', 'merge-base', '--', 'trunk', 'HEAD'])
})
