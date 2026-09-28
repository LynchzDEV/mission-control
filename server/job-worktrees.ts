import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const IDENTITY = { name: 'Mission Control', email: 'mission-control@localhost' }
const IDENTITY_FLAGS = ['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, '-c', 'commit.gpgsign=false']
const IDENTITY_ENV = { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email }
const CONFLICT_LINES = [/^error: patch failed: (.+):\d+$/, /^error: (.+): does not match index$/, /^error: (.+): already exists in (?:working directory|index)$/, /^error: (.+): does not exist in (?:working directory|index)$/]

export async function gitTimed(cwd: string, timeoutMs: number, args: string[], env?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  let timedOut = false
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs) : null
  try {
    const [out, error, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    if (timedOut) throw new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`)
    if (code !== 0) throw new Error(error.trim() || `git ${args[0]} failed`)
    return out.trim()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitTimed(cwd, 0, args)
}

const GIT_TIMEOUT = 120_000

async function withTempFile<T>(prefix: string, action: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `${prefix}-${randomUUID()}`)
  try { return await action(path) } finally { await rm(path, { force: true }) }
}

export async function snapshotCommit(cwd: string, message: string): Promise<string> {
  const top = await gitTimed(cwd, GIT_TIMEOUT, ['rev-parse', '--show-toplevel'])
  return withTempFile('mc-snapshot-index', async index => {
    const env = { ...IDENTITY_ENV, GIT_INDEX_FILE: index }
    await gitTimed(top, GIT_TIMEOUT, ['read-tree', 'HEAD'], env)
    await gitTimed(top, GIT_TIMEOUT, ['add', '-A'], env)
    const tree = await gitTimed(top, GIT_TIMEOUT, ['write-tree'], env)
    return gitTimed(top, GIT_TIMEOUT, [...IDENTITY_FLAGS, 'commit-tree', tree, '-p', 'HEAD', '-m', message], env)
  })
}

export async function commitPath(cwd: string, message: string): Promise<boolean> {
  if (await gitTimed(cwd, GIT_TIMEOUT, ['status', '--porcelain']) === '') return false
  await gitTimed(cwd, GIT_TIMEOUT, ['add', '-A'])
  await gitTimed(cwd, GIT_TIMEOUT, [...IDENTITY_FLAGS, 'commit', '--no-verify', '-q', '-m', message], IDENTITY_ENV)
  return true
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await gitTimed(repo, GIT_TIMEOUT, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])) !== ''
}

export async function removePathWorktree(from: string, dir: string, branch: string, keepBranch: boolean): Promise<void> {
  await gitTimed(from, GIT_TIMEOUT, ['worktree', 'remove', '--force', dir]).catch(() => {})
  await rm(dir, { recursive: true, force: true })
  await gitTimed(from, GIT_TIMEOUT, ['worktree', 'prune'])
  if (!keepBranch && await branchExists(from, branch)) await gitTimed(from, GIT_TIMEOUT, ['branch', '-D', branch])
}

export async function addPathWorktree(from: string, dir: string, branch: string, start: string): Promise<void> {
  await gitTimed(from, GIT_TIMEOUT, ['check-ref-format', '--branch', branch])
  await removePathWorktree(from, dir, branch, false)
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 })
  await gitTimed(from, GIT_TIMEOUT, ['worktree', 'add', '-q', '-b', branch, dir, start])
}

function conflictsIn(message: string): string[] {
  const files = message.split('\n').flatMap(line => CONFLICT_LINES.map(pattern => pattern.exec(line.trim())?.[1]).filter((file): file is string => !!file))
  return [...new Set(files)]
}

export async function applyPath(parent: string, snapshot: string, branch: string): Promise<{ applied: boolean; files: number; conflicts: string[] }> {
  const top = await gitTimed(parent, GIT_TIMEOUT, ['rev-parse', '--show-toplevel'])
  const names = await gitTimed(top, GIT_TIMEOUT, ['diff', '--name-only', '--no-renames', snapshot, branch])
  const files = names ? names.split('\n').length : 0
  if (!files) return { applied: true, files, conflicts: [] }
  const patch = await gitTimed(top, GIT_TIMEOUT, ['diff', '--binary', '--no-renames', snapshot, branch])
  return withTempFile('mc-path-patch', async file => {
    await writeFile(file, `${patch}\n`, { mode: 0o600 })
    try {
      await gitTimed(top, GIT_TIMEOUT, ['apply', '--check', file])
    } catch (error) {
      const reverse = await gitTimed(top, GIT_TIMEOUT, ['apply', '--check', '--reverse', file]).then(() => true, () => false)
      if (reverse) return { applied: true, files, conflicts: [] }
      const conflicts = conflictsIn((error as Error).message)
      if (!conflicts.length) throw error
      return { applied: false, files, conflicts }
    }
    await gitTimed(top, GIT_TIMEOUT, ['apply', file])
    return { applied: true, files, conflicts: [] }
  })
}

export function worktreeBranch(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, '-')
}

export async function prepareWorktree(baseRepo: string, label: string) {
  const branch = worktreeBranch(label)
  await git(baseRepo, 'check-ref-format', '--branch', branch)
  const baseBranch = await git(baseRepo, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (baseBranch === 'HEAD') throw new Error('worktree jobs require a checked-out base branch')
  if (branch === baseBranch) throw new Error('worktree label must differ from the base branch')
  const worktree = join(baseRepo, '.worktree', branch)
  const entries = (await git(baseRepo, 'worktree', 'list', '--porcelain')).split('\n\n')
  const existing = entries.find((entry) => entry.split('\n').includes(`worktree ${worktree}`))
  if (existing !== undefined) {
    if (!existing.split('\n').includes(`branch refs/heads/${branch}`)) {
      throw new Error('existing worktree has a different branch')
    }
  } else {
    const branches = await git(baseRepo, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`)
    if (branches.split('\n').includes(`refs/heads/${branch}`)) {
      await git(baseRepo, 'worktree', 'add', worktree, branch)
    } else {
      await git(baseRepo, 'worktree', 'add', worktree, '-b', branch)
    }
  }
  return { worktree, baseRepo, baseBranch }
}
