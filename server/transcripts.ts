import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const SCAN_LIMIT_BYTES = 4 * 1024 * 1024
const TITLE_MAX = 80
const DEFAULT_LIMIT = 50

export type SessionSummary = {
  id: string
  title: string
  startedAt: number | null
  updatedAt: number
  bytes: number
}

type JsonRecord = Record<string, unknown>

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

export function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

function messageText(entry: JsonRecord): string | null {
  const message = entry.message
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null
  const content = (message as JsonRecord).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const item of content) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const block = item as JsonRecord
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return null
}

type Prompt = { text: string; timestamp: number | null }

function promptFromLine(line: string): Prompt | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const entry = parsed as JsonRecord
  if (entry.type !== 'user') return null
  const text = messageText(entry)
  if (text === null) return null
  const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
  return { text, timestamp: Number.isFinite(timestamp) ? timestamp : null }
}

// Attachment/system preamble routinely pushes the first prompt past 80KB, so scan lines with early exit instead of a fixed head.
async function firstPrompt(filePath: string): Promise<Prompt | null> {
  const stream = createReadStream(filePath, { start: 0, end: SCAN_LIMIT_BYTES - 1 })
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  let fallback: Prompt | null = null
  try {
    for await (const line of lines) {
      const prompt = promptFromLine(line)
      if (prompt === null) continue
      if (fallback === null) fallback = prompt
      if (!prompt.text.startsWith('<')) return prompt
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return fallback
}

async function summarize(filePath: string, fileName: string): Promise<SessionSummary | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return null
    const prompt = await firstPrompt(filePath)
    if (prompt === null) return null
    return {
      id: fileName.replace(/\.jsonl$/, ''),
      title: prompt.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX),
      startedAt: prompt.timestamp,
      updatedAt: info.mtimeMs,
      bytes: info.size,
    }
  } catch {
    return null
  }
}

export async function listSessions(
  cwd: string,
  opts: { projectsDir?: string; limit?: number } = {},
): Promise<SessionSummary[]> {
  const dir = join(opts.projectsDir ?? defaultProjectsDir(), projectSlug(cwd))
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const summaries: SessionSummary[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const summary = await summarize(join(dir, entry.name), entry.name)
    if (summary !== null) summaries.push(summary)
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return summaries.slice(0, opts.limit ?? DEFAULT_LIMIT)
}
