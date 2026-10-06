import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

export async function repoAt(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  await writeFile(join(path, 'README.md'), 'hello\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
  return path
}
