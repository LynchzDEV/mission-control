import {
  anime,
  getJson,
  markFixture,
  readArray,
  readNumber,
  readRecord,
  text,
  type JsonRecord,
} from './shared'

type Counter = { v: number }

type Stage = [string, string]

type Job = {
  id: string
  engine: string
  label: string
  cwd: string
  status: string
  startedAt: number | null
  endedAt: number | null
}

type Terminal = { engine: string; title: string; cwd: string; createdAt: number | null }

const FIXTURE = { claudeMTok: 1.84, claudeBlockPct: 88, glmPct: 41 }

const STATION_DOTS = ['spec', 'impl', 'verify', 'merged'] as const
const GLM_SLOT_LIMIT = 50
const DONE_WINDOW_MS = 8 * 60 * 60 * 1000
const REFRESH_MS = 5_000

let SESSIONS: Record<string, Record<string, Stage>> = {}

function rollTo(id: string, value: number, digits: number, duration = 1100): void {
  const el = document.getElementById(id)
  if (el === null) return
  const A = anime()
  if (A === null) {
    el.textContent = value.toFixed(digits)
    return
  }
  const counter: Counter = { v: 0 }
  A.animate(counter, {
    v: value,
    duration,
    ease: 'outExpo',
    onUpdate: () => (el.textContent = counter.v.toFixed(digits)),
  })
}

function fillTo(id: string, percent: number, delay: number): void {
  const el = document.getElementById(id)
  if (el === null) return
  const width = `${Math.max(0, Math.min(100, percent))}%`
  const A = anime()
  if (A === null) {
    el.style.width = width
    return
  }
  A.animate(`#${id}`, { width, duration: 1000, delay, ease: 'outExpo' })
}

function entrance(): void {
  const A = anime()
  if (A === null) {
    document.querySelectorAll<HTMLElement>('.rack, .task').forEach((el) => (el.style.opacity = '1'))
    return
  }
  A.animate('.rack', {
    opacity: [0, 1],
    translateY: [16, 0],
    delay: A.stagger(120),
    duration: 600,
    ease: 'outExpo',
  })
}

function paintFixture(): void {
  rollTo('n1', FIXTURE.claudeMTok, 2)
  rollTo('n2', FIXTURE.glmPct, 0)
  fillTo('b1', FIXTURE.claudeBlockPct, 250)
  fillTo('b2', FIXTURE.glmPct, 350)
}

function paintClaude(claude: JsonRecord): void {
  const tokens = readNumber(claude.tokens)
  const percent = readNumber(claude.blockPercent)
  rollTo('n1', tokens === null ? FIXTURE.claudeMTok : tokens / 1_000_000, 2)
  text('#n1pct', percent === null ? '—' : String(Math.round(percent)))
  fillTo('b1', percent ?? 0, 250)
  if (claude.available === false) text('#k-claude-auth', 'NO DATA')
}

function paintGlm(glm: JsonRecord, peak: JsonRecord): void {
  const percent = readNumber(glm.fiveHourPct) ?? readNumber(glm.percent) ?? readNumber(glm.usedPercent)
  rollTo('n2', percent ?? FIXTURE.glmPct, 0)
  fillTo('b2', percent ?? FIXTURE.glmPct, 350)
  const minutes = readNumber(peak.minutesToChange)
  const label = peak.peak === true ? 'PEAK x2' : 'OFF-PEAK'
  text('#n2peak', minutes === null ? label : `${label} ${minutes}m`)
}

