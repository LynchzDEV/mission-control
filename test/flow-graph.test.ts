import { expect, test } from 'bun:test'
import { graphLayout, renderFlowGraph } from '../client/flow-graph'

test('graph layout places columns left to right, centres short columns and links every neighbour pair', () => {
  const layout = graphLayout([[{ title: 'Direction' }], [{ title: 'a' }, { title: 'b' }], [{ title: 'Your review' }]])
  expect(layout.nodes).toHaveLength(4)
  expect(layout.edges).toHaveLength(4)
  const [direction, a, b, review] = layout.nodes
  expect(direction!.x).toBe(0)
  expect(a!.x).toBe(232)
  expect(b!.x).toBe(232)
  expect(review!.x).toBe(464)
  expect(a!.y).toBeLessThan(b!.y)
  expect(direction!.y).toBe((a!.y + b!.y) / 2)
  expect(layout.width).toBe(632)
  expect(layout.height).toBe(142)
})

test('a single column has no edges and keeps given keys', () => {
  const layout = graphLayout([[{ key: 'direction', title: 'Direction' }, { title: 'Other' }]])
  expect(layout.edges).toHaveLength(0)
  expect(layout.nodes[0]!.key).toBe('direction')
  expect(layout.width).toBe(168)
})

test('edges connect column i to column i + 1 by key', () => {
  const layout = graphLayout([[{ key: 'd', title: 'D' }], [{ key: 'x', title: 'X' }, { key: 'y', title: 'Y' }]])
  expect(layout.edges).toEqual([{ from: 'd', to: 'x' }, { from: 'd', to: 'y' }])
})

test('an empty flow lays out nothing', () => {
  expect(graphLayout([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
})

test('repainting identical columns keeps the rendered graph element', () => {
  const make = (): any => ({ children: [] as any[], dataset: {} as Record<string, string>, style: { setProperty() {} }, get firstChild() { return this.children[0] ?? null }, append(...nodes: any[]) { this.children.push(...nodes) }, replaceChildren(...nodes: any[]) { this.children = nodes }, setAttribute() {} })
  ;(globalThis as any).document = { createElement: make, createElementNS: make }
  const columns = [[{ key: 'd', title: 'Direction', status: 'done', detail: 'Decided' }], [{ key: 'w', title: 'Codex work', status: 'active', detail: 'Working', assignee: 'codex' }]]
  const host = make()
  renderFlowGraph(host, columns, { animate: false })
  const first = host.children[0]
  renderFlowGraph(host, structuredClone(columns), { animate: false })
  expect(host.children[0]).toBe(first)
  renderFlowGraph(host, [columns[0]!, [{ ...columns[1]![0]!, detail: 'Finished', status: 'done' }]], { animate: false })
  expect(host.children[0]).not.toBe(first)
  delete (globalThis as any).document
})
