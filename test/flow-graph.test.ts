import { afterAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunView } from '../server/run-view'
import { forkSections, workflowSchema, type Workflow } from '../server/workflows'
import { COL_STEP, ROW_STEP, STEP_H, STEP_W, layoutRun, renderRunGraph, routeEdge, type GraphEdge, type GraphStep } from '../client/flow-graph'

const { window } = new JSDOM('')
Object.assign(globalThis, { window, document: window.document })
afterAll(() => { window.close(); Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'document') })

const ids = (...names: string[]) => names.map(id => ({ id }))

test('a straight pass chain runs left to right on one row', () => {
  const layout = layoutRun(ids('plan', 'verify', 'build', 'review'), [{ source: 'plan', target: 'verify', outcome: 'pass' }, { source: 'verify', target: 'build', outcome: 'pass' }, { source: 'build', target: 'review', outcome: 'pass' }], 'plan')
  expect(layout.placed.map(step => [step.id, step.x, step.y])).toEqual([['plan', 0, 0], ['verify', COL_STEP, 0], ['build', 2 * COL_STEP, 0], ['review', 3 * COL_STEP, 0]])
  expect(layout.width).toBe(3 * COL_STEP + STEP_W)
  expect(layout.height).toBe(STEP_H)
})

test('a step reached only on failure sits under its source; its way back is an up edge', () => {
  const edges = [{ source: 'review', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'review', outcome: 'pass' }, { source: 'review', target: 'done', outcome: 'pass' }]
  const layout = layoutRun(ids('review', 'fix', 'done'), edges, 'review')
  const at = Object.fromEntries(layout.placed.map(step => [step.id, step]))
  expect([at.fix!.x, at.fix!.y]).toEqual([0, ROW_STEP])
  expect([at.done!.x, at.done!.y]).toEqual([COL_STEP, 0])
  expect(routeEdge(at.review!, at.fix!).shape).toBe('down')
  expect(routeEdge(at.fix!, at.review!).shape).toBe('up')
})

test('a retry loop to an earlier column is drawn as a back arc below both steps', () => {
  const layout = layoutRun(ids('build', 'test'), [{ source: 'build', target: 'test', outcome: 'pass' }, { source: 'test', target: 'build', outcome: 'fail' }], 'build')
  const [build, testStep] = layout.placed
  const route = routeEdge(testStep!, build!)
  expect(route.shape).toBe('back')
  expect(route.d).toContain(String(STEP_H + 26))
})

test('unreachable steps still get a place instead of being dropped', () => {
  const layout = layoutRun(ids('a', 'orphan'), [], 'a')
  expect(layout.placed.map(step => step.id)).toEqual(['a', 'orphan'])
})

test('render draws one step per node and one route per edge, with states', () => {
  const host = document.createElement('div')
  renderRunGraph(host, [
    { id: 'plan', title: 'Plan', detail: 'Done · 2m 10s', state: 'done', engine: 'claude', kind: 'plan' },
    { id: 'build', title: 'Build', detail: 'Try 2 · 48s', state: 'active', engine: 'codex', kind: 'implement', since: 1 },
  ], [{ source: 'plan', target: 'build', outcome: 'pass', state: 'flowing' }], 'plan', { animate: false })
  expect([...host.querySelectorAll('.flow-step')].map(step => (step as HTMLElement).dataset.state)).toEqual(['done', 'active'])
  expect(host.querySelectorAll('path.flow-route[data-state="flowing"]')).toHaveLength(1)
  expect(host.querySelector('.flow-step img')!.getAttribute('src')).toBe('/providers/claude.svg')
  expect(host.querySelector('[data-since]')).not.toBeNull()
})

