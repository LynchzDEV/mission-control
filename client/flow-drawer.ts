import type { QuickJobView, RunAttemptView, RunView, ScopeSnapshot } from '../server/run-view'
import { confirmButton } from './confirm-button'
import { renderRunGraph, type EdgeState, type GraphEdge, type GraphStep, type StepState } from './flow-graph'
import { rollText } from './morph'
import { errorText, postJson, providerName } from './shared'

type RunAction = 'approve' | 'reject' | 'retry' | 'stop' | 'pause' | 'resume'
type Banner = { tone: 'ask' | 'problem' | null; text: string; actions: ('approve' | 'reject' | 'retry' | 'stop')[] }
type StepStatus = { state: StepState; detail: string; since?: number }

const LIVE = new Set(['awaiting-approval', 'running', 'paused'])
const SUMMARY_CHARS = 60
const TICK_MS = 1000
const EMPTY_TITLE = 'Session flow'

const isLive = (run: RunView): boolean => LIVE.has(run.status)
const pad = (value: number): string => String(value).padStart(2, '0')
const inOrder = (run: RunView): RunAttemptView[] => [...run.attempts].sort((a, b) => a.number - b.number)

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

function reachableByPass(run: RunView): Set<string> {
  const seen = new Set([run.entry])
  const queue = [run.entry]
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of run.edges) {
      if (edge.source !== id || edge.outcome !== 'pass' || seen.has(edge.target)) continue
      seen.add(edge.target)
      queue.push(edge.target)
    }
  }
  return seen
}

function titleOf(run: RunView, id: string): string {
  return run.nodes.find(node => node.id === id)?.title ?? id
}

function unstartedStatus(run: RunView, nodeId: string, engine: string, reachable: Set<string>): StepStatus {
  const onFailure = run.edges.find(edge => edge.target === nodeId && edge.outcome !== 'pass')
  if (!reachable.has(nodeId) && onFailure) return { state: 'conditional', detail: `If ${titleOf(run, onFailure.source)} fails` }
  if (run.status === 'awaiting-approval') return { state: 'pending', detail: providerName(engine) }
  if (isLive(run) && nodeId === run.currentNodeId) return { state: 'pending', detail: run.status === 'paused' ? 'Paused here' : 'Up next' }
  const currentBusy = run.attempts.some(attempt => attempt.nodeId === run.currentNodeId && attempt.status !== 'settled')
  const upNext = isLive(run) && currentBusy && run.edges.some(edge => edge.source === run.currentNodeId && edge.target === nodeId && edge.outcome === 'pass')
  return { state: 'pending', detail: upNext ? 'Up next' : 'Waiting' }
}

function attemptStatus(run: RunView, tries: RunAttemptView[], now: number): StepStatus {
  const latest = tries.at(-1)!
  const retry = tries.length > 1 ? `Try ${tries.length} · ` : ''
  if (latest.status !== 'settled') {
    if (!isLive(run)) return { state: 'failed', detail: run.status === 'stopped' ? 'Stopped' : 'Did not finish' }
    return { state: 'active', detail: `${tries.length > 1 ? `Try ${tries.length}` : 'Working'} · ${elapsed(now - latest.startedAt)}`, since: latest.startedAt }
  }
  if (latest.outcome === 'pass') return { state: 'done', detail: `${retry}Done · ${elapsed((latest.endedAt ?? now) - latest.startedAt)}` }
  const summary = (latest.summary ?? '').slice(0, SUMMARY_CHARS)
  return { state: 'failed', detail: [latest.outcome === 'blocked' ? 'Blocked' : 'Failed', summary].filter(Boolean).join(' · ') }
}

export function stepsFor(run: RunView, now: number): GraphStep[] {
  const reachable = reachableByPass(run)
  const attempts = inOrder(run)
  return run.nodes.map(node => {
    const tries = attempts.filter(attempt => attempt.nodeId === node.id)
    const status = tries.length ? attemptStatus(run, tries, now) : unstartedStatus(run, node.id, node.engine, reachable)
    return { id: node.id, title: node.title, engine: node.engine, kind: node.kind, ...status }
  })
}

