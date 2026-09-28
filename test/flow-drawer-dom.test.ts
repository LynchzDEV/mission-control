import { afterAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { RunView, ScopeSnapshot } from '../server/run-view'

const markup = `<section id="flow" data-open="true"><h2 id="flow-title"></h2><select id="flow-runs" hidden></select><small id="flow-meta"></small><div id="flow-pills"></div>
<div class="flow-actions"><button id="flow-pause" type="button" hidden>Pause</button><button id="flow-stop" class="flow-confirm" type="button" aria-label="Stop" hidden><span>Stop</span><span>Stop flow</span></button></div>
<div id="flow-banner" hidden><span class="flow-mark"></span><p></p><div class="flow-banner-actions"></div></div>
<div id="flow-stage" hidden></div><div id="flow-quick" hidden><ol id="flow-quick-list"></ol></div><p id="flow-empty"></p></section>`
const { window } = new JSDOM(`<body>${markup}</body>`, { url: 'http://127.0.0.1:7777/' })
const streams: FakeSource[] = []
const posts: string[] = []
class FakeSource {
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) { streams.push(this) }
  close() { this.closed = true }
  send(snapshot: ScopeSnapshot) { this.onmessage?.({ data: JSON.stringify(snapshot) }) }
}
const realFetch = globalThis.fetch
Object.assign(globalThis, { window, document: window.document, EventSource: FakeSource, HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement, HTMLSelectElement: window.HTMLSelectElement, Option: window.Option, localStorage: window.localStorage })
globalThis.fetch = (async (url: string) => { posts.push(String(url)); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as typeof fetch
afterAll(() => { dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false })); globalThis.fetch = realFetch; window.close(); for (const key of ['window', 'document', 'EventSource', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Option', 'localStorage']) Reflect.deleteProperty(globalThis, key) })

const run = (id: string, createdAt: number): RunView => ({
  id, label: `Flow ${id}`, status: 'running', error: null, workflowName: 'Feature build', revision: 'v', entry: 'plan', currentNodeId: 'plan',
  origin: { source: 'saved', by: 'codex', where: 'terminal' },
  versions: [{ number: 1, revision: 'v', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'drawer', relayedBy: null, at: 0 }],
  nodes: [{ id: 'plan', title: 'Plan', kind: 'plan', engine: 'claude' }], edges: [],
  attempts: [{ nodeId: 'plan', number: 0, jobId: 'j', status: 'running', outcome: null, summary: null, startedAt: 0, endedAt: null }],
  createdAt, updatedAt: createdAt,
})

test('a confirmed Stop goes to the flow that was showing when it was armed', async () => {
  await import('../client/flow-drawer')
  dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: { id: 'terminal-1', cwd: '/x' } }))
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: true }))
  const stream = streams.at(-1)!
  expect(stream.url).toContain('terminal=terminal-1')
  stream.send({ runs: [run('A', 1)], jobs: [] })
  const stop = document.getElementById('flow-stop') as HTMLButtonElement
  expect(stop.hidden).toBe(false)
  stop.click()
  stream.send({ runs: [run('B', 2), run('A', 1)], jobs: [] })
  expect(document.getElementById('flow-runs')!.hidden).toBe(false)
  stop.click()
  await Bun.sleep(0)
  expect(posts).toEqual(['/api/studio/runs/A/stop'])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
  expect(stream.closed).toBe(true)
})