test('a proposed step and its proposed route render as proposed, with their own arrow tip', () => {
  const host = document.createElement('div')
  renderRunGraph(host, [
    { id: 'build', title: 'Build API', detail: 'Working · 10s', state: 'active', engine: 'codex', kind: 'implement' },
    { id: 'migrate', title: 'DB migration', detail: 'Proposed', state: 'proposed', engine: 'claude', kind: 'implement' },
  ], [{ source: 'build', target: 'migrate', outcome: 'pass', state: 'proposed' }], 'build', { animate: false })
  const proposed = host.querySelector<HTMLElement>('.flow-step[data-state="proposed"]')!
  expect(proposed.querySelector('strong')!.textContent).toBe('DB migration')
  expect(proposed.querySelector<HTMLElement>('.flow-mark')!.dataset.state).toBe('proposed')
  const route = host.querySelector('path.flow-route[data-state="proposed"]')!
  expect(route.getAttribute('marker-end')).toBe('url(#flow-tip-proposed)')
  expect(host.querySelector('#flow-tip-proposed')).not.toBeNull()
})

test('a join sits right of every path that leads into it, and the steps after it move with it', () => {
  const steps = [...ids('split', 'a1', 'a2', 'b'), { id: 'join', kind: 'join' }, ...ids('review', 'fix')]
  const edges = [{ source: 'split', target: 'a1', outcome: 'pass' }, { source: 'split', target: 'b', outcome: 'pass' }, { source: 'a1', target: 'a2', outcome: 'pass' }, { source: 'a2', target: 'join', outcome: 'pass' }, { source: 'b', target: 'join', outcome: 'pass' }, { source: 'join', target: 'review', outcome: 'pass' }, { source: 'review', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'a1', outcome: 'pass' }]
  const at = Object.fromEntries(layoutRun(steps, edges, 'split').placed.map(step => [step.id, step]))
  expect([at.a1!.x, at.b!.x, at.a2!.x]).toEqual([COL_STEP, COL_STEP, 2 * COL_STEP])
  expect([at.join!.x, at.join!.y]).toEqual([3 * COL_STEP, 0])
  expect([at.review!.x, at.fix!.x, at.fix!.y]).toEqual([4 * COL_STEP, 4 * COL_STEP, ROW_STEP])
})

test('a join step draws the join glyph instead of an engine logo', () => {
  const host = document.createElement('div')
  renderRunGraph(host, [{ id: 'join', title: 'Join', detail: 'Waiting for 1 of 2 paths', state: 'pending', engine: '', kind: 'join' }], [], 'join', { animate: false })
  expect(host.querySelector('.flow-step img')).toBeNull()
  expect(host.querySelector('.flow-step svg.flow-step-glyph circle')).not.toBeNull()
})

test('a paint reports the graph size and the box Follow aims at: working steps, else the failed step, else the entry', () => {
  const host = document.createElement('div')
  const step = (id: string, state: GraphStep['state']): GraphStep => ({ id, title: id, detail: '', state, engine: 'claude', kind: 'task' })
  const edges: GraphEdge[] = [{ source: 'a', target: 'b', outcome: 'pass', state: 'idle' }, { source: 'a', target: 'c', outcome: 'pass', state: 'idle' }, { source: 'b', target: 'd', outcome: 'pass', state: 'idle' }]
  const working = renderRunGraph(host, [step('a', 'done'), step('b', 'active'), step('c', 'active'), step('d', 'pending')], edges, 'a', { animate: false })
  expect(working).toEqual({ width: 2 * COL_STEP + STEP_W, height: ROW_STEP + STEP_H, focus: { x: COL_STEP, y: 0, width: STEP_W, height: ROW_STEP + STEP_H } })
  expect(renderRunGraph(host, [step('a', 'done'), step('b', 'active'), step('c', 'active'), step('d', 'pending')], edges, 'a', { animate: false })).toEqual(working)
  expect(renderRunGraph(host, [step('a', 'done'), step('b', 'done'), step('c', 'failed'), step('d', 'pending')], edges, 'a', { animate: false }).focus).toEqual({ x: COL_STEP, y: ROW_STEP, width: STEP_W, height: STEP_H })
  expect(renderRunGraph(host, [step('a', 'pending'), step('b', 'pending'), step('c', 'pending'), step('d', 'pending')], edges, 'a', { animate: false }).focus).toEqual({ x: 0, y: 0, width: STEP_W, height: STEP_H })
})

