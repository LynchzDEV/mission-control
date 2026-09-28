import type { QuickJobView, RunAttemptView, RunView, ScopeSnapshot } from '../server/run-view'
import { confirmButton } from './confirm-button'
import { renderRunGraph, type EdgeState, type GraphEdge, type GraphStep, type StepState } from './flow-graph'
import { rollText } from './morph'
import { errorText, postJson, providerName, type ApiResult, type JsonRecord } from './shared'

type RunAction = 'approve' | 'reject' | 'retry' | 'stop' | 'pause' | 'resume'
type BannerAction = 'approve' | 'reject' | 'retry' | 'stop' | 'keep' | 'approval-on'
type Banner = { tone: 'ask' | 'problem' | 'notice' | null; text: string; actions: BannerAction[] }
type Edge = RunView['edges'][number]
type StepStatus = { state: StepState; detail: string; since?: number }

const LIVE = new Set(['awaiting-approval', 'running', 'paused'])
const SUMMARY_CHARS = 60
const TICK_MS = 1000
const EMPTY_TITLE = 'Session flow'
const NO_BANNER: Banner = { tone: null, text: '', actions: [] }

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
  return [...run.nodes, ...(run.proposal?.nodes ?? [])].find(node => node.id === id)?.title ?? id
}

const sameEdge = (a: Edge, b: Edge): boolean => a.source === b.source && a.target === b.target && a.outcome === b.outcome

export function activeVersion(run: RunView): number {
  return run.versions.filter(version => version.state === 'approved').at(-1)?.number ?? 1
}

function routedTarget(run: RunView, token: RunView['tokens'][number]): string {
  const ran = run.attempts.filter(attempt => attempt.nodeId === token.nodeId && (attempt.pathId ?? 'main') === token.pathId && attempt.status === 'settled').at(-1)
  return run.edges.find(edge => edge.source === token.nodeId && edge.outcome === ran?.outcome)?.target ?? token.nodeId
}

function nextUp(run: RunView): Set<string> {
  const ids = new Set<string>()
  for (const token of run.tokens) {
    if (token.state === 'ready') ids.add(token.nodeId)
    if (token.state === 'settled') { ids.add(token.nodeId); ids.add(routedTarget(run, token)) }
  }
  return ids
}

function afterWorking(run: RunView, nodeId: string): boolean {
  const working = new Set(run.tokens.filter(token => token.state === 'working').map(token => token.nodeId))
  return run.edges.some(edge => working.has(edge.source) && edge.target === nodeId && edge.outcome === 'pass')
}

function unstartedStatus(run: RunView, nodeId: string, engine: string, reachable: Set<string>): StepStatus {
  const onFailure = run.edges.find(edge => edge.target === nodeId && edge.outcome !== 'pass')
  if (!reachable.has(nodeId) && onFailure) return { state: 'conditional', detail: `If ${titleOf(run, onFailure.source)} fails` }
  if (run.status === 'awaiting-approval') return { state: 'pending', detail: providerName(engine) }
  if (isLive(run) && nextUp(run).has(nodeId)) return { state: 'pending', detail: run.status === 'paused' ? 'Paused here' : 'Up next' }
  return { state: 'pending', detail: isLive(run) && afterWorking(run, nodeId) ? 'Up next' : 'Waiting' }
}

function waitingAtJoin(run: RunView, nodeId: string, tries: RunAttemptView[]): StepStatus | null {
  const section = run.sections.find(open => open.join === nodeId)
  if (!section || !isLive(run) || tries.some(attempt => attempt.status !== 'settled')) return null
  const pathIds = new Set(section.paths.map(path => path.pathId))
  const arrived = new Set(run.tokens.filter(token => token.nodeId === nodeId && token.state === 'waiting' && pathIds.has(token.pathId)).map(token => token.pathId))
  return { state: 'pending', detail: `Waiting for ${section.paths.length - arrived.size} of ${section.paths.length} paths` }
}

function joinedStatus(run: RunView, nodeId: string, status: StepStatus, latest: RunAttemptView): StepStatus {
  if (latest.status !== 'settled') return status
  if (latest.outcome === 'fail') return { ...status, detail: 'Paths could not be joined' }
  if (latest.outcome !== 'pass') return status
  const paths = Number(/^Joined (\d+) paths/.exec(latest.summary ?? '')?.[1] ?? run.edges.filter(edge => edge.target === nodeId && edge.outcome === 'pass').length)
  return { ...status, detail: `Joined ${paths} paths` }
}

