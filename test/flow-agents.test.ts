import { afterAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const markup = `<dialog id="agents" open><div id="live-agents" hidden></div><div class="activity-empty"><p>No agents yet.</p></div><section id="flow-agents" hidden><h3>Flows running</h3><div id="flow-agents-list"></div></section></dialog>`
const { window } = new JSDOM(`<body>${markup}</body>`, { url: 'http://127.0.0.1:7777/' })
const doc = window.document
type Job = Record<string, unknown>
let jobs: Job[] = []
const fetched: string[] = []
const runs: Record<string, unknown> = {
  'run-q': { id: 'run-q', label: 'Invoice PDF footer', workflow: { nodes: [{ id: 'plan', title: 'Plan' }, { id: 'execute', title: 'Execute' }] } },
}
const realFetch = globalThis.fetch
Object.assign(globalThis, { window, document: doc, HTMLElement: window.HTMLElement, HTMLDialogElement: window.HTMLDialogElement })
globalThis.fetch = (async (url: string) => {
  fetched.push(String(url))
  if (url === '/api/jobs') return Response.json({ jobs })
  const run = runs[String(url).replace('/api/studio/runs/', '')]
  return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 })
}) as typeof fetch
afterAll(() => { globalThis.fetch = realFetch; window.close(); for (const key of ['window', 'document', 'HTMLElement', 'HTMLDialogElement']) Reflect.deleteProperty(globalThis, key) })

const { refreshFlowAgents } = await import('../client/flow-agents')
const flush = async (times = 4) => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const section = () => doc.getElementById('flow-agents') as HTMLElement
const items = () => [...doc.querySelectorAll<HTMLElement>('#flow-agents-list .ag-item')]
const job = (patch: Job): Job => ({ id: 'j', label: 'Invoice PDF footer', engine: 'codex', status: 'running', startedAt: Date.now() - 65_000, endedAt: null, ...patch })

beforeEach(() => { jobs = []; fetched.length = 0 })

test('running queue and Studio flow steps appear with their run and step name', async () => {
  jobs = [
    job({ id: 'j-exec', workflowRunId: 'run-q', workflowNodeId: 'execute' }),
    job({ id: 'j-chat', purpose: 'chat', chatId: 'c1' }),
    job({ id: 'j-done', workflowRunId: 'run-q', workflowNodeId: 'plan', status: 'done' }),
    job({ id: 'j-term', workflowRunId: 'run-t', workflowNodeId: 'plan', terminalId: 't1' }),
    job({ id: 'j-chat-flow', workflowRunId: 'run-c', workflowNodeId: 'plan', chatId: 'c1' }),
  ]
  await refreshFlowAgents()
  expect(section().hidden).toBe(false)
  expect(doc.getElementById('agents')!.hasAttribute('data-flows')).toBe(true)
  expect(items()).toHaveLength(1)
  expect(items()[0]!.querySelector('.l')?.textContent).toBe('Invoice PDF footer')
  expect(items()[0]!.querySelector('.ag-tick')?.textContent).toBe('Execute')
  expect(items()[0]!.querySelector('.pill-state')?.textContent).toBe('Working')
  expect(items()[0]!.querySelector('img')?.getAttribute('src')).toBe('/providers/codex.svg')
  expect(items()[0]!.getAttribute('tabindex')).toBe('0')
})

test('clicking a flow step, or pressing Enter on it, opens it in the live flow view', async () => {
  jobs = [job({ id: 'j-exec', workflowRunId: 'run-q', workflowNodeId: 'execute' })]
  await refreshFlowAgents()
  const watched: unknown[] = []
  addEventListener('quiet:flow-watch', (event) => watched.push((event as CustomEvent).detail))
  items()[0]!.click()
  items()[0]!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(watched).toEqual([{ runId: 'run-q', jobId: 'j-exec' }, { runId: 'run-q', jobId: 'j-exec' }])
})

test('a run it cannot read still lists the step by its id, and it asks for each run only once', async () => {
  jobs = [job({ id: 'j-x', workflowRunId: 'run-gone', workflowNodeId: 'review' })]
  await refreshFlowAgents()
  await refreshFlowAgents()
  expect(items()[0]!.querySelector('.ag-tick')?.textContent).toBe('review')
  expect(fetched.filter(url => url === '/api/studio/runs/run-gone')).toHaveLength(1)
})

test('with no flow running the section hides and the empty note comes back', async () => {
  await refreshFlowAgents()
  await flush()
  expect(section().hidden).toBe(true)
  expect(items()).toHaveLength(0)
  expect(doc.getElementById('agents')!.hasAttribute('data-flows')).toBe(false)
})
