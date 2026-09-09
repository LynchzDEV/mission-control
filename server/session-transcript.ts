import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatToolInput, oneLine, toolDetail } from './activity'

export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024
const DETAIL_CHARS = 100
const TERMINAL_JOB = 'terminal'

export type TranscriptMessage = {
  jobId: string
  role: 'user' | 'assistant' | 'result'
  kind: 'prompt' | 'text' | 'thinking' | 'tool' | 'result'
  text: string
  title: string
  detail: string
  input: string
  result: string
  isError: boolean
}

type R = Record<string, unknown>
const isRecord = (value: unknown): value is R => value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

function row(partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, 'role' | 'kind'>): TranscriptMessage {
  return { jobId: TERMINAL_JOB, text: '', title: '', detail: '', input: '', result: '', isError: false, ...partial }
}

function injected(text: string): boolean {
  return text.trimStart().startsWith('<')
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (isRecord(block) ? str(block.text) : '')).filter(Boolean).join('\n')
}

function parseLines(text: string): R[] {
  const out: R[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

function attachResult(rows: TranscriptMessage[], pending: Map<string, number>, id: string, output: string, isError: boolean): void {
  const index = pending.get(id)
  if (index === undefined) return
  pending.delete(id)
  rows[index] = { ...rows[index]!, result: output, isError }
}

export function parseClaudeTranscript(text: string): TranscriptMessage[] {
  const rows: TranscriptMessage[] = []
  const pending = new Map<string, number>()
  for (const raw of parseLines(text)) {
    if (raw.isSidechain === true || raw.isMeta === true) continue
    const message = isRecord(raw.message) ? raw.message : null
    if (message === null) continue
    if (raw.type === 'user') {
      const content = message.content
      if (typeof content === 'string') {
        if (content.trim() !== '' && !injected(content)) rows.push(row({ role: 'user', kind: 'prompt', text: content }))
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block.type === 'tool_result') attachResult(rows, pending, str(block.tool_use_id), blockText(block.content), block.is_error === true)
        else if (block.type === 'text' && str(block.text).trim() !== '' && !injected(str(block.text))) rows.push(row({ role: 'user', kind: 'prompt', text: str(block.text) }))
      }
      continue
    }
    if (raw.type !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && str(block.text).trim() !== '') rows.push(row({ role: 'assistant', kind: 'text', text: str(block.text) }))
      else if (block.type === 'thinking' && str(block.thinking).trim() !== '') rows.push(row({ role: 'assistant', kind: 'thinking', text: str(block.thinking) }))
      else if (block.type === 'tool_use') {
        const name = str(block.name) || 'tool'
        rows.push(row({ role: 'assistant', kind: 'tool', title: name, detail: toolDetail(name, block.input), input: formatToolInput(block.input) }))
        if (str(block.id) !== '') pending.set(str(block.id), rows.length - 1)
      }
    }
  }
  return rows
}

function codexArguments(raw: unknown): { detail: string; input: string } {
  const source = str(raw)
  if (source === '') return { detail: '', input: '' }
  try {
    const parsed: unknown = JSON.parse(source)
    if (isRecord(parsed)) {
      const command = Array.isArray(parsed.cmd) ? parsed.cmd.map(str).join(' ') : str(parsed.cmd) || str(parsed.command)
      return { detail: oneLine(command || formatToolInput(parsed), DETAIL_CHARS), input: formatToolInput(parsed) }
    }
  } catch {
    // arguments were not JSON; show them as-is
  }
  return { detail: oneLine(source, DETAIL_CHARS), input: source }
}

export function parseCodexTranscript(text: string): TranscriptMessage[] {
  const rows: TranscriptMessage[] = []
  const pending = new Map<string, number>()
  for (const raw of parseLines(text)) {
    const payload = isRecord(raw.payload) ? raw.payload : null
    if (payload === null) continue
    if (raw.type === 'event_msg') {
      if (payload.type === 'error' && str(payload.message) !== '') rows.push(row({ role: 'result', kind: 'result', text: str(payload.message), isError: true }))
      continue
    }
    if (raw.type !== 'response_item') continue
    const type = str(payload.type)
    if (type === 'message') {
      const content = blockText(payload.content)
      if (content.trim() === '') continue
      if (payload.role === 'user') { if (!injected(content)) rows.push(row({ role: 'user', kind: 'prompt', text: content })) }
      else rows.push(row({ role: 'assistant', kind: 'text', text: content }))
      continue
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(payload.summary) ? payload.summary.map((item) => (isRecord(item) ? str(item.text) : '')).filter(Boolean).join('\n') : ''
      if (summary !== '') rows.push(row({ role: 'assistant', kind: 'thinking', text: summary }))
      continue
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const name = str(payload.name) || 'tool'
      const call = type === 'function_call' ? codexArguments(payload.arguments) : { detail: oneLine(str(payload.input).split('\n')[0] ?? '', DETAIL_CHARS), input: str(payload.input) }
      rows.push(row({ role: 'assistant', kind: 'tool', title: name, detail: call.detail, input: call.input }))
      if (str(payload.call_id) !== '') pending.set(str(payload.call_id), rows.length - 1)
      continue
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') attachResult(rows, pending, str(payload.call_id), str(payload.output), false)
  }
  return rows
}

export function parseTranscript(engine: string, text: string): TranscriptMessage[] {
  return engine === 'codex' ? parseCodexTranscript(text) : parseClaudeTranscript(text)
}

export async function readTranscriptTail(path: string, limit: number = TRANSCRIPT_TAIL_BYTES): Promise<string | null> {
  let handle
  try {
    const info = await stat(path)
    const start = Math.max(0, info.size - limit)
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(info.size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf-8')
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

export function claudeTranscriptPath(configDir: string | undefined, cwd: string, sessionId: string): string {
  const projects = configDir ? join(configDir, 'projects') : join(homedir(), '.claude', 'projects')
  return join(projects, cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`)
}

export function defaultCodexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions')
}

function dayDirs(since: number): string[] {
  const dirs: string[] = []
  for (let at = since - 24 * 60 * 60 * 1000; at <= Date.now() + 60_000; at += 24 * 60 * 60 * 1000) {
    const date = new Date(at)
    dirs.push(join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')))
  }
  return [...new Set(dirs)]
}

export async function findCodexRollout(cwd: string, since: number, root: string = defaultCodexSessionsDir()): Promise<string | null> {
  const candidates: Array<{ path: string; mtime: number }> = []
  for (const day of dayDirs(since)) {
    const dir = join(root, day)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.mtimeMs < since - 60_000) continue
        candidates.push({ path, mtime: info.mtimeMs })
      } catch {
        continue
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates) {
    const head = await readTranscriptTail(candidate.path, 64 * 1024)
    const meta = head === null ? null : parseLines(head).find((line) => line.type === 'session_meta')
    const payload = meta && isRecord(meta.payload) ? meta.payload : null
    if (payload && str(payload.cwd) === cwd && Date.parse(str(payload.timestamp)) >= since - 60_000) return candidate.path
  }
  return null
}
