import { getJson, readArray } from './shared'
import { blendColor, fold, glide, settleIn } from './morph'
import { chatSignal, historyDay, historyOpen, type HistoryItem } from './chat-view'
import { renameValue, sessionSlot, type Session } from './terminal-state'
import { confirmButton } from './confirm-button'

type Day = 'Today' | 'Yesterday'
type Row = { item: HistoryItem; state: 'running' | 'live' | 'landed' | 'needs' | null; note: string }

const POLL_MS = 5000
const DAYS: Day[] = ['Today', 'Yesterday']
const CHAT_ICON = '<svg viewBox="0 0 20 20"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/></svg>'
const TERMINAL_ICON = '<svg><use href="#terminal-icon"/></svg>'
const SHORTCUT_SLOTS = 9
const HIDDEN_KEY = 'mc.sidebar.hidden'
const keyOf = (item: HistoryItem): string => `${item.kind}:${item.id}`
const isLiveTerminal = (item: HistoryItem): boolean => item.kind === 'terminal' && item.live

const isActive = (item: HistoryItem): boolean => isLiveTerminal(item) || (item.kind === 'chat' && item.running)

export function sidebarGroups(items: HistoryItem[], now: number): { day: Day; items: HistoryItem[] }[] {
  const dayOf = (item: HistoryItem): Day | null => {
    const day = historyDay(item.updatedAt, now)
    if (day === 'Today' || day === 'Yesterday') return day
    return isActive(item) ? 'Today' : null
  }
  return DAYS.map(day => ({ day, items: items.filter(item => dayOf(item) === day) })).filter(group => group.items.length > 0)
}

export function withLiveTerminals(items: HistoryItem[], sessions: Session[] | null, now: number): HistoryItem[] {
  if (!sessions) return items
  const known = new Map(items.flatMap(item => item.kind === 'terminal' ? [[item.id, item] as const] : []))
  const live = sessions.map((session): HistoryItem => ({ kind: 'terminal', id: session.id, title: session.title, updatedAt: known.get(session.id)?.updatedAt ?? now, cwd: session.cwd, engine: session.engine, sessionId: session.sessionId ?? known.get(session.id)?.sessionId ?? null, live: true }))
  const liveIds = new Set(sessions.map(session => session.id))
  const openSessions = new Set(sessions.flatMap(session => session.sessionId ? [session.sessionId] : []))
  const superseded = (item: HistoryItem): boolean => {
    if (item.kind === 'claude-history') return openSessions.has(item.id)
    if (item.kind !== 'terminal') return false
    return item.live || liveIds.has(item.id) || (item.sessionId !== null && openSessions.has(item.sessionId))
  }
  return [...items.filter(item => !superseded(item)), ...live].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function visibleItems(items: readonly HistoryItem[], hidden: Readonly<Record<string, number>>): HistoryItem[] {
  return items.filter(item => { const at = hidden[keyOf(item)]; return at === undefined || item.updatedAt > at })
}

const inRail = (row: Row): boolean => row.state === 'running' || row.state === 'live'

export function numberedKeys(items: readonly HistoryItem[], collapsed = false): string[] {
  return items.filter(item => historyOpen(item) !== null && (!collapsed || inRail(rowOf(item)))).slice(0, SHORTCUT_SLOTS).map(keyOf)
}

function rowOf(item: HistoryItem): Row {
  if (item.kind !== 'chat') return { item, state: isLiveTerminal(item) ? 'live' : null, note: '' }
  const signal = chatSignal(item.running, item.agents)
  if (signal.state === 'needs-you') return { item, state: 'needs', note: `${signal.count} needs you` }
  return { item, state: signal.state, note: signal.state === 'running' && signal.count > 0 ? `${signal.count} agent${signal.count === 1 ? '' : 's'}` : '' }
}

let openChatId: string | null = null
let signature = ''
let historyItems: HistoryItem[] = []
let liveTerminals: Session[] | null = null
let numbered: HistoryItem[] = []
let hidden: Record<string, number> = readHidden()

function readHidden(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, number> } catch { return {} }
}

function hide(key: string): void {
  hidden = { ...hidden, [key]: Date.now() }
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)) } catch {}
  const repaint = (): void => { signature = ''; paint(historyItems) }
  const row = document.querySelector<HTMLElement>(`#sidebar-list .sb-row[data-key="${CSS.escape(key)}"]`)?.closest<HTMLElement>('.sb-item')
  if (row) fold(row, repaint)
  else repaint()
}
let renaming = false