function stepStatus(run: RunView, kind: string, nodeId: string, engine: string, tries: RunAttemptView[], reachable: Set<string>, now: number): StepStatus {
  const waiting = kind === 'join' ? waitingAtJoin(run, nodeId, tries) : null
  if (waiting) return waiting
  if (!tries.length) return unstartedStatus(run, nodeId, engine, reachable)
  const status = attemptStatus(run, tries, now)
  return kind === 'join' ? joinedStatus(run, nodeId, status, tries.at(-1)!) : status
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
  const proposal = run.proposal
  const current = run.nodes.map(node => {
    const tries = attempts.filter(attempt => attempt.nodeId === node.id)
    const status = stepStatus(run, node.kind, node.id, node.engine, tries, reachable, now)
    const proposed = proposal?.removed.includes(node.id) ? { state: 'removed' as const, detail: `Removed in v${proposal.number}` }
      : !tries.length && proposal?.changed.includes(node.id) ? { state: status.state, detail: `Changed in v${proposal.number}` }
        : status
    return { id: node.id, title: node.title, engine: node.engine, kind: node.kind, ...proposed }
  })
  const known = new Set(run.nodes.map(node => node.id))
  const ghosts = (run.proposal?.nodes ?? []).filter(node => !known.has(node.id))
    .map(node => ({ id: node.id, title: node.title, engine: node.engine, kind: node.kind, state: 'proposed' as const, detail: 'Proposed' }))
  return [...current, ...ghosts]
}

function sourcesOf(attempts: RunAttemptView[], next: RunAttemptView, index: number): RunAttemptView[] {
  if (!next.from?.length) return index > 0 ? [attempts[index - 1]!] : []
  return attempts.filter(attempt => next.from.includes(attempt.number))
}

function takenPairs(run: RunView, edge: Edge): [RunAttemptView, RunAttemptView][] {
  const attempts = inOrder(run)
  const took = (previous: RunAttemptView) => previous.nodeId === edge.source && previous.status === 'settled' && previous.outcome === edge.outcome
  return attempts.flatMap((next, index): [RunAttemptView, RunAttemptView][] => next.nodeId === edge.target
    ? sourcesOf(attempts, next, index).filter(took).map(previous => [previous, next])
    : [])
}

function reachedJoin(run: RunView, edge: Edge): boolean {
  const arrivals = new Set(run.tokens.filter(token => token.nodeId === edge.target && token.state === 'waiting').flatMap(token => token.from))
  return run.attempts.some(attempt => arrivals.has(attempt.number) && attempt.nodeId === edge.source && attempt.status === 'settled' && attempt.outcome === edge.outcome)
}

function edgeState(run: RunView, edge: Edge): EdgeState {
  const pairs = takenPairs(run, edge)
  if (!pairs.length) return reachedJoin(run, edge) ? (edge.outcome === 'pass' ? 'done' : 'failed') : 'idle'
  if (edge.outcome !== 'pass') return 'failed'
  return pairs.at(-1)![1].status !== 'settled' && isLive(run) ? 'flowing' : 'done'
}

function labelled(run: RunView, edge: Edge, state: EdgeState): GraphEdge {
  if (edge.outcome === 'pass') return { ...edge, state }
  const source = titleOf(run, edge.source)
  return { ...edge, state, label: state === 'failed' ? `${source} failed · retried` : `if ${source} fails` }
}

