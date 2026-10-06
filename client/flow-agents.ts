import { getJson, readArray, readRecord, type JsonRecord } from './shared'

type FlowJob = { id: string; label: string; engine: string; runId: string; nodeId: string; startedAt: number }
type RunNames = { label: string | null; steps: Map<string, string> }

const POLL_MS = 3000
const runNames = new Map<string, Promise<RunNames>>()

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

function flowJob(job: JsonRecord): FlowJob | null {
  const runId = text(job.workflowRunId)
  const nodeId = text(job.workflowNodeId)
  const id = text(job.id)
  if (job.status !== 'running' || runId === null || nodeId === null || id === null || text(job.chatId) !== null || text(job.terminalId) !== null) return null
  return { id, runId, nodeId, label: text(job.label) ?? 'Flow', engine: text(job.engine) ?? 'claude', startedAt: typeof job.startedAt === 'number' ? job.startedAt : Date.now() }
}

async function readRunNames(runId: string): Promise<RunNames> {
  const result = await getJson(`/api/studio/runs/${encodeURIComponent(runId)}`)
  if (!result.ok) runNames.delete(runId)
  const nodes = readArray(readRecord(result.data.workflow).nodes)
  return { label: result.ok ? text(result.data.label) : null, steps: new Map(nodes.flatMap(node => (text(node.id) && text(node.title) ? [[String(node.id), String(node.title)] as const] : []))) }
}

const namesOf = (runId: string): Promise<RunNames> => runNames.get(runId) ?? runNames.set(runId, readRunNames(runId)).get(runId)!

function node(tag: string, content = '', className = ''): HTMLElement {
  const element = document.createElement(tag)
  element.textContent = content
  element.className = className
  return element
}

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function row(job: FlowJob, names: RunNames): HTMLElement {
  const item = node('div', '', 'ag-item')
  item.dataset.job = job.id
  item.dataset.engine = job.engine
  item.tabIndex = 0
  item.title = 'Watch this step'
  const open = (): void => { dispatchEvent(new CustomEvent('quiet:flow-watch', { detail: { runId: job.runId, jobId: job.id } })) }
  item.onclick = open
  item.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }
  const line = node('div', '', 'ag-row')
  const disc = node('span', '', 'ag-disc')
  const logo = document.createElement('img')
  logo.src = `/providers/${job.engine}.svg`
  logo.alt = ''
  disc.append(logo)
  const pill = node('span', 'Working', 'pill-state')
  pill.dataset.s = 'running'
  line.append(disc, node('span', names.label ?? job.label, 'l'), node('time', elapsed(job.startedAt)), pill)
  item.append(line, node('p', names.steps.get(job.nodeId) ?? job.nodeId, 'ag-tick'))
  return item
}

export async function refreshFlowAgents(): Promise<void> {
  const section = document.getElementById('flow-agents')
  const list = document.getElementById('flow-agents-list')
  const dialog = document.getElementById('agents')
  if (section === null || list === null || dialog === null) return
  const result = await getJson('/api/jobs')
  if (!result.ok) return
  const running = readArray(result.data.jobs).map(flowJob).filter((job): job is FlowJob => job !== null)
  for (const runId of [...runNames.keys()]) if (!running.some(job => job.runId === runId)) runNames.delete(runId)
  const rows = await Promise.all(running.map(async job => row(job, await namesOf(job.runId))))
  list.replaceChildren(...rows)
  section.hidden = rows.length === 0
  dialog.toggleAttribute('data-flows', rows.length > 0)
}

const agents = typeof document === 'undefined' ? null : document.getElementById('agents') as HTMLDialogElement | null
if (agents !== null && document.getElementById('flow-agents') !== null && document.getElementById('open-agents') !== null) {
  const poll = (): void => { if (agents.open && !document.hidden) void refreshFlowAgents() }
  document.getElementById('open-agents')!.addEventListener('click', () => setTimeout(poll))
  addEventListener('quiet:flow-watch', () => { if (agents.open && matchMedia('(max-width: 600px)').matches) agents.close() })
  setInterval(poll, POLL_MS)
}