function selectedKey(): string | null {
  if (document.body.dataset.live === 'true') { const id = new URL(location.href).searchParams.get('terminal'); return id ? `terminal:${id}` : null }
  return openChatId && !document.getElementById('conversation')?.hidden ? `chat:${openChatId}` : null
}

function open(item: HistoryItem): void {
  const target = historyOpen(item)
  if (target === null) return
  if ('chat' in target) dispatchEvent(new CustomEvent('quiet:open-chat', { detail: target.chat }))
  else dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: target.terminal }))
}

function startRename(item: HistoryItem, text: HTMLElement): void {
  if (renaming) return
  renaming = true
  const input = Object.assign(document.createElement('input'), { className: 'sb-rename', value: item.title, maxLength: 60 })
  input.setAttribute('aria-label', 'Terminal name')
  text.replaceWith(input)
  settleIn(input)
  let settled = false
  const finish = (save: boolean): void => {
    if (settled) return
    settled = true
    renaming = false
    const title = save ? renameValue(item.title, input.value) : null
    input.replaceWith(text)
    settleIn(text)
    if (title !== null) dispatchEvent(new CustomEvent('quiet:terminal-rename', { detail: { id: item.id, title } }))
    signature = ''
    paint(historyItems)
  }
  input.onkeydown = (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); finish(true) }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
  }
  input.onblur = () => finish(false)
  input.onclick = (event) => { event.stopPropagation(); event.preventDefault() }
  input.focus()
  input.select()
}

function liveTerminalActions(item: HistoryItem, element: HTMLElement, text: HTMLElement | null): void {
  element.draggable = true
  element.ondragstart = (event) => { event.dataTransfer?.setData('text/x-mc-terminal', item.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }
  if (text) text.ondblclick = (event) => { event.preventDefault(); event.stopPropagation(); startRename(item, text) }
}

function removeButton(item: HistoryItem, wrap: HTMLElement, state: Row['state']): void {
  const live = isLiveTerminal(item)
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'sb-morph', title: live ? 'End and remove this terminal' : 'Remove from sidebar' })
  if (state) button.dataset.s = state
  button.setAttribute('aria-label', `Remove ${item.title}`)
  button.innerHTML = '<svg aria-hidden="true"><use href="#close-icon"/></svg><span>Remove</span>'
  wrap.append(button)
  confirmButton(button, 'Remove', () => {
    if (live) dispatchEvent(new CustomEvent('quiet:terminal-end', { detail: item.id }))
    else hide(keyOf(item))
  })
}

function rowElement(row: Row, className: 'sb-row' | 'sb-mini'): HTMLElement {
  const element = document.createElement('a')
  element.className = className
  element.dataset.kind = row.item.kind
  element.dataset.key = keyOf(row.item)
  element.href = row.item.kind === 'chat' ? `?chat=${encodeURIComponent(row.item.id)}` : isLiveTerminal(row.item) ? `?terminal=${encodeURIComponent(row.item.id)}#terminal` : '#'
  element.onclick = (event) => { event.preventDefault(); open(row.item) }
  const icon = document.createElement('span'); icon.className = 'sb-ic'; icon.innerHTML = row.item.kind === 'chat' ? CHAT_ICON : TERMINAL_ICON
  element.append(icon)
  const slot = numbered.findIndex(item => keyOf(item) === keyOf(row.item))
  const badge = slot < 0 ? null : Object.assign(document.createElement('kbd'), { className: 'sb-key', textContent: `⌘${slot + 1}`, title: `Open · ⌘${slot + 1}` })
  const dot = row.state ? Object.assign(document.createElement('i'), { className: 'sb-dot' }) : null
  if (dot) dot.dataset.s = row.state!
  if (className === 'sb-mini') {
    element.title = row.item.title
    element.append(...[badge, dot].filter((part): part is HTMLElement => part !== null))
    return element
  }
  const text = document.createElement('span'); text.className = 'sb-t'; text.textContent = row.item.title
  if (row.note) text.append(Object.assign(document.createElement('small'), { textContent: row.note }))
  const trail = document.createElement('span'); trail.className = 'sb-trail'
  trail.append(...[badge, Object.assign(document.createElement('span'), { className: 'sb-slot' })].filter((part): part is HTMLElement => part !== null))
  element.append(text, trail)
  const wrap = document.createElement('div')
  wrap.className = 'sb-item'
  wrap.append(element)
  if (isLiveTerminal(row.item)) liveTerminalActions(row.item, element, text)
  removeButton(row.item, wrap, row.state)
  return wrap
}