export function edgesFor(run: RunView): GraphEdge[] {
  const proposed = run.proposal?.edges
  const current = run.edges.map(edge => labelled(run, edge, edgeState(run, edge)))
  const added = (proposed ?? []).filter(edge => !run.edges.some(other => sameEdge(other, edge))).map(edge => labelled(run, edge, 'proposed'))
  return [...current, ...added]
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function startPhrase(run: RunView): string {
  const version = run.versions[0]
  if (!version || version.state === 'pending') return ''
  if (version.state === 'rejected') return `rejected, ${clock(version.at)}`
  if (version.approvedVia === 'user') return 'started by you'
  if (version.approvedVia === 'drawer') return `approved by you in the drawer, ${clock(version.at)}`
  if (version.approvedVia === 'conversation') return `approved in the conversation (relayed by ${providerName(version.relayedBy ?? run.origin.by)}), ${clock(version.at)}`
  return 'started on its own (approval is off)'
}

function approvalPhrase(run: RunView): string {
  const pending = run.versions.find(version => version.state === 'pending')
  const active = run.versions.filter(version => version.number > 1 && version.state === 'approved').at(-1)
  return [
    startPhrase(run),
    active ? `now on v${active.number}` : '',
    pending ? `${pending.number > 1 ? `v${pending.number} ` : ''}waiting for your approval` : '',
  ].filter(Boolean).join(' · ')
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
    const asked = run.origin.source === 'drafted' ? `${by} drafted a flow for this task.` : `${by} picked "${run.workflowName}" for this task.`
    return { tone: 'ask', text: `${asked} Nothing runs until you approve, or say "go" to ${by}.`, actions: ['reject', 'approve'] }
  }
  if (run.proposal) return { tone: 'ask', text: `${by} wants to change the flow. ${run.proposal.reason}`, actions: ['keep', 'approve'] }
  if (run.status === 'blocked' || run.status === 'failed') {
    const word = run.status === 'blocked' ? 'Blocked' : 'Failed'
    return { tone: 'problem', text: run.error ? `${word}: ${run.error}` : word, actions: ['retry'] }
  }
  const change = run.latestChange
  if (change?.size === 'big' && change.approvedVia === 'auto' && isLive(run)) {
    return { tone: 'notice', text: `v${change.number} applied automatically. ${change.reason} Approval is off, so it did not wait.`, actions: ['approval-on'] }
  }
  return NO_BANNER
}

