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

export type UserSession = SessionSummary & { cwd: string }
type SessionHead = { entrypoint: string | null; cwd: string | null; prompt: Prompt | null; aiTitle: string | null }
type SessionFile = { path: string; id: string; mtimeMs: number; size: number }

const INTERACTIVE_ENTRYPOINT = 'cli'
const HOUSEKEEPING_COMMANDS = new Set(['/clear', '/compact', '/model', '/resume', '/config', '/status', '/cost', '/help', '/login', '/logout', '/permissions', '/doctor', '/fast', '/exit'])
const COMMAND_NAME = /<command-name>\s*([^<]+?)\s*<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

function commandTitle(text: string): string | null {
  const name = COMMAND_NAME.exec(text)?.[1]
  if (!name) return null
  const command = name.startsWith('/') ? name : `/${name}`
  if (HOUSEKEEPING_COMMANDS.has(command)) return null
  return `${command} ${COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ''}`.trim()
}

function typedPrompt(entry: JsonRecord, line: string): Prompt | null {
  if (entry.type !== 'user' || entry.isMeta === true) return null
  const prompt = promptFromLine(line)
  if (prompt === null) return null
  const command = commandTitle(prompt.text)
  if (command !== null) return { ...prompt, text: command }
  return prompt.text.startsWith('<') ? null : prompt
}
const heads = new Map<string, { size: number; head: SessionHead }>()

function recordFromLine(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null
  } catch {
    return null
  }
}

async function readSessionHead(filePath: string): Promise<SessionHead> {
  const head: SessionHead = { entrypoint: null, cwd: null, prompt: null, aiTitle: null }
  const stream = createReadStream(filePath, { start: 0, end: SCAN_LIMIT_BYTES - 1 })
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of lines) {
      const entry = recordFromLine(line)
      if (entry === null) continue
      if (head.entrypoint === null && typeof entry.entrypoint === 'string') head.entrypoint = entry.entrypoint
      if (head.cwd === null && typeof entry.cwd === 'string') head.cwd = entry.cwd
      if (head.entrypoint !== null && head.entrypoint !== INTERACTIVE_ENTRYPOINT) break
      if (head.aiTitle === null && entry.type === 'ai-title' && typeof entry.aiTitle === 'string') head.aiTitle = entry.aiTitle
      if (head.prompt === null) head.prompt = typedPrompt(entry, line)
      if (head.prompt !== null && head.entrypoint !== null && head.cwd !== null) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return head
}

async function sessionHead(file: SessionFile): Promise<SessionHead> {
  const cached = heads.get(file.path)
  if (cached !== undefined) {
    const nonInteractive = cached.head.entrypoint !== null && cached.head.entrypoint !== INTERACTIVE_ENTRYPOINT
    if (nonInteractive || cached.head.prompt !== null || cached.size === file.size) return cached.head
  }
  const head = await readSessionHead(file.path)
  heads.set(file.path, { size: file.size, head })
  return head
}

async function recentSessionFiles(projectsDir: string, since: number): Promise<SessionFile[]> {
  let folders: string[]
  try {
    folders = await readdir(projectsDir)
  } catch {
    return []
  }
  const files = await Promise.all(folders.map(async (folder) => {
    const dir = join(projectsDir, folder)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const found = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map(async (entry): Promise<SessionFile | null> => {
      const path = join(dir, entry.name)
      const info = await stat(path).catch(() => null)
      return info === null || info.mtimeMs < since ? null : { path, id: entry.name.slice(0, -'.jsonl'.length), mtimeMs: info.mtimeMs, size: info.size }
    }))
    return found.filter((file): file is SessionFile => file !== null)
  }))
  return files.flat().sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export async function listUserSessions(opts: { projectsDir?: string; since: number; limit: number }): Promise<UserSession[]> {
  const sessions: UserSession[] = []
  for (const file of await recentSessionFiles(opts.projectsDir ?? defaultProjectsDir(), opts.since)) {
    if (sessions.length >= opts.limit) break
    const head = await sessionHead(file).catch(() => null)
    if (head?.entrypoint !== INTERACTIVE_ENTRYPOINT || head.prompt === null || head.cwd === null) continue
    sessions.push({ id: file.id, title: (head.aiTitle ?? head.prompt.text).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX), startedAt: head.prompt.timestamp, updatedAt: file.mtimeMs, bytes: file.size, cwd: head.cwd })
  }
  return sessions
}
