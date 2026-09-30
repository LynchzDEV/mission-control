import { readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

export const FILE_LIST_CACHE_MS = 10_000
export const FILE_LIST_MAX = 5_000
export const MENTION_LIMIT = 8

export type MentionFile = { path: string; folder: string }

type CacheEntry = { at: number; files: string[] }

const cache = new Map<string, CacheEntry>()

async function readdirFallback(root: string, dir = ''): Promise<string[]> {
  const found: string[] = []
  let entries
  try {
    entries = await readdir(joinPath(root, dir), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const relative = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...await readdirFallback(root, relative))
    else if (entry.isFile()) found.push(relative)
    if (found.length >= FILE_LIST_MAX) return found.slice(0, FILE_LIST_MAX)
  }
  return found
}

function joinPath(root: string, relative: string): string {
  return relative === '' ? root : `${root.replace(/\/+$/, '')}/${relative}`
}

export async function listProjectFiles(root: string, now: number = Date.now()): Promise<string[]> {
  const cached = cache.get(root)
  if (cached !== undefined && now - cached.at < FILE_LIST_CACHE_MS) return cached.files
  let files: string[] = []
  try {
    const proc = Bun.spawn(['git', '-C', root, 'ls-files'], { stdout: 'pipe', stderr: 'ignore' })
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code === 0) files = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  } catch {
    files = []
  }
  if (files.length === 0) files = await readdirFallback(root)
  files = files.slice(0, FILE_LIST_MAX)
  cache.set(root, { at: now, files })
  return files
}

export function subsequenceAt(path: string, query: string): number[] | null {
  const marks: number[] = []
  let cursor = 0
  for (let index = 0; index < query.length; index += 1) {
    const found = path.toLowerCase().indexOf(query[index]!.toLowerCase(), cursor)
    if (found < 0) return null
    marks.push(found)
    cursor = found + 1
  }
  return marks
}

export function rankFiles(files: readonly string[], query: string, limit = MENTION_LIMIT): MentionFile[] {
  const needle = query.toLowerCase()
  const contiguous: Array<{ path: string; length: number }> = []
  const scattered: Array<{ path: string; first: number; length: number }> = []
  for (const path of files) {
    if (needle === '' || basename(path).toLowerCase().includes(needle)) {
      contiguous.push({ path, length: path.length })
      continue
    }
    const marks = subsequenceAt(path, needle)
    if (marks !== null) scattered.push({ path, first: marks[0] ?? 0, length: path.length })
  }
  contiguous.sort((left, right) => left.length - right.length)
  scattered.sort((left, right) => left.first - right.first || left.length - right.length)
  return [...contiguous, ...scattered].slice(0, limit).map(entry => ({ path: entry.path, folder: dirname(entry.path) }))
}