function dotElements(): Array<[string, HTMLElement]> {
  const inList = [...document.querySelectorAll<HTMLElement>('#sidebar-list .sb-morph')].map((dot): [string, HTMLElement] => [(dot.previousElementSibling as HTMLElement | null)?.dataset.key ?? '', dot])
  const inRail = [...document.querySelectorAll<HTMLElement>('#sidebar-mini .sb-dot')].map((dot): [string, HTMLElement] => [`rail:${(dot.parentElement as HTMLElement).dataset.key}`, dot])
  return [...inList, ...inRail]
}

function dotColors(): Map<string, string> {
  return new Map(dotElements().map(([key, dot]) => [key, getComputedStyle(dot).backgroundColor]))
}

let lastSelected: HTMLElement | null = null

function markSelected(): void {
  const key = selectedKey()
  const list = document.getElementById('sidebar-list')
  const from = list?.querySelector<HTMLElement>('.sb-row.sel') ?? (lastSelected?.isConnected ? lastSelected : null)
  document.querySelectorAll<HTMLElement>('#sidebar .sb-row, #sidebar .sb-mini').forEach(element => {
    const selected = element.dataset.key === key
    element.classList.toggle('sel', selected)
    if (selected) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current')
  })
  const to = list?.querySelector<HTMLElement>('.sb-row.sel') ?? null
  if (list && from && to && from !== to) glide(list, from, to, 'sb-glide')
  if (to) lastSelected = to
}

function paint(items: HistoryItem[]): void {
  historyItems = items
  if (renaming) return
  const groups = sidebarGroups(visibleItems(withLiveTerminals(items, liveTerminals, Date.now()), hidden), Date.now())
  const rows = groups.flatMap(group => group.items.map(rowOf))
  const keys = numberedKeys(rows.map(row => row.item), document.getElementById('sb-shell')?.classList.contains('collapsed'))
  numbered = keys.map(key => rows.find(row => keyOf(row.item) === key)!.item)
  const next = JSON.stringify([groups.map(group => [group.day, group.items.length]), rows.map(row => [row.item.kind, row.item.id, row.item.title, row.state, row.note]), keys])
  if (next === signature) return
  signature = next
  const list = document.getElementById('sidebar-list')!
  const dots = dotColors()
  list.replaceChildren(...groups.flatMap(group => [
    Object.assign(document.createElement('p'), { className: 'sb-day', textContent: group.day }),
    ...group.items.map(item => rowElement(rowOf(item), 'sb-row')),
  ]))
  document.getElementById('sidebar-mini')!.replaceChildren(...rows.filter(inRail).map(row => rowElement(row, 'sb-mini')))
  for (const [key, dot] of dotElements()) blendColor(dot, dots.get(key))
  markSelected()
}

let timer = 0
async function poll(): Promise<void> {
  clearTimeout(timer)
  if (document.visibilityState === 'visible') {
    const feed = await getJson('/api/history')
    if (feed.ok) paint(readArray(feed.data.items) as unknown as HistoryItem[])
  }
  timer = window.setTimeout(() => void poll(), POLL_MS)
}

if (typeof document !== 'undefined') {
  addEventListener('quiet:chat-open', (event) => { openChatId = (event as CustomEvent<string>).detail; markSelected(); void poll() })
  addEventListener('quiet:terminals', (event) => { liveTerminals = (event as CustomEvent<Session[]>).detail; paint(historyItems); markSelected() })
  addEventListener('quiet:new-chat', () => { openChatId = null; markSelected() })
  addEventListener('quiet:sidebar-toggle', () => paint(historyItems))
  addEventListener('quiet:terminal-ended', (event) => hide(`terminal:${(event as CustomEvent<string>).detail}`))
  for (const name of ['quiet:screen', 'quiet:activity-scope']) addEventListener(name, markSelected)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void poll() })
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return
    const item = numbered[sessionSlot(event) ?? -1]
    if (!item) return
    event.preventDefault()
    open(item)
  })
  void poll()
}