async function putJson(url: string, body: JsonRecord): Promise<ApiResult> {
  try {
    const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data: unknown = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data as JsonRecord : {} }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
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
  const pause = $('flow-pause') as HTMLButtonElement, stop = $('flow-stop') as HTMLButtonElement, save = $('flow-save') as HTMLButtonElement
  const banner = $('flow-banner'), stage = $('flow-stage'), quick = $('flow-quick'), quickList = $('flow-quick-list'), empty = $('flow-empty')
  let scopeQuery: string | null = null
  let open = false
  let source: EventSource | null = null
  let ticker: ReturnType<typeof setInterval> | undefined
  let snapshot: ScopeSnapshot = { runs: [], jobs: [] }
  let selected: string | null = null
  let current: RunView | null = null
  let bannerKey = ''
  let saving: string | null = null
  const savedAs = new Map<string, string>()
  const approvalRestored = new Set<string>()

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

  function showError(text: string): void {
    if (banner.hidden) { banner.className = 'flow-banner problem'; banner.querySelector<HTMLElement>('.flow-mark')!.dataset.state = 'failed'; banner.hidden = false }
    rollText(banner.querySelector('p') as HTMLElement, text)
  }

  async function act(action: RunAction, runId: string | undefined, label: string = action): Promise<boolean> {
    const target = snapshot.runs.find(run => run.id === runId)
    if (!target) return false
    const pending = target.versions.find(version => version.state === 'pending')
    const body = (action === 'approve' || action === 'reject') && pending ? { version: pending.number } : {}
    const result = await postJson(`/api/studio/runs/${encodeURIComponent(target.id)}/${action}`, body)
    if (!result.ok) showError(`Could not ${label}: ${errorText(result)}`)
    return result.ok
  }

  async function whileBusy(button: HTMLButtonElement, task: () => Promise<boolean>): Promise<void> {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    const succeeded = await task()
    button.removeAttribute('aria-busy')
    if (!succeeded) button.disabled = false
  }

  async function restoreApproval(run: RunView): Promise<boolean> {
    const result = await putJson('/api/flow-approval', { flowApproval: true })
    if (!result.ok) { showError(`Could not turn approval on: ${errorText(result)}`); return false }
    approvalRestored.add(`${run.id}:${run.latestChange?.number}`)
    paintBanner(current, true)
    return true
  }

  async function saveRun(runId: string | undefined): Promise<void> {
    if (!runId || saving) return
    saving = runId
    save.setAttribute('aria-busy', 'true')
    paintSave(current)
    const result = await postJson(`/api/studio/runs/${encodeURIComponent(runId)}/save`, {})
    saving = null
    save.removeAttribute('aria-busy')
    if (result.ok) { savedAs.set(runId, typeof result.data.name === 'string' ? result.data.name : 'a workflow'); paintBanner(current, true) }
    else showError(`Could not save: ${errorText(result)}`)
    paintSave(current)
  }

  function actionButton(action: BannerAction, run: RunView | null): HTMLButtonElement {
    const runId = run?.id
    const button = make('button', '', 'pill flow-sm') as HTMLButtonElement
    button.type = 'button'
    const busy = (task: () => Promise<boolean>) => () => void whileBusy(button, task)
    if (action === 'approve') {
      button.classList.add('flow-primary')
      button.textContent = run?.proposal ? `Approve v${run.proposal.number}` : 'Approve and run'
      button.onclick = busy(() => act('approve', runId))
      return button
    }
    if (action === 'keep') {
      const label = `Keep v${run ? activeVersion(run) : 1}`
      button.classList.add('flow-ghost')
      button.textContent = label
      button.onclick = busy(() => act('reject', runId, label.toLowerCase()))
      return button
    }
    if (action === 'approval-on') {
      button.classList.add('flow-ghost')
      button.textContent = 'Turn approval on'
      button.onclick = busy(() => run ? restoreApproval(run) : Promise.resolve(false))
      return button
    }
    if (action === 'retry') { button.textContent = 'Retry step'; button.onclick = busy(() => act('retry', runId)); return button }
    const [idle, armed] = action === 'reject' ? ['Reject', 'Reject flow'] : ['Stop', 'Stop flow']
    button.classList.add('flow-ghost', 'flow-confirm')
    button.setAttribute('aria-label', idle)
    button.dataset.action = action
    button.append(make('span', idle), make('span', armed))
    return button
  }

  function bannerShown(run: RunView | null): Banner {
    const next = run ? bannerFor(run) : NO_BANNER
    if (run && next.tone === 'notice' && approvalRestored.has(`${run.id}:${run.latestChange?.number}`)) return { tone: 'notice', text: 'Approval is on again.', actions: [] }
    return next
  }

  function bannerMark(run: RunView | null, next: Banner): string {
    if (next.tone === 'problem') return 'failed'
    if (next.tone === 'notice') return 'done'
    return run?.proposal ? 'proposed' : 'active'
  }

  function paintBanner(run: RunView | null, force = false): void {
    const next = bannerShown(run)
    const key = JSON.stringify([run?.id, next])
    if (key === bannerKey && !force) return
    bannerKey = key
    banner.hidden = !next.tone
    banner.className = next.tone ? `flow-banner ${next.tone}` : 'flow-banner'
    banner.querySelector<HTMLElement>('.flow-mark')!.dataset.state = bannerMark(run, next)
    ;(banner.querySelector('p') as HTMLElement).textContent = next.text
    const actions = banner.querySelector('.flow-banner-actions') as HTMLElement
    actions.replaceChildren(...next.actions.map(action => actionButton(action, run)))
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
    paintSave(run)
  }

  function paintSave(run: RunView | null): void {
    save.hidden = run?.origin.source !== 'drafted'
    if (!run || save.hidden) return
    const name = savedAs.get(run.id)
    save.textContent = name ? `Saved as ${name}` : 'Save as workflow'
    save.toggleAttribute('data-saved', !!name)
    save.disabled = !!name || saving === run.id
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
  save.onclick = () => void saveRun(current?.id)
  addEventListener('quiet:flow-open', (event) => { open = (event as CustomEvent<boolean>).detail; connect() })
  addEventListener('quiet:activity-scope', (event) => { const session = (event as CustomEvent<{ id: string; cwd: string } | null>).detail; setScope(session ? `terminal=${encodeURIComponent(session.id)}` : null) })
  addEventListener('quiet:chat-agents', (event) => { const chat = (event as CustomEvent<string | null>).detail; if (chat) setScope(`chat=${encodeURIComponent(chat)}`) })
  if (document.body.dataset.chat) setScope(`chat=${encodeURIComponent(document.body.dataset.chat)}`)
  else paint()
}

if (typeof document !== 'undefined' && document.getElementById('flow-stage')) mountFlowDrawer()
