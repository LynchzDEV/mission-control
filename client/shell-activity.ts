import { activeAgents, awarenessFlows, flowColumns, scopedWork, selectFlow } from './awareness'
import { buildWork, type WorkItem, type WorkJob } from './work'
import { errorText, getJson, postJson, readArray, readRecord } from './shared'
import { providerName } from './terminal-view'

type Session = { id: string; cwd: string }
type Scope = { kind: 'session'; session: Session } | { kind: 'chat'; chat: string }
type ChatAgent = { id: string; label: string; engine: string; model: string | null; reason?: string; status: string; reviewedAt: number | null; currentActivity?: string | null; purpose?: string }

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
let scope: Scope | null = null
let replyTarget: string | null = null
let generation = 0
let refreshing = false
let flows: WorkItem[] = []
let current = ''
let agentSignature = ''

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
  replyTarget = null
  $('live-agents').hidden = !next
  $('live-flow').hidden = next?.kind !== 'session'
  document.querySelectorAll<HTMLElement>('#agents .activity-empty').forEach(node => { node.hidden = !!next })
  $('agent-reply').hidden = true
  $('live-agents-list').replaceChildren()
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

function pickReply(job: ChatAgent): void {
  replyTarget = job.id
  $('agent-reply-label').textContent = `Message ${job.label}`
  $('agent-reply').hidden = false
}

function paintChatAgents(agents: ChatAgent[]): void {
  $('live-agents-status').textContent = agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'} in this chat` : 'No agents in this chat yet.'
  const signature = JSON.stringify(agents.map(item => [item.id, item.label, item.status, item.currentActivity, item.reviewedAt]))
  if (signature === agentSignature) return
  agentSignature = signature
  const open = new Set([...$('live-agents-list').querySelectorAll<HTMLElement>('details[open]')].map(detail => detail.dataset.job))
  $('live-agents-list').replaceChildren()
  for (const job of agents) {
    const card = node('details', '', 'agent') as HTMLDetailsElement
    card.dataset.job = job.id
    card.open = open.has(job.id)
    const { text, state } = agentState(job, agents)
    const summary = node('summary')
    const status = node('span', text, 'status')
    status.dataset.state = state
    summary.append(node('span', job.label), status)
    const body = node('div', '', 'agent-body')
    body.append(node('p', `${providerName(job.engine)}${job.model ? ` · ${job.model}` : ''}${job.reason ? ` — ${job.reason}` : ''}`, 'muted'), node('p', job.currentActivity || (job.status === 'running' ? 'No activity reported yet.' : text)))
    const actions = node('div', '', 'agent-actions')
    if (job.status === 'running') {
      const stop = node('button', 'Stop', 'text-button') as HTMLButtonElement
      stop.type = 'button'
      stop.onclick = async () => { stop.disabled = true; const result = await postJson(`/api/jobs/${encodeURIComponent(job.id)}/kill`, {}); if (!result.ok) $('live-agents-status').textContent = `Could not stop: ${errorText(result)}`; agentSignature = ''; void refresh() }
      actions.append(stop)
    }
    const message = node('button', 'Reply', 'text-button') as HTMLButtonElement
    message.type = 'button'
    message.onclick = () => { pickReply(job); ($('reply') as HTMLTextAreaElement).focus() }
    actions.append(message)
    body.append(actions)
    card.append(summary, body)
    $('live-agents-list').append(card)
  }
  if (replyTarget && !agents.some(job => job.id === replyTarget)) { replyTarget = null; $('agent-reply').hidden = true }
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
  $('live-agents-status').textContent = agents.length ? `${agents.length} active agent${agents.length === 1 ? '' : 's'}` : 'No active agents linked to this session.'
  const signature = JSON.stringify(agents.map(item => [item.id, item.label, item.provider, item.state, item.activity]))
  if (signature === agentSignature) return
  agentSignature = signature
  const open = new Set([...$('live-agents-list').querySelectorAll<HTMLElement>('details[open]')].map(detail => detail.dataset.thread))
  $('live-agents-list').replaceChildren()
  for (const item of agents) {
    const card = node('details', '', 'agent') as HTMLDetailsElement
    card.dataset.thread = item.id
    card.open = open.has(item.id)
    const summary = node('summary')
    summary.append(node('span', item.label), node('span', item.state === 'running' ? 'Working' : 'Queued', 'status'))
    const body = node('div', '', 'live-agent-body')
    body.append(node('p', providerName(item.provider), 'muted'), node('p', item.activity || 'No activity reported yet.'))
    card.append(summary, body)
    $('live-agents-list').append(card)
  }
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
setInterval(() => void refresh(), 3000)

export {}
