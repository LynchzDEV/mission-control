import { lstat, mkdir, readFile, readdir, readlink, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

export type AssetSyncResult = { linked: string[]; written: string[]; movedAside: string[]; skipped: string[] }
export type AssetSyncOptions = { claudeDir?: string; codexDir?: string; now?: () => number }

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function agentMarkdownToToml(markdown: string, fallbackName: string): string | null {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(markdown)
  if (!match || match.index !== 0) return null
  try {
    const metadata = parse(match[1]!)
    if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) return null
    const name = typeof metadata?.name === 'string' ? metadata.name : fallbackName
    const description = typeof metadata?.description === 'string' ? metadata.description : ''
    const body = markdown.slice(match[0].length).replaceAll('"""', '\\"\\"\\"')
    return `name = ${tomlString(name)}\ndescription = ${tomlString(description)}\ndeveloper_instructions = """\n${body}${body.endsWith('\n') ? '' : '\n'}"""\n`
  } catch {
    return null
  }
}

export async function syncEngineAssets(opts: AssetSyncOptions = {}): Promise<AssetSyncResult> {
  const result: AssetSyncResult = { linked: [], written: [], movedAside: [], skipped: [] }
  const claudeDir = resolve(opts.claudeDir ?? join(homedir(), '.claude'))
  const codexDir = resolve(opts.codexDir ?? join(homedir(), '.codex'))
  const now = opts.now ?? Date.now
  const skipped = (path: string, error: unknown) => {
    result.skipped.push(`${path} — ${error instanceof Error ? error.message : String(error)}`)
  }
  async function attempt(path: string, action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      skipped(path, error)
    }
  }
  async function link(source: string, target: string, backupName: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    const info = await lstat(target).catch((error) => {
      if (missing(error)) return null
      throw error
    })
    if (info?.isSymbolicLink()) {
      if (resolve(dirname(target), await readlink(target)) === source) return
      await unlink(target)
    } else if (info) {
      const backup = join(codexDir, 'backup', `${backupName}.pre-mission-control-${now()}`)
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
      const existing = await lstat(backup).catch((error) => {
        if (missing(error)) return null
        throw error
      })
      if (existing) throw new Error(`backup already exists: ${backup}`)
      await rename(target, backup)
      result.movedAside.push(backup)
    }
    await symlink(source, target)
    result.linked.push(target)
  }
  const instructions = join(claudeDir, 'CLAUDE.md')
  await attempt(instructions, async () => {
    if (!(await stat(instructions)).isFile()) throw new Error('not a file')
    await attempt(join(codexDir, 'AGENTS.md'), () => link(instructions, join(codexDir, 'AGENTS.md'), 'AGENTS.md'))
  })
  const skills = join(claudeDir, 'skills')
  await attempt(skills, async () => {
    for (const entry of await readdir(skills, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const source = join(skills, entry.name)
      await attempt(source, async () => {
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await stat(source)).isDirectory())) return
        const target = join(codexDir, 'skills', entry.name)
        await attempt(target, () => link(source, target, join('skills', entry.name)))
      })
    }
  })
  const agents = join(claudeDir, 'agents')
  const ignored = new Set(['README', 'AGENTS', 'CLAUDE', 'CONTRIBUTING', 'GEMINI', 'ARCHITECTURE'])
  await attempt(agents, async () => {
    for (const entry of await readdir(agents, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || ignored.has(entry.name.slice(0, -3).toUpperCase())) continue
      const source = join(agents, entry.name)
      await attempt(source, async () => {
        const content = agentMarkdownToToml(await readFile(source, 'utf8'), entry.name.slice(0, -3))
        if (content === null) throw new Error('missing or invalid YAML front matter')
        const target = join(codexDir, 'agents', `${entry.name.slice(0, -3)}.toml`)
        await attempt(target, async () => {
          const previous = await readFile(target, 'utf8').catch((error) => {
            if (missing(error)) return null
            throw error
          })
          if (previous === content) return
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content)
          result.written.push(target)
        })
      })
    }
  })
  return result
}
