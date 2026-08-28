export type ActivityKind = 'tool' | 'text' | 'result' | 'error'

export type ActivityEvent = {
  ts?: number
  kind: ActivityKind
  title: string
  detail: string
}

export const DEFAULT_ACTIVITY_MAX = 50
export const TEXT_PREVIEW_CHARS = 80
export const DETAIL_PREVIEW_CHARS = 60
export const ACTIVITY_THROTTLE_MS = 2_000

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

function assistantEvents(message: unknown, ts: number | undefined): ActivityEvent[] {
  if (!isRecord(message)) return []
  const content = message.content
  if (!Array.isArray(content)) return []

  const events: ActivityEvent[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'tool_use') {
      const name = asString(block.name)
      if (name === '') continue
      events.push(withTs({ kind: 'tool', title: name, detail: toolDetail(name, block.input) }, ts))
      continue
    }
    if (block.type === 'text') {
      const detail = oneLine(asString(block.text), TEXT_PREVIEW_CHARS)
      if (detail === '') continue
      events.push(withTs({ kind: 'text', title: 'TEXT', detail }, ts))
    }
  }
  return events
}

function resultEvent(raw: Record<string, unknown>, ts: number | undefined): ActivityEvent[] {
  const failed = raw.is_error === true || asString(raw.subtype).includes('error')
  const detail = oneLine(asString(raw.result) || asString(raw.subtype), DETAIL_PREVIEW_CHARS)
  return [withTs({ kind: failed ? 'error' : 'result', title: failed ? 'ERROR' : 'RESULT', detail }, ts)]
}

function codexEvents(msg: Record<string, unknown>, ts: number | undefined): ActivityEvent[] {
  const type = asString(msg.type)
  if (type === 'agent_message' || type === 'agent_reasoning') {
    const detail = oneLine(asString(msg.message) || asString(msg.text), TEXT_PREVIEW_CHARS)
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

function eventsFrom(raw: Record<string, unknown>): ActivityEvent[] {
  const ts = readTimestamp(raw)
  const type = asString(raw.type)
  if (type === 'assistant') return assistantEvents(raw.message, ts)
  if (type === 'result') return resultEvent(raw, ts)
  if (isRecord(raw.msg)) return codexEvents(raw.msg, ts)
  return []
}

export function parseActivity(logText: string, max: number = DEFAULT_ACTIVITY_MAX): ActivityEvent[] {
  const events: ActivityEvent[] = []
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
    events.push(...eventsFrom(parsed))
  }
  if (max < 0 || events.length <= max) return events
  return events.slice(events.length - max)
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

export type ActivityThrottle = { ready(): boolean }

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
  }
}
