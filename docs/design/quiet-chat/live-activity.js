import { activeAgents, awarenessFlows, flowColumns, scopedWork, selectFlow } from '../../../client/awareness.ts'
import { buildWork } from '../../../client/work.ts'
import { errorText, getJson, readArray, readRecord } from '../../../client/shared.ts'
import { providerName } from '../../../client/terminal-view.ts'

const $ = id => document.getElementById(id)
let scope = null
let generation = 0
let refreshing = false
let flows = []
let current = ''
let agentSignature = ''

function node(tag, text = '', className = '') {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}

export function setActivityScope(session) {
  generation++
  scope = session
  flows = []
  current = ''
  agentSignature = ''
  $('live-agents').hidden = !session
  $('live-flow').hidden = !session
  $('live-agents-list').replaceChildren()
  $('live-flow-steps').replaceChildren()
  $('live-flow-select').hidden = true
  $('live-agents-status').textContent = 'Loading session activity…'
  $('live-flow-status').textContent = 'Loading session flow…'
  if (session) void refresh()
}

function paintFlow() {
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

function paintAgents(agents) {
  $('live-agents-status').textContent = agents.length ? `${agents.length} active agent${agents.length === 1 ? '' : 's'}` : 'No active agents linked to this session.'
  const signature = JSON.stringify(agents.map(item => [item.id, item.label, item.provider, item.state, item.activity]))
  if (signature === agentSignature) return
  agentSignature = signature
  const open = new Set([...$('live-agents-list').querySelectorAll('details[open]')].map(detail => detail.dataset.thread))
  $('live-agents-list').replaceChildren()
  for (const item of agents) {
    const card = node('details', '', 'agent')
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

async function refresh() {
  if (!scope || refreshing || document.hidden || (!$('agents').open && $('flow').dataset.open !== 'true')) return
  const request = generation
  const session = scope
  refreshing = true
  const [jobsResult, flowResult] = await Promise.all([getJson('/api/jobs'), getJson('/api/flow?includeArchived=1')])
  refreshing = false
  if (request !== generation) return
  if (!jobsResult.ok || !flowResult.ok) {
    const message = `Activity unavailable: ${errorText(!jobsResult.ok ? jobsResult : flowResult)}. Retrying…`
    for (const id of ['live-agents-status', 'live-flow-status']) $(id).textContent = message
    $('live-agents-list').replaceChildren()
    $('live-flow-steps').replaceChildren()
    $('live-flow-select').hidden = true
    agentSignature = ''
    return
  }
  const jobs = readArray(jobsResult.data.jobs).map(job => ({ ...job, threadRoot: job.threadRoot || job.id }))
  const states = readRecord(flowResult.data.sessions)
  const linked = scopedWork(buildWork(jobs, {}), session.id, session.cwd).flatMap(item => item.members ?? [])
  flows = awarenessFlows(scopedWork(buildWork(linked, states), session.id, session.cwd))
  current = selectFlow(flows, current)
  $('live-flow-select').replaceChildren(...flows.map(item => {
    const option = node('option', item.label)
    option.value = item.id
    return option
  }))
  $('live-flow-select').value = current
  $('live-flow-select').hidden = flows.length < 2
  paintFlow()
  paintAgents(activeAgents(linked, states, session.id, session.cwd))
}

$('live-flow-select').onchange = () => { current = $('live-flow-select').value; paintFlow() }
for (const id of ['open-agents', 'toggle-flow']) $(id).addEventListener('click', () => void refresh())
setInterval(() => void refresh(), 3000)
