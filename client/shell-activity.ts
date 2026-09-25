import { activeAgents, awarenessFlows, flowColumns, scopedWork, selectFlow } from './awareness'
import { buildWork, type WorkItem, type WorkJob } from './work'
import { errorText, getJson, postJson, providerName, readArray, readRecord } from './shared'

type Session = { id: string; cwd: string }
type Scope = { kind: 'session'; session: Session } | { kind: 'chat'; chat: string }
type ChatAgent = { id: string; label: string; engine: string; model: string | null; reason?: string; status: string; reviewedAt: number | null; currentActivity?: string | null; purpose?: string; startedAt?: number; endedAt?: number | null }
type AgentRow = { id: string; jobId?: string; label: string; engine: string; pill: string; pillState: string; line: string; lineState: 'live' | 'still' | 'none'; startedAt?: number; endedAt?: number | null }

const PLAIN_STEPS: Record<string, string> = { Read: 'Reading', Edit: 'Editing', Write: 'Writing', Bash: 'Running', Grep: 'Searching', Glob: 'Searching' }
const FADE_MS = 300
const LOG_LINES = 40
const LOG_POLL_MS = 3000

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
let scope: Scope | null = null
let replyTarget: string | null = null
let generation = 0
let refreshing = false
let flows: WorkItem[] = []
let current = ''
let agentSignature = ''
let openRow: string | null = null
let logTimer: ReturnType<typeof setInterval> | undefined
let openJob: string | undefined
const replyForm = $('agent-reply') as HTMLFormElement
const logBox = node('div', '', 'ag-log')

function node(tag: string, text = '', className = ''): HTMLElement {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}

function setActivityScope(next: Scope | null): void {
  generation++
  scope = next
  flows = []
  current = ''
  agentSignature = ''
  closeDetail()
  $('live-agents').hidden = !next
  $('live-flow').hidden = next?.kind !== 'session'
  document.querySelectorAll<HTMLElement>('#agents .activity-empty').forEach(node => { node.hidden = !!next })
  $('live-agents-list').replaceChildren()
  $('agents-summary').textContent = ''
  $('live-flow-steps').replaceChildren()
  $('live-flow-select').hidden = true
  $('live-agents-status').textContent = next?.kind === 'chat' ? 'Loading the chat’s agents…' : 'Loading session activity…'
  $('live-flow-status').textContent = 'Loading session flow…'
  if (next) void refresh()
}

function agentState(job: ChatAgent, all: ChatAgent[]): { text: string; state: string } {
  if (job.status === 'running') return { text: 'Working', state: 'running' }
  if (job.status === 'failed') return { text: 'Needs you', state: 'needs-you' }
  if (job.reviewedAt !== null) return { text: 'Landed', state: 'landed' }
  if (all.some(other => (other as ChatAgent & { reviewOf?: string | null }).reviewOf === job.id && other.status === 'running')) return { text: 'In review', state: 'reviewing' }
  return { text: 'Done', state: 'done' }
}

function parkReply(): void {
  replyTarget = null
  replyForm.hidden = true
  $('agents').append(replyForm)
}

function closeDetail(): void {
  if (openRow === null) return
  openRow = null
  clearInterval(logTimer)
  logTimer = undefined
  logBox.replaceChildren()
  logBox.remove()
  parkReply()
}

function logLine(event: Record<string, unknown>): HTMLElement {
  const line = node('div')
  const time = typeof event.ts === 'number' ? new Date(event.ts).toTimeString().slice(0, 8) : ''
  if (time) line.append(node('span', time, 't'), ' ')
  if (event.kind === 'tool') line.append(node('span', String(event.title), 'k'), ' ')
  line.append(String(event.detail || event.title || ''))
  return line
}

async function loadLog(row: string, job: string): Promise<void> {
  const result = await getJson(`/api/jobs/${encodeURIComponent(job)}/activity`)
  if (row !== openRow) return
  if (!result.ok) { logBox.replaceChildren(node('div', `Log unavailable: ${errorText(result)}`, 't')); return }
  const events = readArray(result.data.events).slice(-LOG_LINES)
  logBox.replaceChildren(...(events.length ? events.map(logLine) : [node('div', 'No activity yet.', 't')]))
  logBox.scrollTop = logBox.scrollHeight
}

