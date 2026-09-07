import { join } from 'node:path'

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, error, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (code !== 0) throw new Error(error.trim() || `git ${args[0]} failed`)
  return out.trim()
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