function paintCodex(codex: JsonRecord): void {
  const authed = codex.authed === true
  text('#n3', authed ? 'AUTH OK' : 'AUTH FAIL')
  text('#n3sub', authed ? 'codex login status → 0' : 'login status → exit 1')
  const big = document.getElementById('n3')
  if (big !== null) big.className = authed ? 'big c-white sm' : 'big c-red sm'
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function toJob(raw: JsonRecord): Job {
  return {
    id: str(raw.id, '?'),
    engine: str(raw.engine, '?'),
    label: str(raw.label, str(raw.id, 'job')),
    cwd: str(raw.cwd),
    status: str(raw.status, 'unknown'),
    startedAt: readNumber(raw.startedAt),
    endedAt: readNumber(raw.endedAt),
  }
}

function toTerminal(raw: JsonRecord): Terminal {
  return {
    engine: str(raw.engine, '?'),
    title: str(raw.title, 'TERMINAL'),
    cwd: str(raw.cwd),
    createdAt: readNumber(raw.createdAt),
  }
}

function baseName(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

function minutesSince(from: number | null): string {
  if (from === null) return '—'
  return `${Math.max(0, Math.round((Date.now() - from) / 60_000))}m`
}

function sessionOf(job: Job): string {
  return job.label.trim() === '' ? job.id : job.label.trim()
}

function dotsFor(session: string): string[] {
  const stages = SESSIONS[session]
  if (stages === undefined) return ['', '', '', '']
  return STATION_DOTS.map((stage) => {
    const state = stages[stage]?.[0] ?? 'future'
    if (state === 'done') return 'done'
    return state === 'active' ? 'cur' : ''
  })
}

function taskRow(session: string, name: string, right: string, note: string, rightClass = ''): HTMLElement {
  const task = document.createElement('div')
  task.className = 'task'
  task.dataset.s = session
  task.style.opacity = '1'

  const head = document.createElement('div')
  head.className = 't1'
  const title = document.createElement('b')
  title.textContent = name
  const badge = document.createElement('span')
  badge.textContent = right
  if (rightClass !== '') badge.className = rightClass
  head.append(title, badge)

  const body = document.createElement('div')
  body.className = 't2'
  const dots = document.createElement('div')
  dots.className = 'stg'
  for (const state of dotsFor(session)) {
    const dot = document.createElement('i')
    if (state !== '') dot.className = state
    dots.appendChild(dot)
  }
  body.append(dots, note)

  task.append(head, body)
  return task
}

const STAGE_LABEL: Record<string, string> = { claude: 'IMPL', glm: 'IMPL', codex: 'X-REVIEW' }

function renderStation(engine: string, jobs: Job[], terminals: Terminal[]): void {
  const station = document.getElementById(`station-${engine}`)
  if (station === null) return
  station.querySelectorAll('.task').forEach((row) => row.remove())

  const running = jobs.filter((job) => job.engine === engine && job.status === 'running')
  for (const job of running) {
    const session = sessionOf(job)
    station.appendChild(
      taskRow(
        session,
        session,
        `${STAGE_LABEL[engine] ?? 'RUN'} · ${minutesSince(job.startedAt)}`,
        `wt: ${baseName(job.cwd)}`,
      ),
    )
  }

  for (const terminal of terminals.filter((entry) => entry.engine === engine)) {
    station.appendChild(
      taskRow('', terminal.title, `PTY · ${minutesSince(terminal.createdAt)}`, `cwd: ${baseName(terminal.cwd)}`),
    )
  }

  if (station.querySelector('.task') === null) {
    const idle = document.createElement('div')
    idle.className = 'task'
    idle.style.opacity = '1'
    const head = document.createElement('div')
    head.className = 't1'
    const title = document.createElement('b')
    title.textContent = 'IDLE'
    head.appendChild(title)
    idle.appendChild(head)
    station.appendChild(idle)
  }
}

function paintCounters(jobs: Job[], terminals: Terminal[], external: number): void {
  const runningAt = (engine: string): Job[] =>
    jobs.filter((job) => job.engine === engine && job.status === 'running')
  const ptyAt = (engine: string): number => terminals.filter((entry) => entry.engine === engine).length

  text('#k-claude-live', `${runningAt('claude').length} / ${ptyAt('claude')} / ${external}`)

  const glmRunning = runningAt('glm')
  const worktrees = new Set(glmRunning.map((job) => baseName(job.cwd))).size
  text('#k-glm-slots', `${glmRunning.length}/${GLM_SLOT_LIMIT} · ${worktrees}`)

  const since = Date.now() - DONE_WINDOW_MS
  const doneRecently = jobs.filter(
    (job) => job.engine === 'glm' && job.status === 'done' && (job.endedAt ?? 0) >= since,
  ).length
  text('#k-glm-done', String(doneRecently))

  const blocked = Object.values(SESSIONS).filter((stages) => {
    const state = stages.codex?.[0]
    return state === 'queued' || state === 'error'
  }).length
  text('#k-codex-blocked', String(blocked))
  text('#k-codex-pty', `NONE · ${ptyAt('codex')}`)
}

async function loadSessions(): Promise<void> {
  const flow = await getJson('/api/flow')
  if (!flow.ok) return
  const record = readRecord(flow.data.sessions)
  const parsed: Record<string, Record<string, Stage>> = {}
  for (const [key, value] of Object.entries(record)) {
    const stages = readRecord(value)
    const session: Record<string, Stage> = {}
    for (const [stage, pair] of Object.entries(stages)) {
      if (Array.isArray(pair) && typeof pair[0] === 'string') {
        session[stage] = [pair[0], typeof pair[1] === 'string' ? pair[1] : '']
      }
    }
    parsed[key] = session
  }
  SESSIONS = parsed
}

async function externalCount(): Promise<number> {
  const external = await getJson('/api/sessions/external')
  if (!external.ok) return 0
  return readArray(external.data.sessions ?? external.data).length
}

async function paintStations(): Promise<void> {
  const [jobsResult, terminalsResult, external] = await Promise.all([
    getJson('/api/jobs'),
    getJson('/api/terminals'),
    externalCount(),
  ])
  const jobs = jobsResult.ok ? readArray(jobsResult.data.jobs).map(toJob) : []
  const terminals = terminalsResult.ok ? readArray(terminalsResult.data.sessions).map(toTerminal) : []

  await loadSessions()
  for (const engine of ['claude', 'glm', 'codex']) renderStation(engine, jobs, terminals)
  paintCounters(jobs, terminals, external)
}

async function paintMeta(): Promise<void> {
  const meta = await getJson('/api/meta')
  if (!meta.ok) {
    markFixture('meta', true)
    return
  }
  markFixture('meta', false)

  const clock = readRecord(meta.data.blockClock)
  const elapsed = typeof clock.elapsed === 'string' ? clock.elapsed : '—:—'
  const total = typeof clock.total === 'string' ? clock.total : '5:00'
  text('#block-clock', `${elapsed} / ${total} BLOCK`)

  const perMin = readNumber(meta.data.tokPerMin)
  if (perMin === null) text('#tpm', '—')
  else rollTo('tpm', perMin / 1000, 1, 900)

  const reviews = readNumber(meta.data.reviewCount) ?? 0
  text('#review-count', `${reviews} DIFFS TO REVIEW`)
}

async function hydrate(): Promise<void> {
  const quota = await getJson('/api/quota')
  if (!quota.ok) {
    markFixture('quota', true)
    paintFixture()
    return
  }
  markFixture('quota', false)
  paintClaude(readRecord(quota.data.claude))
  paintGlm(readRecord(quota.data.glm), readRecord(quota.data.peak))
  paintCodex(readRecord(quota.data.codex))
}

export function installLanes(): void {
  if (document.querySelector('.racks') === null) return
  entrance()
  void hydrate()
  void paintMeta()
  void paintStations()
  setInterval(() => {
    void paintMeta()
    void paintStations()
  }, REFRESH_MS)
}

installLanes()