function showDetail(item: HTMLElement, row: AgentRow): void {
  item.classList.add('open')
  const detail = item.querySelector('.ag-detail') as HTMLElement
  if (row.jobId) detail.prepend(logBox)
  if (scope?.kind !== 'chat') return
  replyTarget = row.id
  $('agent-reply-label').textContent = `Message ${row.label}`
  replyForm.hidden = false
  ;(detail.querySelector('.ag-why') as HTMLElement).after(replyForm)
}

function openDetail(item: HTMLElement, row: AgentRow): void {
  const wasOpen = openRow === row.id
  $('live-agents-list').querySelectorAll('.ag-item.open').forEach(other => other.classList.remove('open'))
  closeDetail()
  if (wasOpen) return
  openRow = row.id
  showDetail(item, row)
  openJob = row.jobId
  watchLog()
}

function watchLog(): void {
  clearInterval(logTimer)
  logTimer = undefined
  const row = openRow, job = openJob
  if (!row || !job || !($('agents') as HTMLDialogElement).open) return
  void loadLog(row, job)
  logTimer = setInterval(() => { if (!document.hidden) void loadLog(row, job) }, LOG_POLL_MS)
}
$('agents').addEventListener('close', watchLog)
$('open-agents').addEventListener('click', watchLog)

function plainActivity(text: string): string {
  const match = /^(Read|Edit|Write|Bash|Grep|Glob) (.*)$/s.exec(text)
  return match ? `${PLAIN_STEPS[match[1]]} ${match[2]}` : text
}

