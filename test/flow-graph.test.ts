import { afterAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
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
