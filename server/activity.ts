export type ActivityKind = 'tool' | 'text' | 'thinking' | 'result' | 'error'

export type ActivityEvent = {
  ts?: number
  kind: ActivityKind
  title: string
  detail: string
  toolUseId?: string
  input?: string
  result?: string
  resultIsError?: boolean
}

export const DEFAULT_ACTIVITY_MAX = 50
export const TEXT_PREVIEW_CHARS = 80
export const DETAIL_PREVIEW_CHARS = 60
export const ACTIVITY_THROTTLE_MS = 2_000
export const FULL_TEXT = -1

const TOOL_DETAIL_KEYS: Record<string, readonly string[]> = {
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  Read: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Bash: ['description', 'command'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  Task: ['description'],
  Agent: ['description'],
  WebFetch: ['url'],
  WebSearch: ['query'],
}

const GENERIC_DETAIL_KEYS: readonly string[] = [
  'description',
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
]

type Limits = { text: number; result: number; full: boolean }

const TICKER_LIMITS: Limits = { text: TEXT_PREVIEW_CHARS, result: DETAIL_PREVIEW_CHARS, full: false }
const THREAD_LIMITS: Limits = { text: FULL_TEXT, result: FULL_TEXT, full: true }

type ToolResult = { text: string; isError: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

// Full mode keeps newlines — a transcript row is prose, not a ticker line.
function clip(value: string, max: number): string {
  return max < 0 ? value.trim() : oneLine(value, max)
}

function readTimestamp(raw: Record<string, unknown>): number | undefined {
  const candidate = raw.ts ?? raw.timestamp
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  if (typeof candidate === 'string') {
    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function withTs(event: ActivityEvent, ts: number | undefined): ActivityEvent {
  return ts === undefined ? event : { ...event, ts }
}

function firstStringValue(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

export function toolDetail(name: string, input: unknown): string {
  if (!isRecord(input)) return ''
  const preferred = TOOL_DETAIL_KEYS[name]
  const chosen =
    (preferred === undefined ? '' : firstStringValue(input, preferred)) ||
    firstStringValue(input, GENERIC_DETAIL_KEYS) ||
    firstStringValue(input, Object.keys(input))
  return oneLine(chosen, DETAIL_PREVIEW_CHARS)
}

export function formatToolInput(input: unknown): string {
  if (input === undefined) return ''
  try {
    return JSON.stringify(input, null, 2) ?? ''
  } catch {
    return ''
  }
}

function toolEvent(block: Record<string, unknown>, limits: Limits): ActivityEvent | null {
  const name = asString(block.name)
  if (name === '') return null
  const base: ActivityEvent = { kind: 'tool', title: name, detail: toolDetail(name, block.input) }
  if (!limits.full) return base
  const toolUseId = asString(block.id)
  const input = formatToolInput(block.input)
  return {
    ...base,
    ...(toolUseId === '' ? {} : { toolUseId }),
    ...(input === '' ? {} : { input }),
  }
}

function assistantEvents(message: unknown, ts: number | undefined, limits: Limits): ActivityEvent[] {
  if (!isRecord(message)) return []
  const content = message.content
  if (!Array.isArray(content)) return []

  const events: ActivityEvent[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'tool_use') {
      const event = toolEvent(block, limits)
      if (event !== null) events.push(withTs(event, ts))
      continue
    }
    if (block.type === 'thinking') {
      const detail = clip(asString(block.thinking), limits.text)
      if (detail === '') continue
      events.push(withTs({ kind: 'thinking', title: 'THINKING', detail }, ts))
      continue
    }
    if (block.type === 'text') {
      const detail = clip(asString(block.text), limits.text)
      if (detail === '') continue
      events.push(withTs({ kind: 'text', title: 'TEXT', detail }, ts))
    }
  }
  return events
}

function resultEvent(raw: Record<string, unknown>, ts: number | undefined, limits: Limits): ActivityEvent[] {
  const failed = raw.is_error === true || asString(raw.subtype).includes('error')
  const detail = clip(asString(raw.result) || asString(raw.subtype), limits.result)
  return [withTs({ kind: failed ? 'error' : 'result', title: failed ? 'ERROR' : 'RESULT', detail }, ts)]
}

function codexEvents(msg: Record<string, unknown>, ts: number | undefined, limits: Limits): ActivityEvent[] {
  const type = asString(msg.type)
  if (type === 'agent_message' || type === 'agent_reasoning') {
    const detail = clip(asString(msg.message) || asString(msg.text), limits.text)
    return detail === '' ? [] : [withTs({ kind: 'text', title: 'TEXT', detail }, ts)]
  }
  if (type === 'exec_command_begin') {
    const command = Array.isArray(msg.command) ? msg.command.map(asString).join(' ') : asString(msg.command)
    return [withTs({ kind: 'tool', title: 'Bash', detail: oneLine(command, DETAIL_PREVIEW_CHARS) }, ts)]
  }
  if (type === 'error') {
    return [withTs({ kind: 'error', title: 'ERROR', detail: oneLine(asString(msg.message), DETAIL_PREVIEW_CHARS) }, ts)]
  }
  return []
}

function codexItemEvents(item: unknown, ts: number | undefined, limits: Limits): ActivityEvent[] {
  if (!isRecord(item)) return []
  const type = asString(item.type)
  if (type === 'agent_message') {
    const detail = clip(asString(item.text), limits.text)
    return detail === '' ? [] : [withTs({ kind: 'text', title: 'TEXT', detail }, ts)]
  }
  if (type === 'error') {
    const detail = clip(asString(item.message), limits.result)
    return [withTs({ kind: 'error', title: 'ERROR', detail }, ts)]
  }
  return []
}

function eventsFrom(raw: Record<string, unknown>, limits: Limits): ActivityEvent[] {
  const ts = readTimestamp(raw)
  const type = asString(raw.type)
  if (type === 'assistant') return assistantEvents(raw.message, ts, limits)
  if (type === 'result') return resultEvent(raw, ts, limits)
  if (type === 'item.completed') return codexItemEvents(raw.item, ts, limits)
  if (isRecord(raw.msg)) return codexEvents(raw.msg, ts, limits)
  return []
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isRecord(block)) continue
    const text = asString(block.text)
    parts.push(text === '' ? (formatToolInput(block) || '') : text)
  }
  return parts.join('\n')
}

function collectToolResults(raw: Record<string, unknown>, into: Map<string, ToolResult>): void {
  const message = raw.message
  if (!isRecord(message)) return
  const content = message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    const id = asString(block.tool_use_id)
    if (id === '') continue
    into.set(id, { text: toolResultText(block.content).trim(), isError: block.is_error === true })
  }
}

function attachToolResult(event: ActivityEvent, results: Map<string, ToolResult>): ActivityEvent {
  if (event.kind !== 'tool' || event.toolUseId === undefined) return event
  const found = results.get(event.toolUseId)
  if (found === undefined) return event
  return { ...event, result: found.text, resultIsError: found.isError }
}

function parseStream(logText: string, max: number, limits: Limits): ActivityEvent[] {
  const events: ActivityEvent[] = []
  const results = new Map<string, ToolResult>()
  for (const line of logText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (limits.full && asString(parsed.type) === 'user') {
      collectToolResults(parsed, results)
      continue
    }
    events.push(...eventsFrom(parsed, limits))
  }
  const resolved = limits.full ? events.map((event) => attachToolResult(event, results)) : events
  if (max < 0 || resolved.length <= max) return resolved
  return resolved.slice(resolved.length - max)
}

export function parseActivity(logText: string, max: number = DEFAULT_ACTIVITY_MAX): ActivityEvent[] {
  return parseStream(logText, max, TICKER_LIMITS)
}

export function parseThread(logText: string): ActivityEvent[] {
  return parseStream(logText, FULL_TEXT, THREAD_LIMITS)
}

const SESSION_ID_HINTS = ['"session_id"', '"thread_id"'] as const

export function parseSessionId(logText: string): string | null {
  let found: string | null = null
  for (const line of logText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    if (!SESSION_ID_HINTS.some((hint) => trimmed.includes(hint))) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const id = asString(parsed.session_id) || asString(parsed.thread_id)
    if (id !== '') found = id
  }
  return found
}

export function formatActivity(event: ActivityEvent): string {
  if (event.detail === '') return event.title
  if (event.kind === 'text') return event.detail
  return `${event.title} · ${event.detail}`
}

export function currentActivity(events: readonly ActivityEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const line = formatActivity(events[index] as ActivityEvent)
    if (line !== '') return line
  }
  return null
}

export type ActivityThrottle = { ready(): boolean; remainingMs(): number }

export function createActivityThrottle(
  intervalMs: number = ACTIVITY_THROTTLE_MS,
  now: () => number = Date.now,
): ActivityThrottle {
  let last: number | null = null
  return {
    ready(): boolean {
      const at = now()
      if (last !== null && at - last < intervalMs) return false
      last = at
      return true
    },
    // How long until a throttled call would pass — the window a dropped chunk needs to be
    // revisited so a long tool pause never leaves currentActivity stuck on a stale line.
    remainingMs(): number {
      if (last === null) return 0
      return Math.max(0, intervalMs - (now() - last))
    },
  }
}