function takenPairs(run: RunView, edge: RunView['edges'][number]): [RunAttemptView, RunAttemptView][] {
  const attempts = inOrder(run)
  return attempts.slice(1).flatMap((next, index): [RunAttemptView, RunAttemptView][] => {
    const previous = attempts[index]!
    const matches = previous.nodeId === edge.source && previous.status === 'settled' && previous.outcome === edge.outcome && next.nodeId === edge.target
    return matches ? [[previous, next]] : []
  })
}

function edgeState(run: RunView, edge: RunView['edges'][number]): EdgeState {
  const pairs = takenPairs(run, edge)
  if (!pairs.length) return 'idle'
  if (edge.outcome !== 'pass') return 'failed'
  return pairs.at(-1)![1].status !== 'settled' && isLive(run) ? 'flowing' : 'done'
}

export function edgesFor(run: RunView): GraphEdge[] {
  return run.edges.map(edge => {
    const state = edgeState(run, edge)
    if (edge.outcome === 'pass') return { ...edge, state }
    const source = titleOf(run, edge.source)
    return { ...edge, state, label: state === 'idle' ? `if ${source} fails` : `${source} failed · retried` }
  })
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function approvalPhrase(run: RunView): string {
  if (run.versions.some(version => version.state === 'pending')) return 'waiting for your approval'
  const version = run.versions.filter(item => item.approvedVia !== null || item.state === 'rejected').at(-1)
  if (!version) return ''
  if (version.state === 'rejected') return `rejected, ${clock(version.at)}`
  if (version.approvedVia === 'user') return 'started by you'
  if (version.approvedVia === 'drawer') return `approved by you in the drawer, ${clock(version.at)}`
  if (version.approvedVia === 'conversation') return `approved in the conversation (relayed by ${providerName(version.relayedBy ?? run.origin.by)}), ${clock(version.at)}`
  return 'started on its own (approval is off)'
}

export function metaFor(run: RunView): string {
  const by = providerName(run.origin.by)
  const picked = run.origin.where === 'studio' ? 'started from Studio' : `picked by ${by} in ${run.origin.where}`
  const origin = run.origin.source === 'drafted' ? `New flow drafted by ${by} in ${run.origin.where}` : `Saved workflow ${run.workflowName} · ${picked}`
  return [origin, approvalPhrase(run)].filter(Boolean).join(' · ')
}

export function pillsFor(run: RunView): { running: number; done: number; waiting: number } {
  const states = stepsFor(run, Date.now()).map(step => step.state)
  const count = (...wanted: StepState[]): number => states.filter(state => wanted.includes(state)).length
  return { running: count('active'), done: count('done'), waiting: count('pending', 'conditional') }
}

export function bannerFor(run: RunView): Banner {
  const by = providerName(run.origin.by)
  if (run.status === 'awaiting-approval' && run.versions.some(version => version.state === 'pending')) {
    return { tone: 'ask', text: `${by} picked "${run.workflowName}" for this task. Nothing runs until you approve, or say "go" to ${by}.`, actions: ['reject', 'approve'] }
  }
  if (run.status === 'blocked' || run.status === 'failed') {
    const word = run.status === 'blocked' ? 'Blocked' : 'Failed'
    return { tone: 'problem', text: run.error ? `${word}: ${run.error}` : word, actions: ['retry'] }
  }
  return { tone: null, text: '', actions: [] }
}

export function pickRun(runs: RunView[], pinned: string | null): RunView | null {
  const kept = runs.find(run => run.id === pinned)
  if (kept) return kept
  const newestFirst = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  return newestFirst.find(isLive) ?? newestFirst[0] ?? null
}

function motionAllowed(): boolean {
  try { return localStorage.getItem('mc.motion.paused') !== 'true' } catch { return true }
}

function mountFlowDrawer(): void {
  const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
  const title = $('flow-title'), meta = $('flow-meta'), pills = $('flow-pills'), runsSelect = $('flow-runs') as HTMLSelectElement
  const pause = $('flow-pause') as HTMLButtonElement, stop = $('flow-stop') as HTMLButtonElement
  const banner = $('flow-banner'), stage = $('flow-stage'), quick = $('flow-quick'), quickList = $('flow-quick-list'), empty = $('flow-empty')
  let scopeQuery: string | null = null
  let open = false
  let source: EventSource | null = null
  let ticker: ReturnType<typeof setInterval> | undefined
  let snapshot: ScopeSnapshot = { runs: [], jobs: [] }
  let selected: string | null = null
  let current: RunView | null = null
  let bannerKey = ''

  const make = (tag: string, text = '', className = ''): HTMLElement => {
    const element = document.createElement(tag)
    element.textContent = text
    if (className) element.className = className
    return element
  }
  const logo = (engine: string, className: string): HTMLImageElement => {
    const image = document.createElement('img')
    if (className) image.className = className
    image.src = `/providers/${engine}.svg`
    image.alt = ''
    return image
  }
  const mark = (state: string): HTMLElement => {
    const span = make('span', '', 'flow-mark')
    span.dataset.state = state
    return span
  }

  async function act(action: RunAction, runId: string | undefined): Promise<void> {
    const target = snapshot.runs.find(run => run.id === runId)
    if (!target) return
    const pending = target.versions.find(version => version.state === 'pending')
    const body = (action === 'approve' || action === 'reject') && pending ? { version: pending.number } : {}
    const result = await postJson(`/api/studio/runs/${encodeURIComponent(target.id)}/${action}`, body)
    if (result.ok) return
    if (banner.hidden) { banner.className = 'flow-banner problem'; banner.querySelector<HTMLElement>('.flow-mark')!.dataset.state = 'failed'; banner.hidden = false }
    rollText(banner.querySelector('p') as HTMLElement, `Could not ${action}: ${errorText(result)}`)
  }

  function actionButton(action: Banner['actions'][number], runId: string | undefined): HTMLButtonElement {
    const button = make('button', '', 'pill flow-sm') as HTMLButtonElement
    button.type = 'button'
    if (action === 'approve') { button.classList.add('flow-primary'); button.textContent = 'Approve and run'; button.onclick = () => void act('approve', runId); return button }
    if (action === 'retry') { button.textContent = 'Retry step'; button.onclick = () => void act('retry', runId); return button }
    const [idle, armed] = action === 'reject' ? ['Reject', 'Reject flow'] : ['Stop', 'Stop flow']
    button.classList.add('flow-ghost', 'flow-confirm')
    button.setAttribute('aria-label', idle)
    button.dataset.action = action
    button.append(make('span', idle), make('span', armed))
    return button
  }

  function paintBanner(run: RunView | null): void {
    const next = run ? bannerFor(run) : { tone: null, text: '', actions: [] }
    const key = JSON.stringify([run?.id, next])
    if (key === bannerKey) return
    bannerKey = key
    banner.hidden = !next.tone
    banner.className = next.tone ? `flow-banner ${next.tone}` : 'flow-banner'
    banner.querySelector<HTMLElement>('.flow-mark')!.dataset.state = next.tone === 'problem' ? 'failed' : 'active'
    ;(banner.querySelector('p') as HTMLElement).textContent = next.text
    const actions = banner.querySelector('.flow-banner-actions') as HTMLElement
    actions.replaceChildren(...next.actions.map(action => actionButton(action, run?.id)))
    actions.querySelectorAll<HTMLButtonElement>('.flow-confirm').forEach(button => confirmButton(button, button.lastElementChild!.textContent ?? '', () => void act(button.dataset.action as RunAction, run?.id)))
  }

  function paintHeader(run: RunView | null, heading: string): void {
    rollText(title, heading)
    runsSelect.hidden = snapshot.runs.length < 2 || !run
    title.hidden = !runsSelect.hidden
    if (!runsSelect.hidden) {
      runsSelect.replaceChildren(...snapshot.runs.map(item => new Option(`${item.label} · ${item.status}`, item.id)))
      runsSelect.value = run!.id
    }
    const counts = run ? pillsFor(run) : { running: 0, done: 0, waiting: 0 }
    pills.replaceChildren(...([['running', counts.running, 'running'], ['done', counts.done, 'done'], ['queued', counts.waiting, 'waiting']] as const)
      .filter(([, count]) => count > 0)
      .map(([state, count, word]) => { const pill = make('span', `${count} ${word}`, 'pill-state'); pill.dataset.s = state; return pill }))
    pause.hidden = run?.status !== 'running' && run?.status !== 'paused'
    pause.textContent = run?.status === 'paused' ? 'Resume' : 'Pause'
    stop.hidden = !run || !isLive(run)
  }

  function quickRow(job: QuickJobView, now: number): HTMLElement {
    const state = job.status === 'done' ? 'done' : job.status === 'running' ? 'active' : 'failed'
    const row = make('li')
    row.dataset.state = state
    const time = make('small', quickTime(job, now))
    if (job.status === 'running') time.dataset.since = String(job.startedAt)
    row.append(mark(state), logo(job.engine, 'flow-step-logo'), make('strong', job.label), time)
    return row
  }

  function quickTime(job: QuickJobView, now: number): string {
    const word = job.status === 'done' ? 'Finished' : job.status === 'running' ? 'Working' : job.status.charAt(0).toUpperCase() + job.status.slice(1)
    return `${word} · ${elapsed((job.endedAt ?? now) - job.startedAt)}`
  }

  function paint(): void {
    const run = pickRun(snapshot.runs, selected)
    current = run
    stage.hidden = !run
    quick.hidden = !!run || !snapshot.jobs.length
    empty.hidden = !!run || !!snapshot.jobs.length
    paintBanner(run)
    if (run) {
      paintHeader(run, run.label)
      meta.replaceChildren(...(run.origin.by === 'you' ? [] : [logo(run.origin.by, '')]), metaFor(run))
      renderRunGraph(stage, stepsFor(run, Date.now()), edgesFor(run), run.entry, { animate: motionAllowed() })
      return
    }
    const newest = snapshot.jobs[0]
    paintHeader(null, newest?.label ?? EMPTY_TITLE)
    meta.replaceChildren(newest ? 'Quick work · no flow needed' : '')
    const now = Date.now()
    quickList.replaceChildren(...snapshot.jobs.map(job => quickRow(job, now)))
  }

  function tick(): void {
    if (document.hidden) return
    const now = Date.now()
    if (current) {
      const steps = stepsFor(current, now)
      stage.querySelectorAll<HTMLElement>('.flow-step').forEach((card, index) => {
        const detail = card.querySelector<HTMLElement>('small[data-since]')
        if (detail && steps[index]) detail.textContent = steps[index].detail
      })
      return
    }
    quickList.querySelectorAll<HTMLElement>('small[data-since]').forEach(time => { time.textContent = `Working · ${elapsed(now - Number(time.dataset.since))}` })
  }

  function connect(): void {
    source?.close()
    source = null
    clearInterval(ticker)
    ticker = undefined
    if (!open || !scopeQuery) return
    source = new EventSource(`/api/studio/events?${scopeQuery}`)
    source.onmessage = (event: MessageEvent<string>) => { snapshot = JSON.parse(event.data) as ScopeSnapshot; paint() }
    ticker = setInterval(tick, TICK_MS)
  }

  function setScope(next: string | null): void {
    if (next === scopeQuery) return
    scopeQuery = next
    snapshot = { runs: [], jobs: [] }
    selected = null
    paint()
    connect()
  }

  runsSelect.onchange = () => { selected = runsSelect.value; paint() }
  pause.onclick = () => void act(current?.status === 'paused' ? 'resume' : 'pause', current?.id)
  let stopTarget: string | undefined
  stop.addEventListener('click', () => { if (stop.dataset.armed !== 'true') stopTarget = current?.id }, { capture: true })
  confirmButton(stop, 'Stop flow', () => void act('stop', stopTarget))
  addEventListener('quiet:flow-open', (event) => { open = (event as CustomEvent<boolean>).detail; connect() })
  addEventListener('quiet:activity-scope', (event) => { const session = (event as CustomEvent<{ id: string; cwd: string } | null>).detail; setScope(session ? `terminal=${encodeURIComponent(session.id)}` : null) })
  addEventListener('quiet:chat-agents', (event) => { const chat = (event as CustomEvent<string | null>).detail; if (chat) setScope(`chat=${encodeURIComponent(chat)}`) })
  if (document.body.dataset.chat) setScope(`chat=${encodeURIComponent(document.body.dataset.chat)}`)
  else paint()
}

if (typeof document !== 'undefined' && document.getElementById('flow-stage')) mountFlowDrawer()
