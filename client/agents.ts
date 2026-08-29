import {
  CARD_POLL_MS,
  DRAWER_POLL_MS,
  createMiniFeed,
  engineClass,
  type MiniFeed,
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
}

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

export function splitAgents(jobs: AgentJob[]): { running: AgentJob[]; recent: AgentJob[] } {
  const newest = [...jobs].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
  return {
    running: newest.filter((job) => job.status === 'running'),
    recent: newest.filter((job) => job.status !== 'running').slice(0, RECENT_LIMIT),
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
  job: AgentJob
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
    card.job.id,
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
  openDrawer({
    id: card.job.id,
    label: card.job.label,
    engine: card.job.engine,
    elapsed: jobElapsed(card.job, Date.now()),
  })
}

function buildCard(job: AgentJob, now: number): Card {
  const live = job.status === 'running'
  const root = el('div', 'arec')
  root.dataset.job = job.id

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

  const feed = createMiniFeed(job.id, {
    onOpen: () => show(card),
    pollMs: () => (isDrawerOpen(job.id) ? DRAWER_POLL_MS : CARD_POLL_MS),
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
    job,
  }
  talkButton.onclick = () => show(card)
  if (logButton !== null) logButton.onclick = () => toggleLog(card)
  if (killButton !== null) killButton.onclick = () => void killJob(card.job.id)
  feed.start()
  return card
}

function dropCard(id: string, card: Card): void {
  closeStream(card)
  card.feed.stop()
  card.root.remove()
  cards.delete(id)
}

function syncCard(card: Card, job: AgentJob, now: number): void {
  card.job = job
  card.elapsed.textContent = jobElapsed(job, now)
  card.second.textContent = secondLine(job)
}

function renderGroup(targetId: string, jobs: AgentJob[], now: number): void {
  const target = host(targetId)
  if (target === null) return
  for (const job of jobs) {
    const existing = cards.get(job.id)
    if (existing !== undefined && existing.live !== (job.status === 'running')) {
      dropCard(job.id, existing)
    }
    let card = cards.get(job.id)
    if (card === undefined) {
      card = buildCard(job, now)
      cards.set(job.id, card)
    }
    syncCard(card, job, now)
    target.appendChild(card.root)
  }
}

async function killJob(id: string): Promise<void> {
  await postJson(`/api/jobs/${id}/kill`, {})
  await refresh()
}

function markEmpty(empty: boolean): void {
  const box = host('agents-empty')
  if (box !== null) box.hidden = !empty
}

async function refresh(): Promise<void> {
  const now = Date.now()
  const result = await getJson('/api/jobs')
  const jobs = result.ok ? readArray(result.data.jobs).map(toAgentJob) : []
  const groups = splitAgents(jobs)
  const seen = new Set([...groups.running, ...groups.recent].map((job) => job.id))
  for (const [id, card] of cards) {
    if (!seen.has(id)) dropCard(id, card)
  }
  renderGroup('agents-running', groups.running, now)
  renderGroup('agents-recent', groups.recent, now)
  markEmpty(groups.running.length === 0 && groups.recent.length === 0)
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
  for (const card of cards.values()) card.elapsed.textContent = jobElapsed(card.job, now)
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
