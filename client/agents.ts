import {
  CARD_POLL_MS,
  DRAWER_POLL_MS,
  createMiniFeed,
  engineClass,
  groupByThread,
  sortThreadsByActivity,
  type MiniFeed,
  type ThreadGroup,
} from './thread-view'
import { installDrawer, isDrawerOpen, openDrawer } from './thread-drawer'
import { getJson, postJson, readArray, streamJobLog, type JsonRecord } from './shared'

export type AgentJob = {
  id: string
  engine: string
  label: string
  cwd: string
  status: string
  startedAt: number | null
  endedAt: number | null
  diffStat: string
  activity: string
  threadRoot: string
  terminalId: string
}

export type AgentThread = ThreadGroup<AgentJob>

export const RECENT_LIMIT = 8
export const AGENTS_STORE_KEY = 'mc.agents.open'

const POLL_MS = 3_000
const ELAPSED_TICK_MS = 1_000
const ABSENT_POLL_MS = 30_000
const SHORT_ID_CHARS = 8

const STATUS_GLYPH: Record<string, string> = {
  running: '●',
  done: '✓',
  failed: '✕',
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_CHARS)
}

export function toAgentJob(raw: JsonRecord): AgentJob {
  const id = str(raw.id, '?')
  return {
    id,
    engine: str(raw.engine, '?'),
    label: str(raw.label, shortId(id)),
    cwd: str(raw.cwd),
    status: str(raw.status, 'unknown'),
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
    diffStat: str(raw.diffStat),
    activity: str(raw.currentActivity),
    threadRoot: str(raw.threadRoot, id),
    terminalId: str(raw.terminalId),
  }
}

export function baseName(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.length === 0 ? path : (parts[parts.length - 1] as string)
}

export { engineClass as accentClass }

