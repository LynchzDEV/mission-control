import { chmod, exists, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { configDir } from './secrets'

export type DroppedFileMeta = { name: string; size: number; lastModified: number }

export type DropDeps = {
  platform?: string
  runMdfind?: (meta: DroppedFileMeta) => Promise<string[]>
  statSize?: (path: string) => Promise<{ size: number; mtimeMs: number } | null>
}

export const MAX_DROP_BYTES = 100 * 1024 * 1024
export const MTIME_TOLERANCE_MS = 2_000

const MDFIND_TIMEOUT_MS = 8_000
const DROP_DIR_MODE = 0o700
const DROP_FILE_MODE = 0o600

export function checkDropSize(size: number): boolean {
  return size <= MAX_DROP_BYTES
}

export function spotlightQuery(meta: DroppedFileMeta): string {
  const escaped = meta.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `kMDItemFSName == "${escaped}" && kMDItemFSSize == ${meta.size}`
}

async function defaultRunMdfind(meta: DroppedFileMeta): Promise<string[]> {
  const proc = Bun.spawn(['mdfind', '-onlyin', homedir(), spotlightQuery(meta)], { stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => proc.kill(), MDFIND_TIMEOUT_MS)
  try {
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function defaultStatSize(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

export async function findOriginalFile(meta: DroppedFileMeta, deps?: DropDeps): Promise<string | null> {
  try {
    if ((deps?.platform ?? process.platform) !== 'darwin') return null
    const runMdfind = deps?.runMdfind ?? defaultRunMdfind
    const statSize = deps?.statSize ?? defaultStatSize
    const survivors: string[] = []
    for (const candidate of await runMdfind(meta)) {
      if (basename(candidate) !== meta.name) continue
      const info = await statSize(candidate)
      if (info === null || info.size !== meta.size) continue
      if (Math.abs(info.mtimeMs - meta.lastModified) > MTIME_TOLERANCE_MS) continue
      survivors.push(candidate)
    }
    return survivors.length === 1 ? (survivors[0] ?? null) : null
  } catch {
    return null
  }
}

export function safeDropName(name: string): string {
  const cleaned = basename(name)
    .replace(/[\x00-\x1f\x7f/\\]/g, '')
    .trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'drop'
  return cleaned
}

export async function saveDroppedCopy(
  name: string,
  bytes: Uint8Array | ArrayBuffer,
  dir?: string,
): Promise<string> {
  const target = dir ?? join(configDir(), 'drops')
  await mkdir(target, { recursive: true, mode: DROP_DIR_MODE })
  const safe = safeDropName(name)
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  let path = join(target, safe)
  if (await exists(path)) path = join(target, `${stem}-${Date.now()}${ext}`)
  await Bun.write(path, bytes)
  await chmod(path, DROP_FILE_MODE)
  return path
}
