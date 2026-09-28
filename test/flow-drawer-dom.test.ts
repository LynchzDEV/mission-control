import { afterAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { RunView, ScopeSnapshot } from '../server/run-view'

const markup = `<section id="flow" data-open="true"><h2 id="flow-title"></h2><select id="flow-runs" hidden></select><small id="flow-meta"></small><div id="flow-pills"></div>
<div class="flow-actions"><button id="flow-save" type="button" hidden>Save as workflow</button><button id="flow-pause" type="button" hidden>Pause</button><button id="flow-stop" class="flow-confirm" type="button" aria-label="Stop" hidden><span>Stop</span><span>Stop flow</span></button></div>
<div id="flow-banner" hidden><span class="flow-mark"></span><p></p><div class="flow-banner-actions"></div></div>
<div id="flow-stage" hidden><div id="flow-canvas" class="flow-canvas"></div><div class="flow-zoom" hidden><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="fit">Fit</button><button type="button" data-zoom="follow" aria-pressed="true">Follow</button></div></div><div id="flow-quick" hidden><ol id="flow-quick-list"></ol></div><p id="flow-empty"></p></section>`
const { window } = new JSDOM(`<body>${markup}</body>`, { url: 'http://127.0.0.1:7777/' })
const streams: FakeSource[] = []
type Sent = { url: string; method: string; body: unknown }
const sent: Sent[] = []
const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
let respond: (request: Sent) => Response | Promise<Response> = ok
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
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const request = { url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
  sent.push(request)
  return respond(request)
}) as typeof fetch
afterAll(() => { dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false })); globalThis.fetch = realFetch; window.close(); for (const key of ['window', 'document', 'EventSource', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Option', 'localStorage', 'matchMedia']) Reflect.deleteProperty(globalThis, key) })
const stageSize = { width: 1000, height: 300 }
const flowStage = window.document.getElementById('flow-stage')!
Object.defineProperty(flowStage, 'clientWidth', { get: () => stageSize.width })
Object.defineProperty(flowStage, 'clientHeight', { get: () => stageSize.height })

const run = (id: string, createdAt: number): RunView => ({
  id, label: `Flow ${id}`, status: 'running', error: null, workflowName: 'Feature build', revision: 'v', entry: 'plan', currentNodeId: 'plan',
  origin: { source: 'saved', by: 'codex', where: 'terminal' },
  versions: [{ number: 1, revision: 'v', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'drawer', relayedBy: null, at: 0 }],
  nodes: [{ id: 'plan', title: 'Plan', kind: 'plan', engine: 'claude' }], edges: [],
  attempts: [{ nodeId: 'plan', number: 0, jobId: 'j', status: 'running', outcome: null, summary: null, startedAt: 0, endedAt: null }],
  createdAt, updatedAt: createdAt, proposal: null, latestChange: null,
  tokens: [{ nodeId: 'plan', pathId: 'main', state: 'working', from: [] }], sections: [], keptBranches: [],
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
  expect(sent.map(request => request.url)).toEqual(['/api/studio/runs/A/stop'])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
  expect(stream.closed).toBe(true)
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const buttonNamed = (text: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('#flow-banner button, .flow-actions button')].find(button => button.textContent === text)!
const bannerText = (): string => document.querySelector('#flow-banner p')!.textContent ?? ''
const openStream = (): FakeSource => {
  window.localStorage.setItem('mc.motion.paused', 'true')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: true }))
  return streams.at(-1)!
}
const proposing = (): RunView => ({
  ...run('P', 10),
  versions: [run('P', 10).versions[0]!, { number: 2, revision: 'v2', reason: 'Needs a migration.', size: 'big', state: 'pending', approvedVia: null, relayedBy: null, at: 0 }],
  proposal: { number: 2, reason: 'Needs a migration.', nodes: [{ id: 'plan', title: 'Plan', kind: 'plan', engine: 'claude' }, { id: 'migrate', title: 'DB migration', kind: 'implement', engine: 'claude' }], edges: [{ source: 'plan', target: 'migrate', outcome: 'pass' }], removed: [], changed: [] },
  latestChange: { number: 2, reason: 'Needs a migration.', size: 'big', approvedVia: null, state: 'pending' },
})

test('Approve v2 posts the proposal version to approve, is busy while posting, and draws the ghost step', async () => {
  sent.length = 0
  const stream = openStream()
  stream.send({ runs: [proposing()], jobs: [] })
  expect(bannerText()).toBe('Codex wants to change the flow. Needs a migration.')
  expect(document.querySelector('.flow-step[data-state="proposed"] strong')!.textContent).toBe('DB migration')
  let release: (response: Response) => void = () => {}
  respond = () => new Promise(resolve => { release = resolve })
  const approve = buttonNamed('Approve v2')
  approve.click()
  expect(approve.disabled).toBe(true)
  release(ok())
  await Bun.sleep(0)
  expect(sent).toEqual([{ url: '/api/studio/runs/P/approve', method: 'POST', body: { version: 2 } }])
  respond = ok
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('Keep v1 posts the proposal version to reject; a refusal shows in the banner and frees the button', async () => {
  sent.length = 0
  const stream = openStream()
  stream.send({ runs: [proposing()], jobs: [] })
  respond = () => json(409, { error: 'That version is no longer waiting' })
  const keep = buttonNamed('Keep v1')
  keep.click()
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(sent).toEqual([{ url: '/api/studio/runs/P/reject', method: 'POST', body: { version: 2 } }])
  expect(bannerText()).toBe('Could not keep v1: That version is no longer waiting')
  expect(keep.disabled).toBe(false)
  respond = ok
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('Turn approval on puts the setting and the notice says approval is on again', async () => {
  sent.length = 0
  const stream = openStream()
  const applied: RunView = { ...proposing(), proposal: null, versions: [run('P', 10).versions[0]!, { number: 2, revision: 'v2', reason: 'Needs a migration.', size: 'big', state: 'approved', approvedVia: 'auto', relayedBy: null, at: 0 }], latestChange: { number: 2, reason: 'Needs a migration.', size: 'big', approvedVia: 'auto', state: 'approved' } }
  stream.send({ runs: [applied], jobs: [] })
  expect(document.getElementById('flow-banner')!.className).toBe('flow-banner notice')
  respond = () => json(200, { flowApproval: true })
  buttonNamed('Turn approval on').click()
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(sent).toEqual([{ url: '/api/flow-approval', method: 'PUT', body: { flowApproval: true } }])
  expect(bannerText()).toBe('Approval is on again.')
  expect(document.querySelectorAll('#flow-banner button')).toHaveLength(0)
  stream.send({ runs: [{ ...applied, updatedAt: 11 }], jobs: [] })
  expect(bannerText()).toBe('Approval is on again.')
  respond = ok
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('Save as workflow shows only for drafted flows, saves, and reports a name clash in the banner', async () => {
  sent.length = 0
  const stream = openStream()
  const save = document.getElementById('flow-save') as HTMLButtonElement
  stream.send({ runs: [run('S', 20)], jobs: [] })
  expect(save.hidden).toBe(true)
  const drafted = (id: string): RunView => ({ ...run(id, 20), label: 'Add CSV export', origin: { source: 'drafted', by: 'codex', where: 'terminal' } })
  stream.send({ runs: [drafted('S')], jobs: [] })
  expect([save.hidden, save.textContent, save.disabled]).toEqual([false, 'Save as workflow', false])
  respond = () => json(409, { error: 'A workflow with that name exists' })
  save.click()
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(bannerText()).toBe('Could not save: A workflow with that name exists')
  expect([save.textContent, save.disabled]).toEqual(['Save as workflow', false])
  respond = () => json(200, { id: 'add-csv-export', name: 'Add CSV export', revision: 'r' })
  save.click()
  expect(save.disabled).toBe(true)
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(sent.map(request => [request.url, request.method])).toEqual([['/api/studio/runs/S/save', 'POST'], ['/api/studio/runs/S/save', 'POST']])
  expect([save.textContent, save.disabled]).toEqual(['Saved as Add CSV export', true])
  stream.send({ runs: [{ ...drafted('S'), updatedAt: 30 }], jobs: [] })
  expect([save.textContent, save.disabled]).toEqual(['Saved as Add CSV export', true])
  respond = ok
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

const chain = (id: string, count: number, working: number): RunView => {
  const ids = Array.from({ length: count }, (_, index) => `s${index + 1}`)
  return {
    ...run(id, 40),
    entry: 's1', currentNodeId: ids[working]!,
    nodes: ids.map(node => ({ id: node, title: node.toUpperCase(), kind: 'task', engine: 'claude' })),
    edges: ids.slice(1).map((node, index) => ({ source: ids[index]!, target: node, outcome: 'pass' as const })),
    attempts: [{ nodeId: ids[working]!, number: 0, jobId: 'j', status: 'running', outcome: null, summary: null, startedAt: 0, endedAt: null }],
    tokens: [{ nodeId: ids[working]!, pathId: 'main', state: 'working', from: [] }],
  }
}
const canvas = (): HTMLElement => document.getElementById('flow-canvas')!
const pointer = (type: string, clientX: number) => flowStage.dispatchEvent(new window.PointerEvent(type, { pointerId: 1, clientX, clientY: 60, button: 0, bubbles: true }))

test('the graph paints into the canvas; a small flow sits at scale 1 with no zoom controls and a stage that fits it', () => {
  stageSize.width = 1000
  const stream = openStream()
  stream.send({ runs: [chain('small', 4, 1)], jobs: [] })
  expect(canvas().querySelectorAll('.flow-step')).toHaveLength(4)
  expect(canvas().style.transform).toContain('scale(1)')
  expect(document.querySelector<HTMLElement>('.flow-zoom')!.hidden).toBe(true)
  expect(flowStage.style.height).toBe('120px')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('two snapshots that arrive after a drag leave the view where the drag put it and Follow off', () => {
  stageSize.width = 400
  const stream = openStream()
  stream.send({ runs: [chain('dragged', 8, 0)], jobs: [] })
  const fitted = canvas().style.transform
  pointer('pointerdown', 100)
  pointer('pointermove', 120)
  pointer('pointerup', 120)
  const dragged = canvas().style.transform
  expect(dragged).not.toBe(fitted)
  expect(document.querySelector('[data-zoom="follow"]')!.getAttribute('aria-pressed')).toBe('false')
  stream.send({ runs: [{ ...chain('dragged', 8, 7), updatedAt: 41 }], jobs: [] })
  stream.send({ runs: [{ ...chain('dragged', 8, 6), updatedAt: 42 }], jobs: [] })
  expect(canvas().style.transform).toBe(dragged)
  expect(document.querySelector('[data-zoom="follow"]')!.getAttribute('aria-pressed')).toBe('false')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('following the working step never animates under reduced motion, and does when motion is allowed', () => {
  stageSize.width = 300
  const frames: unknown[] = []
  Object.assign(canvas(), { animate: (keyframes: unknown) => { frames.push(keyframes) } })
  const stream = openStream()
  stream.send({ runs: [chain('reduced', 8, 0)], jobs: [] })
  const fitted = canvas().style.transform
  window.localStorage.setItem('mc.motion.paused', 'false')
  Object.assign(globalThis, { matchMedia: () => ({ matches: true }) })
  stream.send({ runs: [{ ...chain('reduced', 8, 7), updatedAt: 41 }], jobs: [] })
  expect(canvas().style.transform).not.toBe(fitted)
  expect(frames).toEqual([])
  Object.assign(globalThis, { matchMedia: () => ({ matches: false }) })
  stream.send({ runs: [{ ...chain('reduced', 8, 0), updatedAt: 42 }], jobs: [] })
  expect(canvas().style.transform).toBe(fitted)
  expect(frames).toHaveLength(1)
  window.localStorage.setItem('mc.motion.paused', 'true')
  Reflect.deleteProperty(canvas(), 'animate')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})