test('a back edge makes room below the graph for its dip and label', () => {
  const host = document.createElement('div')
  const step = (id: string): GraphStep => ({ id, title: id, detail: '', state: 'pending', engine: 'claude', kind: 'task' })
  const frame = renderRunGraph(host, [step('build'), step('test')], [{ source: 'build', target: 'test', outcome: 'pass', state: 'idle' }, { source: 'test', target: 'build', outcome: 'fail', state: 'idle', label: 'if test fails' }], 'build', { animate: false })
  expect(frame.height).toBeGreaterThanOrEqual(STEP_H + 26 + 10)
})

type Rect = { x: number; y: number; width: number; height: number }
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const contains = (outer: Rect, inner: Rect): boolean => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height
const bigFlow = workflowSchema.parse(JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/big-flow.json'), 'utf8')))
const waitingSections = (graph: Workflow): RunView['sections'] => forkSections(graph).map(section => ({
  fork: section.fork, join: section.join, state: 'waiting', joined: [],
  paths: section.paths.map(nodes => ({ nodes, title: graph.nodes.find(node => node.id === nodes[0])!.title, firstNodeId: nodes[0]!, pathId: null, branch: null })),
}))
const LABEL_H = 18

test('the big flow lays out in rank columns with lanes: no card overlaps another, a band or label; bands of different paths never overlap', () => {
  const layout = layoutRun(bigFlow.nodes, bigFlow.edges, bigFlow.entry, waitingSections(bigFlow))
  const at = Object.fromEntries(layout.placed.map(place => [place.id, place]))
  const cards = layout.placed.map(place => ({ id: place.id, x: place.x, y: place.y, width: STEP_W, height: STEP_H }))
  for (const [index, card] of cards.entries()) for (const other of cards.slice(index + 1)) expect([card.id, other.id, overlaps(card, other)]).toEqual([card.id, other.id, false])
  expect(layout.bands.map(band => band.key)).toEqual(['split:0', 'split:1', 'split2:0', 'split2:1', 'ui-split:0', 'ui-split:1'])
  for (const [index, band] of layout.bands.entries()) for (const other of layout.bands.slice(index + 1)) {
    if (contains(band, other) || contains(other, band)) continue
    expect([band.key, other.key, overlaps(band, other)]).toEqual([band.key, other.key, false])
  }
  for (const band of layout.bands) for (const card of cards) expect([band.key, card.id, overlaps({ x: band.x, y: band.y, width: band.width, height: LABEL_H }, card)]).toEqual([band.key, card.id, false])
  expect([at.review!.y, at.split2!.y, at.notify!.y, at.join!.y]).toEqual([at.plan!.y, at.plan!.y, at.plan!.y, at.plan!.y])
  expect(at.join!.x).toBeGreaterThan(Math.max(at['api-tests']!.x, at['ui-check']!.x))
  expect([at.api!.y, at.docs!.y]).toEqual([at.plan!.y, at.plan!.y])
  expect(at['api-fix']!.x).toBe(at['api-tests']!.x)
  expect(at['merge-fix']!.x).toBe(at.join!.x)
  for (const band of layout.bands) expect(band.x + band.width <= layout.width && band.y >= 0 && band.y + band.height <= layout.height).toBe(true)
  expect(Math.min(...layout.placed.map(place => place.y))).toBeGreaterThanOrEqual(LABEL_H)
})

test('a path band holds its steps and a nested band sits inside its path band', () => {
  const layout = layoutRun(bigFlow.nodes, bigFlow.edges, bigFlow.entry, waitingSections(bigFlow))
  const band = (key: string) => layout.bands.find(item => item.key === key)!
  const card = (id: string) => { const place = layout.placed.find(item => item.id === id)!; return { x: place.x, y: place.y, width: STEP_W, height: STEP_H } }
  for (const id of ['api', 'api-tests', 'api-fix']) expect(contains(band('split:0'), card(id))).toBe(true)
  for (const id of ['ui', 'ui-split', 'ui-join', 'ui-check', 'ui-copy', 'ui-style']) expect(contains(band('split:1'), card(id))).toBe(true)
  expect(contains(band('split:1'), band('ui-split:0'))).toBe(true)
  expect(contains(band('split:1'), band('ui-split:1'))).toBe(true)
  expect(band('split:0').label).toBe('Api path')
})

test('a back edge dips below the lowest band it spans and the graph makes room for it', () => {
  const graph = { ...bigFlow, edges: [...bigFlow.edges.filter(edge => !(edge.source === 'review' && edge.outcome === 'fail')), { source: 'review', target: 'plan', outcome: 'fail' as const }] }
  const layout = layoutRun(graph.nodes, graph.edges, graph.entry, waitingSections(graph))
  const at = Object.fromEntries(layout.placed.map(place => [place.id, place]))
  const lowest = Math.max(...layout.bands.filter(band => band.key.startsWith('split:')).map(band => band.y + band.height))
  const route = routeEdge(at.review!, at.plan!, layout.bands)
  expect(route.shape).toBe('back')
  const dip = Number(/C\S+ (\S+)/.exec(route.d)![1])
  expect(dip).toBeGreaterThan(lowest)
  expect(layout.height).toBeGreaterThanOrEqual(dip + 10)
})

test('bands render behind the routes with their label and branch, and cards carry their step id', () => {
  const host = document.createElement('div')
  const sections: RunView['sections'] = [{ fork: 'split', join: 'join', state: 'open', joined: [], paths: [
    { nodes: ['a'], title: 'Api', firstNodeId: 'a', pathId: 'a2-1', branch: 'flow-01234567-a2-1' },
    { nodes: ['b'], title: 'Ui', firstNodeId: 'b', pathId: 'a2-2', branch: 'flow-01234567-a2-2' },
  ] }]
  const step = (id: string, kind = 'task'): GraphStep => ({ id, title: id, detail: '', state: 'pending', engine: kind === 'join' ? '' : 'claude', kind })
  const edge = (source: string, target: string): GraphEdge => ({ source, target, outcome: 'pass', state: 'idle' })
  renderRunGraph(host, [step('split'), step('a'), step('b'), step('join', 'join')], [edge('split', 'a'), edge('split', 'b'), edge('a', 'join'), edge('b', 'join')], 'split', { animate: false, sections })
  const bands = [...host.querySelectorAll<HTMLElement>('.flow-band')]
  expect(bands.map(band => band.textContent)).toEqual(['Api path · flow-01234567-a2-1', 'Ui path · flow-01234567-a2-2'])
  expect(bands[0]!.querySelector('code')!.textContent).toBe('flow-01234567-a2-1')
  expect(host.querySelector('.flow-run')!.firstElementChild!.classList.contains('flow-band')).toBe(true)
  expect([...host.querySelectorAll<HTMLElement>('.flow-step')].map(card => card.dataset.step)).toEqual(['split', 'a', 'b', 'join'])
  const conflict = [{ ...sections[0]!, state: 'conflict' as const, paths: [{ ...sections[0]!.paths[0]!, branch: null }, sections[0]!.paths[1]!] }]
  renderRunGraph(host, [step('split'), step('a'), step('b'), step('join', 'join')], [edge('split', 'a'), edge('split', 'b'), edge('a', 'join'), edge('b', 'join')], 'split', { animate: false, sections: conflict })
  expect([...host.querySelectorAll('.flow-band')].map(band => band.textContent)).toEqual(['Api path', 'Ui path · kept on flow-01234567-a2-2'])
})

test('routes draw in only on the first paint of a run, not when its steps change', () => {
  const drawn: unknown[] = []
  const proto = window.SVGElement.prototype as unknown as Record<string, unknown>
  Object.assign(proto, { getTotalLength: () => 10, animate: (frames: unknown) => { drawn.push(frames) } })
  const host = document.createElement('div')
  const step = (id: string): GraphStep => ({ id, title: id, detail: '', state: 'pending', engine: 'claude', kind: 'task' })
  const edge: GraphEdge = { source: 'a', target: 'b', outcome: 'pass', state: 'idle' }
  renderRunGraph(host, [step('a'), step('b')], [edge], 'a', { animate: true, runId: 'r1' })
  expect(drawn).toHaveLength(1)
  renderRunGraph(host, [step('a'), step('b'), step('c')], [edge], 'a', { animate: true, runId: 'r1' })
  expect(drawn).toHaveLength(1)
  renderRunGraph(host, [step('a'), step('b')], [edge], 'a', { animate: true, runId: 'r2' })
  expect(drawn).toHaveLength(2)
  delete proto.getTotalLength
  delete proto.animate
})
