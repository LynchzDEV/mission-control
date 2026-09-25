export type Session = { id: string; engine: string; cwd: string; title: string; model?: string | null }
export type SessionState = 'working' | 'idle' | 'ended'

export const WORKING_WINDOW_MS = 5000
const MAX_LINE = 80
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function sessionState(lastOutputAt: number | null, ended: boolean, now: number): SessionState {
  if (ended) return 'ended'
  return lastOutputAt !== null && now - lastOutputAt < WORKING_WINDOW_MS ? 'working' : 'idle'
}

export function latestLine(raw: string): string {
  const lines = raw.replace(ANSI, '').replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  return last.length > MAX_LINE ? `${last.slice(0, MAX_LINE - 1)}…` : last
}

export function nextActive(ids: string[], removed: string, current: string | null): string | null {
  const remaining = ids.filter(id => id !== removed)
  if (current !== null && current !== removed && remaining.includes(current)) return current
  const index = ids.indexOf(removed)
  return remaining[index] ?? remaining[index - 1] ?? null
}

export type SplitPlan = { id: string; direction: 'right' | 'below' } | null

export function splitPlan(dragged: string, shown: string[], zone: 'right' | 'bottom' | null): SplitPlan {
  if (zone === null || shown.includes(dragged)) return null
  return { id: dragged, direction: zone === 'right' ? 'right' : 'below' }
}

export function renameValue(current: string, typed: string): string | null {
  const next = typed.trim().slice(0, 60)
  return next === '' || next === current ? null : next
}

export type DragKind = 'card' | 'files' | 'none'

export function dragKind(types: readonly string[]): DragKind {
  if (types.includes('text/x-mc-terminal')) return 'card'
  if (types.includes('Files') || types.includes('text/uri-list')) return 'files'
  return 'none'
}

export type FindKey = 'open' | 'next' | 'prev' | 'close' | null

export function findKeys(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, findOpen: boolean): FindKey {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') return 'open'
  if (!findOpen) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter') return event.shiftKey ? 'prev' : 'next'
  return null
}

export function dropCopy(count: number): { title: string; toast: string } {
  const files = count === 0 ? 'files' : `${count} file${count === 1 ? '' : 's'}`
  return { title: `Drop to add ${files}`, toast: `Added ${files}` }
}
