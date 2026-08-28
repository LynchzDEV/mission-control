import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { sep } from 'node:path'

export type CwdCheck = { ok: true; path: string } | { ok: false; error: string }

export async function validateWorkspaceCwd(
  cwd: string,
  home: string = homedir(),
  opts: { requireGit?: boolean } = {},
): Promise<CwdCheck> {
  let info
  try {
    info = await stat(cwd)
  } catch {
    return { ok: false, error: 'cwd does not exist' }
  }
  if (!info.isDirectory()) return { ok: false, error: 'cwd is not a directory' }

  let real: string
  try {
    real = await realpath(cwd)
  } catch {
    return { ok: false, error: 'cwd could not be resolved' }
  }

  let realHome: string
  try {
    realHome = await realpath(home)
  } catch {
    realHome = home
  }

  if (real !== realHome && !real.startsWith(realHome + sep)) {
    return { ok: false, error: 'cwd must be under $HOME' }
  }

  if (opts.requireGit !== false) {
    const gitCheck = Bun.spawn(['git', '-C', real, 'rev-parse', '--git-dir'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const exitCode = await gitCheck.exited
    if (exitCode !== 0) return { ok: false, error: 'cwd is not a git repository' }
  }

  return { ok: true, path: real }
}
