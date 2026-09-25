import { getJson, readArray } from './shared'
import { chatSignal, historyDay, type HistoryItem } from './chat-view'

type Day = 'Today' | 'Yesterday' | 'Earlier'
type Listed = Extract<HistoryItem, { kind: 'chat' | 'terminal' }>
type Row = { item: Listed; state: 'running' | 'live' | 'landed' | 'needs' | null; note: string }

const POLL_MS = 5000
const DAYS: Day[] = ['Today', 'Yesterday', 'Earlier']
const CHAT_ICON = '<svg viewBox="0 0 20 20"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/></svg>'
const TERMINAL_ICON = '<svg><use href="#terminal-icon"/></svg>'

export function sidebarGroups(items: HistoryItem[], now: number): { day: Day; items: HistoryItem[] }[] {
  const listed = items.filter(item => item.kind === 'chat' || item.kind === 'terminal')
  const dayOf = (item: HistoryItem): Day => { const day = historyDay(item.updatedAt, now); return day === 'Today' || day === 'Yesterday' ? day : 'Earlier' }
  return DAYS.map(day => ({ day, items: listed.filter(item => dayOf(item) === day) })).filter(group => group.items.length > 0)
}

function rowOf(item: Listed): Row {
  if (item.kind === 'terminal') return { item, state: 'live', note: '' }
  const signal = chatSignal(item.running, item.agents)
  if (signal.state === 'needs-you') return { item, state: 'needs', note: `${signal.count} needs you` }
  return { item, state: signal.state, note: signal.state === 'running' && signal.count > 0 ? `${signal.count} agent${signal.count === 1 ? '' : 's'}` : '' }
}

let openChatId: string | null = null
let signature = ''

function selectedKey(): string | null {
  if (document.body.dataset.live === 'true') { const id = new URL(location.href).searchParams.get('terminal'); return id ? `terminal:${id}` : null }
  return openChatId && !document.getElementById('conversation')?.hidden ? `chat:${openChatId}` : null
}

function open(item: Listed): void {
  if (item.kind === 'chat') dispatchEvent(new CustomEvent('quiet:open-chat', { detail: item.id }))
  else dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { id: item.id } }))
}

function rowElement(row: Row, className: 'sb-row' | 'sb-mini'): HTMLElement {
  const element = document.createElement('a')
  element.className = className
  element.dataset.kind = row.item.kind
  element.dataset.key = `${row.item.kind}:${row.item.id}`
  element.href = row.item.kind === 'chat' ? `?chat=${encodeURIComponent(row.item.id)}` : `?terminal=${encodeURIComponent(row.item.id)}#terminal`
  element.onclick = (event) => { event.preventDefault(); open(row.item) }
  const icon = document.createElement('span'); icon.className = 'sb-ic'; icon.innerHTML = row.item.kind === 'chat' ? CHAT_ICON : TERMINAL_ICON
  element.append(icon)
  if (className === 'sb-row') {
    const text = document.createElement('span'); text.className = 'sb-t'; text.textContent = row.item.title
    if (row.note) text.append(Object.assign(document.createElement('small'), { textContent: row.note }))
    element.append(text)
  } else element.title = row.item.title
  if (row.state) { const dot = document.createElement('i'); dot.className = 'sb-dot'; dot.dataset.s = row.state; element.append(dot) }
  return element
}

function markSelected(): void {
  const key = selectedKey()
  document.querySelectorAll<HTMLElement>('#sidebar .sb-row, #sidebar .sb-mini').forEach(element => {
    const selected = element.dataset.key === key
    element.classList.toggle('sel', selected)
    if (selected) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current')
  })
}

function paint(items: HistoryItem[]): void {
  const groups = sidebarGroups(items, Date.now())
  const rows = groups.flatMap(group => group.items.map(item => rowOf(item as Listed)))
  const next = JSON.stringify([groups.map(group => [group.day, group.items.length]), rows.map(row => [row.item.kind, row.item.id, row.item.title, row.state, row.note])])
  if (next === signature) return
  signature = next
  const list = document.getElementById('sidebar-list')!
  list.replaceChildren(...groups.flatMap(group => [
    Object.assign(document.createElement('p'), { className: 'sb-day', textContent: group.day }),
    ...group.items.map(item => rowElement(rowOf(item as Listed), 'sb-row')),
  ]))
  document.getElementById('sidebar-mini')!.replaceChildren(...rows.filter(row => row.state === 'running' || row.state === 'live').map(row => rowElement(row, 'sb-mini')))
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
  addEventListener('quiet:new-chat', () => { openChatId = null; markSelected() })
  for (const name of ['quiet:screen', 'quiet:activity-scope']) addEventListener(name, markSelected)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void poll() })
  void poll()
}
