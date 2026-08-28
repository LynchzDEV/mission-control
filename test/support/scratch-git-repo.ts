import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

export async function initScratchGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await runGit(['init', '-q'], dir)
  await runGit(['config', 'user.email', 'mission-control-test@example.com'], dir)
  await runGit(['config', 'user.name', 'Mission Control Test'], dir)
  await writeFile(join(dir, 'README.md'), 'initial\n')
  await runGit(['add', '.'], dir)
  await runGit(['commit', '-q', '-m', 'initial'], dir)
}
