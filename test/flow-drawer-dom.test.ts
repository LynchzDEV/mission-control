import { afterAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { RunView, ScopeSnapshot } from '../server/run-view'

const markup = `<section id="flow" data-open="true"><h2 id="flow-title"></h2><select id="flow-runs" hidden></select><small id="flow-meta"></small><div id="flow-pills"></div>
<div class="flow-actions"><button id="flow-save" type="button" hidden>Save as workflow</button><button id="flow-pause" type="button" hidden>Pause</button><button id="flow-stop" class="flow-confirm" type="button" aria-label="Stop" hidden><span>Stop</span><span>Stop flow</span></button><button id="flow-studio" type="button" hidden>Open in Studio</button></div>
<div id="flow-banner" hidden><span class="flow-mark"></span><p></p><div class="flow-banner-actions"></div></div>
<div id="flow-stage" hidden><div id="flow-canvas" class="flow-canvas"></div><div class="flow-zoom" hidden><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="fit">Fit</button><button type="button" data-zoom="follow" aria-pressed="true">Follow</button></div></div><div id="flow-quick" hidden><ol id="flow-quick-list"></ol></div><div id="flow-term" hidden></div><p id="flow-empty"></p></section>`
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

const forkedRun = (id: string): RunView => {
  const node = (nodeId: string, title: string, kind = 'task') => ({ id: nodeId, title, kind, engine: kind === 'join' ? '' : 'claude' })
  const settled = (nodeId: string, number: number, startedAt: number, endedAt: number, from: number[]) => ({ nodeId, number, jobId: nodeId === 'join' ? null : `j${number}`, status: 'settled', outcome: 'pass' as const, summary: 'ok', startedAt, endedAt, pathId: 'main', from })
  return {
    ...run(id, 50), entry: 'split', currentNodeId: 'review',
    nodes: [node('split', 'Split'), node('a', 'Api'), node('b', 'Ui'), node('join', 'Join', 'join'), node('review', 'Review', 'review')],
    edges: [{ source: 'split', target: 'a', outcome: 'pass' }, { source: 'split', target: 'b', outcome: 'pass' }, { source: 'a', target: 'join', outcome: 'pass' }, { source: 'b', target: 'join', outcome: 'pass' }, { source: 'join', target: 'review', outcome: 'pass' }],
    attempts: [settled('split', 0, 0, 1000, []), settled('a', 1, 2000, 5000, [0]), settled('b', 2, 2000, 4000, [0]), settled('join', 3, 5000, 62_000, [1, 2]),
      { nodeId: 'review', number: 4, jobId: 'j4', status: 'running', outcome: null, summary: null, startedAt: 0, endedAt: null, pathId: 'main', from: [3] }],
    tokens: [{ nodeId: 'review', pathId: 'main', state: 'working', from: [3] }],
    sections: [{ fork: 'split', join: 'join', state: 'joined', joined: [], paths: [
      { nodes: ['a'], title: 'Api', firstNodeId: 'a', pathId: null, branch: null },
      { nodes: ['b'], title: 'Ui', firstNodeId: 'b', pathId: null, branch: null },
    ] }],
  }
}
const card = (id: string): HTMLElement | null => canvas().querySelector<HTMLElement>(`[data-step="${id}"]`)
const view = (): { x: number; y: number; scale: number } => {
  const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(canvas().style.transform)!
  return { x: Number(x), y: Number(y), scale: Number(scale) }
}
const tap = (element: HTMLElement): void => {
  for (const type of ['pointerdown', 'pointerup']) element.dispatchEvent(new window.PointerEvent(type, { pointerId: 2, clientX: 5, clientY: 5, button: 0, bubbles: true }))
  element.click()
}
const screenX = (id: string): number => view().x + parseFloat(card(id)!.style.left) * view().scale

test('a finished section shows as one box; the ticker updates the working step by id, not by position', async () => {
  stageSize.width = 1000
  const stream = openStream()
  stream.send({ runs: [forkedRun('F')], jobs: [] })
  expect(card('a')).toBeNull()
  expect(card('section:split')!.querySelector('strong')!.textContent).toBe('Parallel · Api + Ui')
  expect(card('section:split')!.querySelector('small')!.textContent).toBe('Done · 1m 00s')
  await Bun.sleep(1100)
  expect(card('review')!.querySelector('small')!.textContent).toMatch(/^Working · \d+h \d{2}m$/)
  expect(card('section:split')!.querySelector('small')!.textContent).toBe('Done · 1m 00s')
  expect(card('join')).toBeNull()
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('clicking the box expands the section in place with a Collapse button; Collapse folds it back', () => {
  stageSize.width = 1000
  const stream = openStream()
  stream.send({ runs: [forkedRun('E')], jobs: [] })
  const before = screenX('section:split')
  tap(card('section:split')!)
  expect(card('section:split')).toBeNull()
  expect([card('a'), card('b'), card('join')].every(Boolean)).toBe(true)
  expect(canvas().querySelectorAll('.flow-band')).toHaveLength(2)
  expect(Math.abs(screenX('a') - before)).toBeLessThan(0.5)
  expect(document.querySelector('.flow-zoom [aria-pressed]')!.getAttribute('aria-pressed')).toBe('false')
  stream.send({ runs: [{ ...forkedRun('E'), updatedAt: 51 }], jobs: [] })
  expect(card('a')).not.toBeNull()
  const collapse = canvas().querySelector<HTMLButtonElement>('.flow-band button')!
  expect(collapse.textContent).toBe('Collapse')
  tap(collapse)
  expect(card('section:split')).not.toBeNull()
  expect(canvas().querySelectorAll('.flow-band')).toHaveLength(0)
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

const twoSteps = (id: string, secondState: 'running' | 'settled' = 'running'): RunView => ({
  ...run(id, 60), entry: 'plan', currentNodeId: 'build',
  nodes: [{ id: 'plan', title: 'Plan', kind: 'plan', engine: 'claude' }, { id: 'build', title: 'Build', kind: 'implement', engine: 'codex' }, { id: 'ship', title: 'Ship', kind: 'task', engine: 'claude' }],
  edges: [{ source: 'plan', target: 'build', outcome: 'pass' }, { source: 'build', target: 'ship', outcome: 'pass' }],
  attempts: [
    { nodeId: 'plan', number: 0, jobId: 'job-plan', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 0, endedAt: 1000, pathId: 'main', from: [], subAgents: 0 },
    { nodeId: 'build', number: 1, jobId: 'job-build', status: secondState, outcome: secondState === 'settled' ? 'pass' : null, summary: null, startedAt: 1000, endedAt: secondState === 'settled' ? 2000 : null, pathId: 'main', from: [0], subAgents: 0 },
  ],
  tokens: secondState === 'settled' ? [{ nodeId: 'ship', pathId: 'main', state: 'ready', from: [1] }] : [{ nodeId: 'build', pathId: 'main', state: 'working', from: [0] }],
})
const opened = (): string[] => {
  const jobs: string[] = []
  addEventListener('quiet:agent-open', (event) => jobs.push((event as CustomEvent<{ jobId: string }>).detail.jobId))
  return jobs
}

test('a step that ran is a button named for its agent; clicking or pressing Enter opens its job', () => {
  stageSize.width = 1000
  const jobs = opened()
  const stream = openStream()
  stream.send({ runs: [twoSteps('C')], jobs: [] })
  const plan = card('plan')!
  expect([plan.getAttribute('role'), plan.getAttribute('tabindex'), plan.getAttribute('title')]).toEqual(['button', '0', 'Plan'])
  expect(plan.getAttribute('aria-label')).toBe('Plan, Done · 1s, open its agent')
  expect(card('ship')!.hasAttribute('tabindex')).toBe(false)
  expect(canvas().querySelector('.flow-run')!.getAttribute('role')).toBe('group')
  tap(plan)
  card('build')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  card('build')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  tap(card('ship')!)
  expect(jobs).toEqual(['job-plan', 'job-build', 'job-build'])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('a drag that starts on a step pans and opens nothing', () => {
  stageSize.width = 1000
  const jobs = opened()
  const stream = openStream()
  stream.send({ runs: [twoSteps('D')], jobs: [] })
  const plan = card('plan')!
  for (const [type, clientX] of [['pointerdown', 100], ['pointermove', 120], ['pointerup', 120]] as const) plan.dispatchEvent(new window.PointerEvent(type, { pointerId: 3, clientX, clientY: 60, button: 0, bubbles: true }))
  plan.click()
  expect(jobs).toEqual([])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('the focused step keeps focus when the graph repaints', () => {
  stageSize.width = 1000
  const stream = openStream()
  stream.send({ runs: [twoSteps('R')], jobs: [] })
  card('plan')!.focus()
  stream.send({ runs: [{ ...twoSteps('R', 'settled'), updatedAt: 61 }], jobs: [] })
  expect(card('build')!.dataset.state).toBe('done')
  expect((document.activeElement as HTMLElement).dataset.step).toBe('plan')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('a collapsed section is a button that says it is collapsed', () => {
  stageSize.width = 1000
  const stream = openStream()
  stream.send({ runs: [forkedRun('X')], jobs: [] })
  const box = card('section:split')!
  expect([box.getAttribute('role'), box.getAttribute('tabindex'), box.getAttribute('aria-expanded')]).toEqual(['button', '0', 'false'])
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(card('section:split')).toBeNull()
  expect(card('a')).not.toBeNull()
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('Open in Studio sends the showing run to Studio', () => {
  stageSize.width = 1000
  const runs: string[] = []
  addEventListener('quiet:studio-run', (event) => runs.push((event as CustomEvent<{ runId: string }>).detail.runId))
  const stream = openStream()
  stream.send({ runs: [twoSteps('S1')], jobs: [] })
  const studio = document.getElementById('flow-studio') as HTMLButtonElement
  expect(studio.hidden).toBe(false)
  studio.click()
  expect(runs).toEqual(['S1'])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('a step whose job is gone says so on its own line and leaves the approval banner alone', () => {
  stageSize.width = 1000
  const stream = openStream()
  const waiting: RunView = { ...twoSteps('M'), status: 'awaiting-approval', versions: [{ ...run('M', 60).versions[0]!, state: 'pending', approvedVia: null }] }
  stream.send({ runs: [waiting], jobs: [] })
  const approve = buttonNamed('Approve and run')
  dispatchEvent(new CustomEvent('quiet:agent-open-missing', { detail: { jobId: 'job-plan' } }))
  const notice = document.querySelector<HTMLElement>('.flow-notice')!
  expect([notice.hidden, notice.textContent]).toEqual([false, "That step’s job is no longer available."])
  expect(buttonNamed('Approve and run')).toBe(approve)
  expect(bannerText()).toContain('Nothing runs until you approve')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

let captured: number | null = null
Object.assign(flowStage, { setPointerCapture: (id: number) => { captured = id }, releasePointerCapture: () => { captured = null } })
const press = (element: HTMLElement): void => {
  captured = null
  const at = { pointerId: 4, clientX: 5, clientY: 5, button: 0, bubbles: true }
  element.dispatchEvent(new window.PointerEvent('pointerdown', at))
  const target = captured === null ? element : flowStage
  target.dispatchEvent(new window.PointerEvent('pointerup', at))
  target.click()
}

test('a press on Collapse that does not move reaches the button and folds the section', () => {
  stageSize.width = 1000
  const stream = openStream()
  stream.send({ runs: [forkedRun('P1')], jobs: [] })
  press(card('section:split')!)
  expect(card('a')).not.toBeNull()
  press(canvas().querySelector<HTMLElement>('[data-collapse]')!)
  expect(card('section:split')).not.toBeNull()
  expect(card('a')).toBeNull()
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('a press on a step that does not move opens its job', () => {
  stageSize.width = 1000
  const jobs = opened()
  const stream = openStream()
  stream.send({ runs: [twoSteps('P2')], jobs: [] })
  press(card('plan')!)
  expect(jobs).toEqual(['job-plan'])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

const progressed = (id: string, count: number, working: number): RunView => {
  const base = chain(id, count, working)
  const attempts = Array.from({ length: working + 1 }, (_, index) => ({ nodeId: `s${index + 1}`, number: index, jobId: `job-${index + 1}`, status: index === working ? 'running' : 'settled', outcome: index === working ? null : 'pass' as const, summary: null, startedAt: index * 1000, endedAt: index === working ? null : index * 1000 + 500 }))
  return { ...base, attempts }
}
const following = (): string | null => document.querySelector('[data-zoom="follow"]')!.getAttribute('aria-pressed')

test('a focused step that the flow leaves off-screen keeps focus without turning Follow off; a real focus still follows it', () => {
  stageSize.width = 300
  const stream = openStream()
  stream.send({ runs: [progressed('F2', 8, 0)], jobs: [] })
  card('s1')!.focus()
  expect(following()).toBe('true')
  stream.send({ runs: [{ ...progressed('F2', 8, 7), updatedAt: 41 }], jobs: [] })
  expect((document.activeElement as HTMLElement).dataset.step).toBe('s1')
  expect(following()).toBe('true')
  card('s1')!.blur()
  card('s1')!.focus()
  expect(following()).toBe('false')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('closing the drawer clears the job-gone notice and its timer', () => {
  stageSize.width = 1000
  const stream = openStream()
  stream.send({ runs: [twoSteps('N')], jobs: [] })
  const [realSet, realClear] = [globalThis.setTimeout, globalThis.clearTimeout]
  const delays = new Map<unknown, number | undefined>()
  const cleared: unknown[] = []
  globalThis.setTimeout = ((handler: () => void, ms?: number) => { const id = realSet(handler, ms); delays.set(id, ms); return id }) as typeof setTimeout
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { cleared.push(id); realClear(id) }) as typeof clearTimeout
  try {
    dispatchEvent(new CustomEvent('quiet:agent-open-missing', { detail: { jobId: 'job-plan' } }))
    const noticeTimer = [...delays].find(([, ms]) => ms === 4000)![0]
    dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
    expect(cleared).toContain(noticeTimer)
    expect(document.querySelector<HTMLElement>('.flow-notice')!.hidden).toBe(true)
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
})

const waitingInSession = (id: string): RunView => ({
  ...run(id, 50),
  attempts: [{ nodeId: 'plan', number: 0, jobId: null, status: 'running', outcome: null, summary: null, startedAt: Date.now() - 5_000, endedAt: null, pathId: 'main', from: [], subAgents: 0, inSession: true }],
})
const remindButton = (): HTMLButtonElement => buttonNamed('Remind Claude') ?? buttonNamed('Reminded')

test('a step waiting In Session shows its own state on the card and in the banner mark, with a Remind button', () => {
  sent.length = 0
  const stream = openStream()
  stream.send({ runs: [waitingInSession('S1')], jobs: [] })
  const card = document.querySelector<HTMLElement>('.flow-step[data-step="plan"]')!
  expect(card.dataset.state).toBe('session')
  expect(card.querySelector('small')!.textContent).toMatch(/^In Session · \d+s$/)
  expect(document.querySelector<HTMLElement>('#flow-banner .flow-mark')!.dataset.state).toBe('session')
  expect(bannerText()).toBe('Plan is being done In Session by Claude. Talk to it here; the flow continues when it reports the step.')
  expect(buttonNamed('Remind Claude')).toBeDefined()
  expect(sent).toEqual([])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('Remind posts to the waiting step, is busy while posting, then says Reminded for 4 s', async () => {
  sent.length = 0
  const stream = openStream()
  stream.send({ runs: [waitingInSession('S2')], jobs: [] })
  const [realSet, realClear] = [globalThis.setTimeout, globalThis.clearTimeout]
  const timers = new Map<unknown, { handler: () => void; ms?: number }>()
  const cleared: unknown[] = []
  globalThis.setTimeout = ((handler: () => void, ms?: number) => { const id = realSet(handler, ms === 4000 ? 60_000 : ms); timers.set(id, { handler, ms }); return id }) as typeof setTimeout
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { cleared.push(id); realClear(id) }) as typeof clearTimeout
  try {
    let release: (response: Response) => void = () => {}
    respond = () => new Promise(resolve => { release = resolve })
    const remind = remindButton()
    remind.click()
    expect([remind.disabled, remind.getAttribute('aria-busy')]).toEqual([true, 'true'])
    release(json(200, waitingInSession('S2')))
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(sent).toEqual([{ url: '/api/studio/runs/S2/steps/plan/remind', method: 'POST', body: {} }])
    expect(remindButton().textContent).toBe('Reminded')
    expect(remindButton().hasAttribute('aria-busy')).toBe(false)
    const [timerId, timer] = [...timers].find(([, entry]) => entry.ms === 4000)!
    stream.send({ runs: [{ ...waitingInSession('S2'), updatedAt: 99 }], jobs: [] })
    expect(remindButton().textContent).toBe('Reminded')
    timer.handler()
    expect(remindButton().textContent).toBe('Remind Claude')
    expect(remindButton().disabled).toBe(false)
    respond = ok
    remindButton().click()
    await Bun.sleep(0)
    await Bun.sleep(0)
    const [secondId] = [...timers].filter(([, entry]) => entry.ms === 4000).at(-1)!
    expect(secondId).not.toBe(timerId)
    dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
    expect(cleared).toContain(secondId)
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    respond = ok
    dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
  }
})

test('a refused Remind says why in the banner and frees the button', async () => {
  sent.length = 0
  const stream = openStream()
  stream.send({ runs: [waitingInSession('S3')], jobs: [] })
  respond = () => json(409, { error: 'That step is not waiting for the session' })
  const remind = remindButton()
  remind.click()
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(sent).toEqual([{ url: '/api/studio/runs/S3/steps/plan/remind', method: 'POST', body: {} }])
  expect(bannerText()).toBe('Could not remind: That step is not waiting for the session')
  expect([remind.textContent, remind.disabled]).toEqual(['Remind Claude', false])
  respond = ok
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

const watchedJobs = (): unknown[] => {
  const shown: unknown[] = []
  addEventListener('quiet:job-watch', (event) => shown.push((event as CustomEvent).detail))
  return shown
}
const term = (): HTMLElement => document.getElementById('flow-term')!
const watchRun = (detail: { runId: string; jobId?: string }): FakeSource => {
  window.localStorage.setItem('mc.motion.paused', 'true')
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: true }))
  dispatchEvent(new CustomEvent('quiet:flow-watch', { detail }))
  return streams.at(-1)!
}

test('watching a run streams just that run and shows the working step in the terminal pane', () => {
  stageSize.width = 1000
  const shown = watchedJobs()
  const jobs = opened()
  const stream = watchRun({ runId: 'W1' })
  expect(stream.url).toBe('/api/studio/events?run=W1')
  stream.send({ runs: [twoSteps('W1')], jobs: [] })
  expect(term().hidden).toBe(false)
  expect(shown.at(-1)).toEqual({ jobId: 'job-build', title: 'Build', engine: 'codex' })
  expect(card('build')!.hasAttribute('data-watched')).toBe(true)
  tap(card('plan')!)
  expect(shown.at(-1)).toEqual({ jobId: 'job-plan', title: 'Plan', engine: 'claude' })
  expect(card('plan')!.hasAttribute('data-watched')).toBe(true)
  expect(card('build')!.hasAttribute('data-watched')).toBe(false)
  tap(card('ship')!)
  expect(shown.at(-1)).toEqual({ jobId: null, title: 'Ship', engine: 'claude' })
  card('build')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(shown.at(-1)).toEqual({ jobId: 'job-build', title: 'Build', engine: 'codex' })
  expect(jobs).toEqual([])
  const count = shown.length
  stream.send({ runs: [{ ...twoSteps('W1'), updatedAt: 99 }], jobs: [] })
  expect(shown).toHaveLength(count)
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('while following, the pane moves on to the step that starts next and counts its attempts', () => {
  stageSize.width = 1000
  const shown = watchedJobs()
  const stream = watchRun({ runId: 'W2' })
  stream.send({ runs: [twoSteps('W2')], jobs: [] })
  const retried = twoSteps('W2', 'settled')
  retried.attempts = [...retried.attempts, { ...retried.attempts[1]!, number: 2, jobId: 'job-build-2', status: 'running', outcome: null, endedAt: null, from: [1] }]
  stream.send({ runs: [retried], jobs: [] })
  expect(shown.at(-1)).toEqual({ jobId: 'job-build-2', title: 'Build · attempt 2', engine: 'codex' })
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('watching with a job named shows that job first', () => {
  stageSize.width = 1000
  const shown = watchedJobs()
  const stream = watchRun({ runId: 'W3', jobId: 'job-plan' })
  stream.send({ runs: [twoSteps('W3')], jobs: [] })
  expect(shown.at(-1)).toEqual({ jobId: 'job-plan', title: 'Plan', engine: 'claude' })
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('a watched job that was resumed after ending without MC_RESULT follows to the resumed job', () => {
  stageSize.width = 1000
  const shown = watchedJobs()
  const stream = watchRun({ runId: 'W5', jobId: 'job-build' })
  const base = twoSteps('W5')
  const resumed = { ...base, attempts: base.attempts.map(attempt => attempt.nodeId === 'build' ? { ...attempt, jobId: 'job-build-resumed', nudgedFrom: 'job-build' } : attempt) }
  stream.send({ runs: [resumed], jobs: [] })
  expect(shown.at(-1)).toEqual({ jobId: 'job-build-resumed', title: 'Build', engine: 'codex' })
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('going back to a session flow hides the terminal pane and steps open the agent again', () => {
  stageSize.width = 1000
  const stream = watchRun({ runId: 'W4' })
  stream.send({ runs: [twoSteps('W4')], jobs: [] })
  dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: { id: 'terminal-9', cwd: '/x' } }))
  const scoped = streams.at(-1)!
  expect(scoped.url).toBe('/api/studio/events?terminal=terminal-9')
  scoped.send({ runs: [twoSteps('T9')], jobs: [] })
  expect(term().hidden).toBe(true)
  const jobs = opened()
  tap(card('plan')!)
  expect(jobs).toEqual(['job-plan'])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('in watch mode every step is a button that says it shows its output', () => {
  stageSize.width = 1000
  const stream = watchRun({ runId: 'W5' })
  stream.send({ runs: [twoSteps('W5')], jobs: [] })
  expect(card('plan')!.getAttribute('aria-label')).toBe('Plan, Done · 1s, show its output')
  expect([card('ship')!.getAttribute('role'), card('ship')!.getAttribute('tabindex')]).toEqual(['button', '0'])
  expect(card('ship')!.getAttribute('aria-label')).toMatch(/, show its output$/)
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('the step terminal is told to stop when its pane hides', () => {
  stageSize.width = 1000
  const shown = watchedJobs()
  const stream = watchRun({ runId: 'W6' })
  stream.send({ runs: [twoSteps('W6')], jobs: [] })
  expect(shown.at(-1)).not.toBeNull()
  dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: 'chat-6' }))
  expect(shown.at(-1)).toBeNull()
  expect(term().hidden).toBe(true)
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})

test('closing the drawer stops the step terminal and gives the drawer back to the session it showed before', () => {
  stageSize.width = 1000
  dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: { id: 'terminal-7', cwd: '/x' } }))
  const shown = watchedJobs()
  const stream = watchRun({ runId: 'W7' })
  stream.send({ runs: [twoSteps('W7')], jobs: [] })
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
  expect(stream.closed).toBe(true)
  expect(shown.at(-1)).toBeNull()
  const count = streams.length
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: true }))
  expect(streams).toHaveLength(count + 1)
  expect(streams.at(-1)!.url).toBe('/api/studio/events?terminal=terminal-7')
  streams.at(-1)!.send({ runs: [twoSteps('T7')], jobs: [] })
  expect(term().hidden).toBe(true)
  const jobs = opened()
  tap(card('plan')!)
  expect(jobs).toEqual(['job-plan'])
  dispatchEvent(new CustomEvent('quiet:flow-open', { detail: false }))
})
