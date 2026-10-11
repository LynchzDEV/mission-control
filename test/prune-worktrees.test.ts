import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../skills/mc-dispatch/scripts/prune-worktrees')
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

let base: string
let repo: string

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

async function commit(cwd: string, file: string, text: string) {
  await writeFile(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', file)
}

function addWorktree(name: string, ...extra: string[]) {
  const path = join(repo, '.worktree', name)
  git(repo, 'worktree', 'add', '-q', ...extra, path, 'origin/main')
  return path
}

function prune(...args: string[]) {
  const proc = Bun.spawnSync(['bash', SCRIPT, ...args], { env: GIT_ENV })
  return { exit: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() }
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mc-prune-worktrees-')))
  git(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(base, 'clone', '-q', join(base, 'origin.git'), 'repo')
  repo = join(base, 'repo')
  await commit(repo, 'README', 'start')
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('prune-worktrees', () => {
  test('removes a clean worktree whose commit is on origin, and deletes its branch', async () => {
    const path = addWorktree('landed', '-b', 'landed')
    await commit(path, 'feature', 'done')
    git(path, 'push', '-q', 'origin', 'HEAD:main')

    const result = prune(repo)

    expect(result.output).toContain(`REMOVE ${path}`)
    expect(existsSync(path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'landed')).toBe('')
  })

  test('removes a worktree whose commit landed under a different id', async () => {
    const path = addWorktree('rebased', '-b', 'rebased')
    await commit(path, 'feature', 'done')
    await commit(repo, 'other', 'someone else')
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'cherry-pick', git(path, 'rev-parse', 'HEAD'))
    git(repo, 'push', '-q', 'origin', 'main')

    expect(prune(repo).output).toContain(`REMOVE ${path}`)
  })

  test('counts a commit on origin/main as landed even when origin HEAD points at another branch', async () => {
    git(repo, 'push', '-q', 'origin', 'main:uat')
    git(repo, 'remote', 'set-head', 'origin', 'uat')
    const path = addWorktree('on-main', '-b', 'on-main')
    await commit(path, 'feature', 'done')
    git(path, 'push', '-q', 'origin', 'HEAD:main')

    expect(prune(repo).output).toContain(`REMOVE ${path}`)
  })

  test('removes a clean detached worktree', () => {
    const path = addWorktree('detached', '--detach')

    expect(prune(repo).output).toContain(`REMOVE ${path}`)
  })

  test('keeps a worktree with uncommitted changes', async () => {
    const path = addWorktree('dirty', '-b', 'dirty')
    await writeFile(join(path, 'draft'), 'wip')

    expect(prune(repo).output).toContain(`KEEP   ${path} (uncommitted or untracked changes)`)
    expect(existsSync(path)).toBe(true)
  })

  test('keeps a worktree with a commit that is not on origin', async () => {
    const path = addWorktree('unpushed', '-b', 'unpushed')
    await commit(path, 'feature', 'not pushed')

    expect(prune(repo).output).toContain(`KEEP   ${path} (commits not on origin/main)`)
    expect(git(repo, 'branch', '--list', 'unpushed')).toContain('unpushed')
  })

  test('keeps a worktree a process is working inside', () => {
    const path = addWorktree('busy', '--detach')
    const sleeper = Bun.spawn(['sleep', '30'], { cwd: path })
    try {
      expect(prune(repo).output).toContain(`KEEP   ${path} (a process is working inside it)`)
    } finally {
      sleeper.kill()
    }
  })

  test('keeps a locked worktree', () => {
    const path = addWorktree('locked', '--detach')
    git(repo, 'worktree', 'lock', path)

    expect(prune(repo).output).toContain(`KEEP   ${path} (locked)`)
  })

  test('never touches the main checkout', () => {
    expect(prune(repo).output).not.toContain(`${repo} `)
    expect(existsSync(join(repo, 'README'))).toBe(true)
  })

  test('a dry run reports what it would remove and removes nothing', () => {
    const path = addWorktree('preview', '--detach')

    const result = prune('--dry-run', repo)

    expect(result.output).toContain(`WOULD  ${path}`)
    expect(existsSync(path)).toBe(true)
  })

  test('scans every repo inside a folder of repos', () => {
    const path = addWorktree('nested', '--detach')

    expect(prune(base).output).toContain(`REMOVE ${path}`)
  })
})
