import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir } from '../secrets'

export const MAX_CONTEXT_BYTES = 524288
export const CONTEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export class ContextTooLarge extends Error {
  constructor(bytes: number) {
    super(`Task context is ${bytes} bytes; the limit is ${MAX_CONTEXT_BYTES}`)
  }
}

export type TaskContext = { name: string; markdown: string }

const contextRoot = (): string => join(configDir(), 'context')

export function safeContextName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
  const base = slug || 'context'
  return base.endsWith('.md') ? base : `${base}.md`
}

function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

export async function writeContextFile(pluginId: string, context: TaskContext, now = new Date()): Promise<string> {
  const bytes = Buffer.byteLength(context.markdown)
  if (bytes > MAX_CONTEXT_BYTES) throw new ContextTooLarge(bytes)
  const dir = join(contextRoot(), pluginId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(contextRoot(), 0o700)
  await chmod(dir, 0o700)
  const path = join(dir, `${stamp(now)}-${safeContextName(context.name)}`)
  await writeFile(path, context.markdown, { mode: 0o600 })
  await chmod(path, 0o600)
  await sweepContextFiles(now)
  return path
}

export async function sweepContextFiles(now = new Date()): Promise<number> {
  const cutoff = now.getTime() - CONTEXT_MAX_AGE_MS
  let removed = 0
  const plugins = await readdir(contextRoot()).catch(() => [] as string[])
  for (const plugin of plugins) {
    const dir = join(contextRoot(), plugin)
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, file)
      const info = await stat(path).catch(() => null)
      if (info?.isFile() && info.mtimeMs < cutoff) {
        await rm(path, { force: true })
        removed++
      }
    }
  }
  return removed
}
