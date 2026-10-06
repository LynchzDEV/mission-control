import type { IClipboardProvider } from '@xterm/addon-clipboard'

export type Session = { id: string; engine: string; cwd: string; title: string; model?: string | null; sessionId?: string | null }
export type SessionState = 'working' | 'idle' | 'ended'

export function writeOnlyClipboard(clipboard: { writeText(text: string): Promise<void> } | undefined): IClipboardProvider {
  return {
    readText: () => '',
    writeText: async (_selection, text) => { await clipboard?.writeText(text).catch(() => undefined) },
  }
}

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

export type Box = { left: number; top: number; right: number; bottom: number }
export type DividerPair = { before: number; after: number; axis: 'width' | 'height' } | null

export function dividerPair(divider: Box, panes: Box[]): DividerPair {
  const sideBySide = divider.bottom - divider.top > divider.right - divider.left
  const alongside = (pane: Box) => sideBySide ? pane.top < divider.bottom && pane.bottom > divider.top : pane.left < divider.right && pane.right > divider.left
  const nearest = (gap: (pane: Box) => number) => panes
    .map((pane, index) => ({ index, gap: gap(pane) }))
    .filter(({ index, gap }) => gap >= 0 && alongside(panes[index]))
    .sort((a, b) => a.gap - b.gap)[0]?.index
  const before = nearest(pane => sideBySide ? divider.left - pane.right : divider.top - pane.bottom)
  const after = nearest(pane => sideBySide ? pane.left - divider.right : pane.top - divider.bottom)
  if (before === undefined || after === undefined) return null
  return { before, after, axis: sideBySide ? 'width' : 'height' }
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

export function findKeys(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, findOpen: boolean, mac: boolean): FindKey {
  if ((mac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'f') return 'open'
  if (!findOpen) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter') return event.shiftKey ? 'prev' : 'next'
  return null
}

type KeyEvent = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }
export type TerminalKey = 'newline' | 'send-now' | 'clear' | 'kill-line' | 'line-start' | 'line-end' | null
const COMMAND_KEYS: Record<string, TerminalKey> = { k: 'clear', Backspace: 'kill-line', ArrowLeft: 'line-start', ArrowRight: 'line-end' }

export function terminalKeys(event: KeyEvent): TerminalKey {
  const onlyShift = event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
  const onlyCtrl = event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
  if (event.key === 'Enter') return onlyShift ? 'newline' : onlyCtrl ? 'send-now' : null
  if (!event.metaKey || event.ctrlKey || event.altKey) return null
  return COMMAND_KEYS[event.key] ?? null
}

export function sessionSlot(event: KeyEvent): number | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return null
  return Number(event.key) - 1
}

export function dropCopy(count: number): { title: string; toast: string } {
  const files = count === 0 ? 'files' : `${count} file${count === 1 ? '' : 's'}`
  return { title: `Drop to add ${files}`, toast: `Added ${files}` }
}

export const FIND_CAP = 1000

export function findCount(index: number, count: number, term: string): string {
  if (term === '') return ''
  if (count === 0) return 'No matches'
  return `${index + 1} of ${count >= FIND_CAP ? `${FIND_CAP}+` : count}`
}

export function restoreTarget(urlId: string | null, storedId: string | null, ids: readonly string[]): string | null {
  for (const candidate of [urlId, storedId]) if (candidate && ids.includes(candidate)) return candidate
  return ids[0] ?? null
}

export type ScrollAction = { kind: 'lines'; amount: number } | { kind: 'wheel'; deltaY: number }

export function scrollAction(mouseTracking: boolean, direction: 'up' | 'down', lines: number): ScrollAction {
  const count = Math.max(0, lines)
  const signed = direction === 'up' ? 0 - count : count
  return mouseTracking ? { kind: 'wheel', deltaY: signed } : { kind: 'lines', amount: signed }
}

export function dragLines(pixels: number, cellHeight: number): { lines: number; rest: number } {
  if (cellHeight <= 0) return { lines: 0, rest: 0 }
  const lines = Math.trunc(pixels / cellHeight) + 0
  return { lines, rest: pixels - lines * cellHeight }
}

export const KEY_ROW_BYTES = { esc: '\x1b', tab: '\t', 'ctrl-c': '\x03', left: '\x1b[D', right: '\x1b[C', enter: '\r' } as const
export type KeyRowByte = keyof typeof KEY_ROW_BYTES

const CTRL_MAPPABLE = /^[a-zA-Z@[\\\]^_ ]$/

export function withCtrl(char: string): string | null {
  if (!CTRL_MAPPABLE.test(char)) return null
  return char === ' ' ? '\x00' : String.fromCharCode(char.charCodeAt(0) & 0x1f)
}

export function backToLiveText(newLines: number): string {
  if (newLines <= 0) return '↓ Back to live'
  return `↓ Back to live · ${newLines} new line${newLines === 1 ? '' : 's'}`
}

export type LiveJump = { anchor: number | null; newLines: number }

export function liveJump(viewportY: number, baseY: number, anchor: number | null): LiveJump {
  if (viewportY >= baseY) return { anchor: null, newLines: 0 }
  const from = anchor ?? baseY
  return { anchor: from, newLines: Math.max(0, baseY - from) }
}

export type StatusPill = { kind: 'live' | 'muted' | 'down'; text: string }

export function statusPill(status: string): StatusPill {
  if (status.startsWith('Connected')) return { kind: 'live', text: 'Live' }
  if (status === 'Connecting…' || status === 'Reconnecting…') return { kind: 'muted', text: status }
  if (status === 'Session ended.') return { kind: 'muted', text: 'Ended' }
  return { kind: 'down', text: 'Disconnected · Reconnect' }
}