export function statusGlyph(status: string): string {
  return STATUS_GLYPH[status] ?? '·'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`
  return `${seconds}s`
}

export function jobElapsed(job: AgentJob, now: number): string {
  if (job.startedAt === null) return '—'
  return formatElapsed((job.endedAt ?? now) - job.startedAt)
}

// Jobs sharing a threadRoot are one conversation and render as one card: RECENT_LIMIT below
// bounds threads, not raw job rows.
export function splitAgents(jobs: AgentJob[]): { running: AgentThread[]; recent: AgentThread[] } {
  const threads = sortThreadsByActivity(groupByThread(jobs))
  return {
    running: threads.filter((thread) => thread.newestJob.status === 'running'),
    recent: threads.filter((thread) => thread.newestJob.status !== 'running').slice(0, RECENT_LIMIT),
  }
}

export function secondLine(job: AgentJob): string {
  if (job.status === 'running') return job.activity === '' ? baseName(job.cwd) : job.activity
  return job.diffStat === '' ? '—' : job.diffStat
}

type Card = {
  root: HTMLElement
  glyph: HTMLElement
  elapsed: HTMLElement
  second: HTMLElement
  feed: MiniFeed
  log: HTMLElement | null
  logButton: HTMLButtonElement | null
  stream: EventSource | null
  live: boolean
  thread: AgentThread
}

const cards = new Map<string, Card>()
let timer: ReturnType<typeof setTimeout> | undefined
let ticking: ReturnType<typeof setInterval> | undefined

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== '') node.textContent = text
  return node
}

function host(id: string): HTMLElement | null {
  return document.getElementById(id)
}

function closeStream(card: Card): void {
  card.stream?.close()
  card.stream = null
}

function toggleLog(card: Card): void {
  if (card.log === null || card.logButton === null) return
  const open = card.log.hidden
  card.log.hidden = !open
  card.logButton.textContent = open ? 'LOG ▴' : 'LOG ▾'
  if (!open) {
    closeStream(card)
    return
  }
  card.log.textContent = ''
  const log = card.log
  card.stream = streamJobLog(
    card.thread.newestJob.id,
    (line) => {
      log.textContent += `${line}\n`
      log.scrollTop = log.scrollHeight
    },
    () => {
      log.textContent += '[stream closed]\n'
    },
  )
}

function show(card: Card): void {
  const job = card.thread.newestJob
  openDrawer({
    id: card.thread.threadRoot,
    label: job.label,
    engine: job.engine,
    elapsed: jobElapsed(job, Date.now()),
  })
}

function buildCard(thread: AgentThread, now: number): Card {
  const live = thread.runningJob !== null
  const job = thread.newestJob
  const root = el('div', 'arec')
  root.dataset.thread = thread.threadRoot

  const glyph = el('i', `glyph ${job.status}`, statusGlyph(job.status))
  const elapsed = el('span', 'ael', jobElapsed(job, now))
  const line = el('div', 'r1')
  line.append(
    glyph,
    el('b', 'aname', job.label),
    el('span', `tag ${engineClass(job.engine)}`, job.engine.toUpperCase()),
    elapsed,
  )

  const second = el('div', 'r2', secondLine(job))
  const talkButton = el('button', 'btn xs', 'TALK ▾') as HTMLButtonElement
  talkButton.type = 'button'
  const actions = el('div', 'aacts')
  actions.appendChild(talkButton)

  const logButton = live ? (el('button', 'btn xs', 'LOG ▾') as HTMLButtonElement) : null
  const killButton = live ? (el('button', 'btn xs', 'KILL') as HTMLButtonElement) : null
  const log = live ? el('pre', 'alog') : null
  if (logButton !== null && killButton !== null && log !== null) {
    logButton.type = 'button'
    killButton.type = 'button'
    log.hidden = true
    actions.append(logButton, killButton)
  }

  const feed = createMiniFeed(thread.threadRoot, {
    onOpen: () => show(card),
    pollMs: () => (isDrawerOpen(thread.threadRoot) ? DRAWER_POLL_MS : CARD_POLL_MS),
  })

  root.append(line, second, feed.root, actions)
  if (log !== null) root.appendChild(log)

  const card: Card = {
    root,
    glyph,
    elapsed,
    second,
    feed,
    log,
    logButton,
    stream: null,
    live,
    thread,
  }
  talkButton.onclick = () => show(card)
  if (logButton !== null) logButton.onclick = () => toggleLog(card)
  if (killButton !== null) {
    killButton.onclick = () => {
      const target = card.thread.runningJob
      if (target !== null) void killJob(target.id)
    }
  }
  feed.start()
  return card
}

function dropCard(threadRoot: string, card: Card): void {
  closeStream(card)
  card.feed.stop()
  card.root.remove()
  cards.delete(threadRoot)
}

function syncCard(card: Card, thread: AgentThread, now: number): void {
  card.thread = thread
  card.elapsed.textContent = jobElapsed(thread.newestJob, now)
  card.second.textContent = secondLine(thread.newestJob)
}

function renderGroup(targetId: string, threads: AgentThread[], now: number): void {
  const target = host(targetId)
  if (target === null) return
  for (const thread of threads) {
    const existing = cards.get(thread.threadRoot)
    if (existing !== undefined && existing.live !== (thread.runningJob !== null)) {
      dropCard(thread.threadRoot, existing)
    }
    let card = cards.get(thread.threadRoot)
    if (card === undefined) {
      card = buildCard(thread, now)
      cards.set(thread.threadRoot, card)
    }
    syncCard(card, thread, now)
    target.appendChild(card.root)
  }
}

async function killJob(id: string): Promise<void> {
  await postJson(`/api/jobs/${id}/kill`, {})
  await refresh()
}

let recentOpen = false

function syncRecentToggle(count: number): void {
  const toggle = host('agents-recent-toggle')
  const list = host('agents-recent')
  if (toggle === null || list === null) return
  toggle.hidden = count === 0
  toggle.textContent = `RECENT ${count} ${recentOpen ? '▾' : '▸'}`
  list.hidden = !recentOpen || count === 0
  if (toggle.dataset.wired !== '1') {
    toggle.dataset.wired = '1'
    toggle.addEventListener('click', () => {
      recentOpen = !recentOpen
      syncRecentToggle(count)
    })
  }
}

function markEmpty(empty: boolean): void {
  const box = host('agents-empty')
  if (box !== null) box.hidden = !empty
}

let scopeId: string | null = null
let scopeCwd: string | null = null
let scopeAll = false

export function jobInScope(job: AgentJob, id: string | null, cwd: string | null): boolean {
  if (id === null && cwd === null) return true
  if (job.terminalId !== '') return job.terminalId === id
  if (cwd === null) return false
  return job.cwd === cwd || job.cwd.startsWith(`${cwd}/`)
}

function syncScopeLabel(): void {
  const label = host('agents-scope')
  if (label === null) return
  const scoped = scopeId !== null || scopeCwd !== null
  label.hidden = !scoped
  if (!scoped) return
  const name = scopeCwd === null ? 'THIS TERMINAL' : baseName(scopeCwd).toUpperCase()
  label.textContent = scopeAll ? 'ALL AGENTS · show attached only' : `${name} ONLY · show all`
}

async function refresh(): Promise<void> {
  const now = Date.now()
  const result = await getJson('/api/jobs')
  const all = result.ok ? readArray(result.data.jobs).map(toAgentJob) : []
  const jobs = scopeAll ? all : all.filter((job) => jobInScope(job, scopeId, scopeCwd))
  const groups = splitAgents(jobs)
  const seen = new Set([...groups.running, ...groups.recent].map((thread) => thread.threadRoot))
  for (const [threadRoot, card] of cards) {
    if (!seen.has(threadRoot)) dropCard(threadRoot, card)
  }
  renderGroup('agents-running', groups.running, now)
  renderGroup('agents-recent', groups.recent, now)
  syncRecentToggle(groups.recent.length)
  markEmpty(groups.running.length === 0)
  syncScopeLabel()
  schedule(result.ok ? POLL_MS : ABSENT_POLL_MS)
}

function schedule(delay: number): void {
  clearTimeout(timer)
  timer = setTimeout(() => void cycle(), delay)
}

async function cycle(): Promise<void> {
  if (document.visibilityState === 'hidden') {
    schedule(POLL_MS)
    return
  }
  await refresh()
}

function updateElapsed(): void {
  const now = Date.now()
  for (const card of cards.values()) card.elapsed.textContent = jobElapsed(card.thread.newestJob, now)
}

export function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(AGENTS_STORE_KEY) !== '0'
  } catch {
    return true
  }
}

export function writePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(AGENTS_STORE_KEY, open ? '1' : '0')
  } catch {
    // a blocked storage write must not take the panel down with it
  }
}

function applyPanelOpen(open: boolean): void {
  host('termgrid')?.classList.toggle('agents-off', !open)
  const toggle = host('agents-toggle')
  if (toggle !== null) toggle.textContent = open ? 'AGENTS ◂' : '▸'
  dispatchEvent(new Event('resize'))
}

export function installAgents(): void {
  if (host('agents-panel') === null) return
  installDrawer()
  applyPanelOpen(readPanelOpen())
  addEventListener('mc:terminal-scope', (event) => {
    const detail = (event as CustomEvent<{ id: string | null; cwd: string | null }>).detail
    scopeId = detail.id
    scopeCwd = detail.cwd
    void refresh()
  })
  host('agents-scope')?.addEventListener('click', () => {
    scopeAll = !scopeAll
    void refresh()
  })
  host('agents-toggle')?.addEventListener('click', () => {
    const open = !readPanelOpen()
    writePanelOpen(open)
    applyPanelOpen(open)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh()
  })
  clearInterval(ticking)
  ticking = setInterval(updateElapsed, ELAPSED_TICK_MS)
  void refresh()
}

if (typeof document !== 'undefined') installAgents()
