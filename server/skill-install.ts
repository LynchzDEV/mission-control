import { lstat, mkdir, readdir, realpath, rename, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export type SkillInstallResult = {
  linked: string[]
  movedAside: string[]
  skipped: string[]
}

export type SkillInstallOptions = {
  repoRoot?: string
  targetDir?: string
  now?: () => number
}

export function repoSkillsDir(root?: string): string {
  return join(resolve(root ?? resolve(import.meta.dir, '..')), 'skills')
}

export function claudeSkillsDir(home?: string): string {
  return join(home ?? homedir(), '.claude', 'skills')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function realOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
}

function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(path).catch((error) => {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') return null
    throw error
  })
}

export async function installSkills(opts: SkillInstallOptions = {}): Promise<SkillInstallResult> {
  const result: SkillInstallResult = { linked: [], movedAside: [], skipped: [] }
  const sourceDir = repoSkillsDir(opts.repoRoot)
  const targetDir = opts.targetDir ?? claudeSkillsDir()
  const backupDir = join(dirname(targetDir), 'skills-backup')
  const now = opts.now ?? (() => Date.now())

  let entries
  try {
    entries = await readdir(sourceDir, { withFileTypes: true })
  } catch (error) {
    result.skipped.push(`${sourceDir} — could not read repo skills dir (${describe(error)})`)
    return result
  }

  try {
    await mkdir(targetDir, { recursive: true })
  } catch (error) {
    result.skipped.push(`${targetDir} — could not create directory (${describe(error)})`)
    return result
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    try {
      const sourceReal = (await realOrNull(source)) ?? resolve(source)
      const info = await lstatOrNull(target)
      if (info?.isSymbolicLink()) {
        if ((await realOrNull(target)) === sourceReal) {
          result.linked.push(target)
          continue
        }
        await unlink(target)
      } else if (info !== null) {
        await mkdir(backupDir, { recursive: true, mode: 0o700 })
        const aside = join(backupDir, `${entry.name}.pre-mission-control-${now()}`)
        await rename(target, aside)
        result.movedAside.push(aside)
      }
      await symlink(source, target, 'dir')
      result.linked.push(target)
    } catch (error) {
      result.skipped.push(`${entry.name} — ${describe(error)}`)
    }
  }
  return result
}

export function describeSkillInstall(result: SkillInstallResult): string {
  const linked = result.linked.map((path) => basename(path)).join(', ')
  const aside = result.movedAside.length > 0 ? `, moved aside ${result.movedAside.length}` : ''
  return `linked ${linked || 'nothing'}${aside}`
}
