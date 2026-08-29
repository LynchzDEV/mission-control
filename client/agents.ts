import { ACTIVITY_GLYPH } from './plan-view'
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

export type TickerLine = { kind: string; title: string; detail: string }

export const RECENT_LIMIT = 8
export const TICKER_ROWS = 5
export const AGENTS_STORE_KEY = 'mc.agents.open'

const POLL_MS = 3_000
const ELAPSED_TICK_MS = 1_000
const ABSENT_POLL_MS = 30_000
const SHORT_ID_CHARS = 8

const ACCENT: Record<string, string> = {
  claude: 'c-claude',
  glm: 'c-glm',
  codex: 'c-white',
}

const STATUS_GLYPH: Record<string, string> = {
  running: '▸',
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

export function accentClass(engine: string): string {
  return ACCENT[engine] ?? 'c-white'
}

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

export function tickerLines(events: JsonRecord[]): TickerLine[] {
  return events
    .slice(-TICKER_ROWS)
    .reverse()
    .map((event) => ({
      kind: str(event.kind, 'text'),
      title: str(event.title),
      detail: str(event.detail),
    }))
}

type CardRefs = {
  root: HTMLElement
  elapsed: HTMLElement
  current: HTMLElement
  ticker: HTMLElement
  log: HTMLElement
  logButton: HTMLButtonElement
  stream: EventSource | null
  job: AgentJob
}

type RecentRefs = {
  root: HTMLElement
  feed: HTMLElement
  loaded: boolean
  job: AgentJob
}

const cards = new Map<string, CardRefs>()
const recents = new Map<string, RecentRefs>()
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

function renderTicker(target: HTMLElement, lines: TickerLine[]): void {
  target.textContent = ''
  for (const line of lines) {
    const row = el('div', `aevent ${line.kind}`)
    row.append(
      el('i', 'glyph', ACTIVITY_GLYPH[line.kind] ?? '·'),
      el('b', 'title', line.title),
      el('span', 'detail', line.detail),
    )
    target.appendChild(row)
  }
}

function closeStream(card: CardRefs): void {
  card.stream?.close()
  card.stream = null
}

function toggleLog(card: CardRefs): void {
  const open = card.log.hidden
  card.log.hidden = !open
  card.logButton.textContent = open ? 'LOG ▴' : 'LOG ▾'
  if (!open) {
    closeStream(card)
    return
  }
  card.log.textContent = ''
  card.stream = streamJobLog(
    card.job.id,
    (line) => {
      card.log.textContent += `${line}\n`
      card.log.scrollTop = card.log.scrollHeight
    },
    () => {
      card.log.textContent += '[stream closed]\n'
    },
  )
}

function buildCard(job: AgentJob): CardRefs {
  const root = el('div', 'agent')
  root.dataset.job = job.id

  const head = el('div', 'a1')
  head.append(
    el('b', 'aname', job.label),
    el('span', `tag ${accentClass(job.engine)}`, job.engine.toUpperCase()),
  )

  const elapsed = el('span', 'ael', '—')
  const meta = el('div', 'a2')
  meta.append(elapsed, el('span', 'acwd', baseName(job.cwd)))

  const current = el('div', 'acur', job.activity)
  const ticker = el('div', 'atick')

  const log = el('pre', 'alog')
  log.hidden = true

  const logButton = el('button', 'btn xs', 'LOG ▾') as HTMLButtonElement
  logButton.type = 'button'
  const killButton = el('button', 'btn xs', 'KILL') as HTMLButtonElement
  killButton.type = 'button'
  const actions = el('div', 'aacts')
  actions.append(logButton, killButton)

  root.append(head, meta, current, ticker, actions, log)

  const card: CardRefs = { root, elapsed, current, ticker, log, logButton, stream: null, job }
  logButton.onclick = () => toggleLog(card)
  killButton.onclick = () => void killJob(card.job.id)
  return card
}

function syncCard(card: CardRefs, job: AgentJob, now: number): void {
  card.job = job
  card.elapsed.textContent = jobElapsed(job, now)
  card.current.textContent = job.activity
}

function renderRunning(jobs: AgentJob[], now: number): void {
  const target = host('agents-running')
  if (target === null) return
  const seen = new Set(jobs.map((job) => job.id))
  for (const [id, card] of cards) {
    if (seen.has(id)) continue
    closeStream(card)
    card.root.remove()
    cards.delete(id)
  }
  for (const job of jobs) {
    let card = cards.get(job.id)
    if (card === undefined) {
      card = buildCard(job)
      cards.set(job.id, card)
    }
    syncCard(card, job, now)
    target.appendChild(card.root)
  }
}

async function toggleRecent(refs: RecentRefs): Promise<void> {
  const open = refs.feed.hidden
  refs.feed.hidden = !open
  if (!open || refs.loaded) return
  refs.loaded = true
  const result = await getJson(`/api/jobs/${refs.job.id}/activity`)
  renderTicker(refs.feed, tickerLines(result.ok ? readArray(result.data.events) : []))
  if (refs.feed.childElementCount === 0) {
    refs.feed.appendChild(el('div', 'aevent', 'NO ACTIVITY RECORDED'))
  }
}

function buildRecent(job: AgentJob, now: number): RecentRefs {
  const root = el('div', 'arec')
  root.dataset.job = job.id

  const line = el('div', 'r1')
  line.append(
    el('i', `glyph ${job.status}`, statusGlyph(job.status)),
    el('b', 'aname', job.label),
    el('span', `tag ${accentClass(job.engine)}`, job.engine.toUpperCase()),
    el('span', 'ael', jobElapsed(job, now)),
  )

  const feed = el('div', 'atick')
  feed.hidden = true
  root.append(line, el('div', 'r2', job.diffStat === '' ? '—' : job.diffStat), feed)

  const refs: RecentRefs = { root, feed, loaded: false, job }
  line.onclick = () => void toggleRecent(refs)
  return refs
}

function renderRecent(jobs: AgentJob[], now: number): void {
  const target = host('agents-recent')
  if (target === null) return
  const seen = new Set(jobs.map((job) => job.id))
  for (const [id, refs] of recents) {
    if (seen.has(id)) continue
    refs.root.remove()
    recents.delete(id)
  }
  for (const job of jobs) {
    let refs = recents.get(job.id)
    if (refs === undefined) {
      refs = buildRecent(job, now)
      recents.set(job.id, refs)
    }
    refs.job = job
    target.appendChild(refs.root)
  }
}

async function killJob(id: string): Promise<void> {
  await postJson(`/api/jobs/${id}/kill`, {})
  await refresh()
}

async function pullTicker(job: AgentJob): Promise<void> {
  const card = cards.get(job.id)
  if (card === undefined) return
  const result = await getJson(`/api/jobs/${job.id}/activity`)
  if (!result.ok) return
  renderTicker(card.ticker, tickerLines(readArray(result.data.events)))
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
  renderRunning(groups.running, now)
  renderRecent(groups.recent, now)
  markEmpty(groups.running.length === 0 && groups.recent.length === 0)
  await Promise.all(groups.running.map(pullTicker))
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