function elapsed(row: { startedAt?: number; endedAt?: number | null }): string {
  if (!row.startedAt) return ''
  const seconds = Math.max(0, Math.floor(((row.endedAt ?? Date.now()) - row.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function tickTimes(): void {
  $('live-agents-list').querySelectorAll<HTMLElement>('time[data-job]').forEach(time => { time.textContent = elapsed({ startedAt: Number(time.dataset.start), endedAt: time.dataset.end ? Number(time.dataset.end) : null }) })
}

function fadeTo(tick: HTMLElement, text: string): void {
  void tick.offsetWidth
  tick.classList.add('out')
  setTimeout(() => { tick.textContent = text; tick.classList.remove('out') }, FADE_MS)
}

function paintRows(rows: AgentRow[], detail: (row: AgentRow) => HTMLElement): void {
  const list = $('live-agents-list')
  const shown = new Map([...list.querySelectorAll<HTMLElement>('.ag-tick')].map(tick => [tick.dataset.job, tick.textContent ?? '']))
  const openNow = rows.find(row => row.id === openRow)
  const box = $('reply') as HTMLTextAreaElement
  const typing = openNow && replyForm.contains(document.activeElement) ? [box.selectionStart, box.selectionEnd] as const : null
  if (openNow) { logBox.remove(); parkReply() } else if (openRow) closeDetail()
  list.replaceChildren()
  for (const row of rows) {
    const item = node('div', '', 'ag-item')
    item.dataset.job = row.id
    item.dataset.engine = row.engine
    item.tabIndex = 0
    item.onclick = (event) => { if (!(event.target as Element).closest('.ag-detail')) openDetail(item, row) }
    item.onkeydown = (event) => { if (event.target === item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDetail(item, row) } }
    const line = node('div', '', 'ag-row')
    const disc = node('span', '', 'ag-disc')
    const logo = document.createElement('img')
    logo.src = `/providers/${row.engine}.svg`
    logo.alt = ''
    disc.append(logo)
    const time = node('time', elapsed(row))
    if (row.startedAt) Object.assign(time.dataset, { job: row.id, start: String(row.startedAt), end: row.endedAt ? String(row.endedAt) : '' })
    const pill = node('span', row.pill, 'pill-state')
    pill.dataset.s = row.pillState
    line.append(disc, node('span', row.label, 'l'), time, pill)
    item.append(line)
    const before = shown.get(row.id)
    const tick = row.lineState === 'none' ? null : node('p', row.lineState === 'live' && before ? before : row.line, row.lineState === 'still' ? 'ag-tick still' : 'ag-tick')
    if (tick) { tick.dataset.job = row.id; item.append(tick) }
    item.append(detail(row))
    list.append(item)
    if (row === openNow) showDetail(item, row)
    if (tick && row.lineState === 'live' && before && before !== row.line) fadeTo(tick, row.line)
  }
  if (typing) { box.focus(); box.setSelectionRange(...typing) }
}

function lastLine(text: string | null | undefined): string {
  return (text ?? '').split('\n').map(line => line.trim()).filter(Boolean).pop() ?? ''
}

function chatRow(job: ChatAgent, all: ChatAgent[]): AgentRow {
  const { text, state } = agentState(job, all)
  const pill = state === 'landed' ? 'Done' : text
  const pillState = state === 'needs-you' ? 'needs' : state === 'running' || state === 'reviewing' ? 'running' : 'done'
  const base = { id: job.id, jobId: job.id, label: job.label, engine: job.engine, pill, pillState, startedAt: job.startedAt, endedAt: job.endedAt }
  if (state === 'running') return { ...base, line: plainActivity(job.currentActivity || 'Starting…'), lineState: 'live' }
  if (state === 'needs-you') return { ...base, line: lastLine(job.currentActivity) || 'Needs you', lineState: 'still' }
  return { ...base, line: '', lineState: 'none' }
}

function summarize(working: number, total: number): void {
  $('agents-summary').textContent = total ? `${working} working · ${total} total` : ''
}

function paintChatAgents(agents: ChatAgent[]): void {
  $('live-agents-status').textContent = agents.length ? '' : 'No agents in this chat yet.'
  summarize(agents.filter(job => job.status === 'running').length, agents.length)
  tickTimes()
  const signature = JSON.stringify(agents.map(item => [item.id, item.label, item.status, item.currentActivity, item.reviewedAt]))
  if (signature === agentSignature) return
  agentSignature = signature
  const byId = new Map(agents.map(job => [job.id, job]))
  paintRows(agents.map(job => chatRow(job, agents)), row => chatDetail(byId.get(row.id) as ChatAgent))
}

function chatDetail(job: ChatAgent): HTMLElement {
  const body = node('div', '', 'ag-detail')
  body.append(node('p', `${providerName(job.engine)}${job.model ? ` · ${job.model}` : ''}${job.reason ? ` — ${job.reason}` : ''}`, 'ag-why'))
  const actions = node('div', '', 'ag-actions0')
  if (job.status === 'running') {
    const stop = node('button', 'Stop', 'ag-btn danger') as HTMLButtonElement
    stop.type = 'button'
    stop.onclick = async () => { stop.disabled = true; const result = await postJson(`/api/jobs/${encodeURIComponent(job.id)}/kill`, {}); if (!result.ok) $('live-agents-status').textContent = `Could not stop: ${errorText(result)}`; agentSignature = ''; void refresh() }
    actions.append(stop)
  }
  body.append(actions)
  return body
}

async function refreshChat(chat: string, request: number): Promise<void> {
  const result = await getJson(`/api/jobs?chat=${encodeURIComponent(chat)}`)
  refreshing = false
  if (request !== generation) return
  if (!result.ok) { $('live-agents-status').textContent = `Agents unavailable: ${errorText(result)}. Retrying…`; agentSignature = ''; return }
  paintChatAgents((readArray(result.data.jobs) as unknown as ChatAgent[]).filter(job => job.purpose !== 'chat'))
}

function paintFlow(): void {
  const item = flows.find(flow => flow.id === current)
  $('live-flow-status').textContent = item ? item.label : 'No work linked to this session yet.'
  $('live-flow-steps').replaceChildren()
  for (const column of flowColumns(item)) {
    const group = node('div', '', 'live-flow-column')
    for (const step of column) {
      const card = node('div', '', 'live-flow-node')
      card.dataset.status = step.status
      card.setAttribute('role', 'listitem')
      card.append(node('strong', step.title), node('small', step.detail))
      group.append(card)
    }
    $('live-flow-steps').append(group)
  }
}

function paintAgents(agents: WorkItem[]): void {
  $('live-agents-status').textContent = agents.length ? '' : 'No active agents linked to this session.'
  summarize(agents.filter(item => item.state === 'running').length, agents.length)
  tickTimes()
  const signature = JSON.stringify(agents.map(item => [item.id, item.label, item.provider, item.state, item.activity]))
  if (signature === agentSignature) return
  agentSignature = signature
  paintRows(agents.map(item => ({
    id: item.id, jobId: item.job?.id, label: item.label, engine: item.provider,
    pill: item.state === 'running' ? 'Working' : 'Queued', pillState: item.state === 'running' ? 'running' : 'queued',
    line: plainActivity(item.activity || 'Starting…'), lineState: item.state === 'running' ? 'live' : 'none',
    startedAt: item.job?.startedAt, endedAt: item.job?.endedAt,
  })), row => { const body = node('div', '', 'ag-detail'); body.append(node('p', providerName(row.engine), 'ag-why')); return body })
}

async function refresh(): Promise<void> {
  if (!scope || refreshing || document.hidden || (!($('agents') as HTMLDialogElement).open && $('flow').dataset.open !== 'true')) return
  const request = generation
  refreshing = true
  if (scope.kind === 'chat') { await refreshChat(scope.chat, request); return }
  const session = scope.session
  const [jobsResult, flowResult] = await Promise.all([getJson('/api/jobs'), getJson('/api/flow?includeArchived=1')])
  refreshing = false
  if (request !== generation) return
  if (!jobsResult.ok || !flowResult.ok) {
    const failed = !jobsResult.ok ? jobsResult : flowResult
    for (const id of ['live-agents-status', 'live-flow-status']) $(id).textContent = `Activity unavailable: ${errorText(failed)}. Retrying…`
    $('live-agents-list').replaceChildren()
    $('live-flow-steps').replaceChildren()
    $('live-flow-select').hidden = true
    agentSignature = ''
    return
  }
  const jobs = (readArray(jobsResult.data.jobs) as WorkJob[]).map(job => ({ ...job, threadRoot: job.threadRoot || job.id }))
  const states = readRecord(flowResult.data.sessions)
  const linked = scopedWork(buildWork(jobs, {}), session.id, session.cwd).flatMap(item => item.members ?? [])
  flows = awarenessFlows(scopedWork(buildWork(linked, states), session.id, session.cwd))
  current = selectFlow(flows, current)
  const select = $('live-flow-select') as HTMLSelectElement
  select.replaceChildren(...flows.map(item => new Option(item.label, item.id)))
  select.value = current
  select.hidden = flows.length < 2
  paintFlow()
  paintAgents(activeAgents(linked, states, session.id, session.cwd))
}

;($('live-flow-select') as HTMLSelectElement).onchange = () => { current = ($('live-flow-select') as HTMLSelectElement).value; paintFlow() }
for (const id of ['open-agents', 'toggle-flow']) $(id).addEventListener('click', () => void refresh())
addEventListener('quiet:activity-scope', (event) => { const session = (event as CustomEvent<Session | null>).detail; setActivityScope(session ? { kind: 'session', session } : null) })
addEventListener('quiet:chat-agents', (event) => { const chat = (event as CustomEvent<string | null>).detail; if (chat) setActivityScope({ kind: 'chat', chat }) })
if (document.body.dataset.chat) setActivityScope({ kind: 'chat', chat: document.body.dataset.chat })
;($('agent-reply') as HTMLFormElement).onsubmit = async (event) => {
  event.preventDefault()
  const box = $('reply') as HTMLTextAreaElement
  const text = box.value.trim()
  if (!text || !replyTarget) return
  const result = await postJson(`/api/jobs/${encodeURIComponent(replyTarget)}/reply`, { message: text })
  if (!result.ok) { $('live-agents-status').textContent = `Could not send: ${errorText(result)}`; return }
  box.value = ''
  agentSignature = ''
  void refresh()
}
;($('reply') as HTMLTextAreaElement).placeholder = 'Message this agent…'
setInterval(() => void refresh(), 3000)

export { plainActivity }
