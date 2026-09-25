import type { FlowStep } from './awareness'

type GraphNode = { key: string; x: number; y: number }
type GraphEdge = { from: string; to: string }
type GraphLayout = { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number }

const NODE_WIDTH = 168
const NODE_HEIGHT = 64
const COLUMN_GAP = 64
const ROW_GAP = 14
const ARROW = 6
const DRAW_MS = 700
const DRAW_STAGGER_MS = 140
const SVG = 'http://www.w3.org/2000/svg'
const ENGINE_STRIPES: Record<string, string> = { claude: '#d4a091', glm: '#91b0dc', codex: '#bfd38b' }
const FAILED = new Set(['failed', 'error', 'killed'])

const columnHeight = (count: number): number => count * NODE_HEIGHT + (count - 1) * ROW_GAP

export function graphLayout(columns: { key?: string; title: string }[][]): GraphLayout {
  const filled = columns.filter(column => column.length)
  if (!filled.length) return { nodes: [], edges: [], width: 0, height: 0 }
  const height = Math.max(...filled.map(column => columnHeight(column.length)))
  const keyed = filled.map((column, columnIndex) => column.map((step, row) => ({
    key: step.key ?? `${columnIndex}-${row}`,
    x: columnIndex * (NODE_WIDTH + COLUMN_GAP),
    y: (height - columnHeight(column.length)) / 2 + row * (NODE_HEIGHT + ROW_GAP),
  })))
  const edges = keyed.slice(1).flatMap((column, index) => keyed[index]!.flatMap(from => column.map(to => ({ from: from.key, to: to.key }))))
  return { nodes: keyed.flat(), edges, width: filled.length * NODE_WIDTH + (filled.length - 1) * COLUMN_GAP, height }
}

function edgeState(from: FlowStep, to: FlowStep): string {
  if (to.status === 'active') return 'flowing'
  return from.status === 'done' ? 'done' : 'idle'
}

function arrowMarker(state: string): SVGMarkerElement {
  const marker = document.createElementNS(SVG, 'marker')
  marker.id = `flow-arrow-${state}`
  for (const [name, value] of Object.entries({ viewBox: `0 0 ${ARROW} ${ARROW}`, refX: String(ARROW), refY: String(ARROW / 2), markerWidth: String(ARROW), markerHeight: String(ARROW), markerUnits: 'userSpaceOnUse', orient: 'auto' })) marker.setAttribute(name, value)
  const tip = document.createElementNS(SVG, 'path')
  tip.setAttribute('d', `M0 0L${ARROW} ${ARROW / 2}L0 ${ARROW}Z`)
  tip.setAttribute('class', `flow-arrow ${state}`)
  marker.append(tip)
  return marker
}

function nodeCard(step: FlowStep, place: GraphNode): HTMLElement {
  const card = document.createElement('div')
  card.className = 'flow-node'
  card.dataset.status = FAILED.has(step.status) ? 'failed' : step.status
  card.setAttribute('role', 'listitem')
  card.style.left = `${place.x}px`
  card.style.top = `${place.y}px`
  card.style.setProperty('--stripe', ENGINE_STRIPES[step.assignee ?? ''] ?? 'var(--line)')
  const title = document.createElement('strong')
  title.textContent = step.title
  const detail = document.createElement('small')
  detail.textContent = step.detail
  card.append(title, detail)
  return card
}

export function renderFlowGraph(host: HTMLElement, columns: FlowStep[][], options: { animate: boolean }): void {
  const layout = graphLayout(columns)
  const flat = columns.flat()
  const steps = new Map(layout.nodes.map((place, index) => [place.key, flat[index]!]))
  const places = new Map(layout.nodes.map(place => [place.key, place]))
  const signature = layout.nodes.map(place => place.key).join('|')
  const paintSignature = JSON.stringify([options.animate, layout.nodes.map(place => { const step = steps.get(place.key)!; return [place.key, step.title, step.detail, step.status, step.assignee] }), layout.edges.map(edge => [edge.from, edge.to])])
  if (host.dataset.sig === paintSignature && host.firstChild) return
  host.dataset.sig = paintSignature
  const drawIn = options.animate && (host.dataset.graphKeys !== signature || !host.firstChild)
  host.dataset.graphKeys = signature
  if (!layout.nodes.length) { host.replaceChildren(); return }

  const graph = document.createElement('div')
  graph.className = options.animate ? 'flow-graph' : 'flow-graph still'
  graph.style.width = `${layout.width}px`
  graph.style.height = `${layout.height}px`
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('width', String(layout.width))
  svg.setAttribute('height', String(layout.height))
  svg.setAttribute('aria-hidden', 'true')
  const defs = document.createElementNS(SVG, 'defs')
  defs.append(...['idle', 'done', 'flowing'].map(arrowMarker))
  svg.append(defs)

  const paths = layout.edges.map(edge => {
    const from = places.get(edge.from)!, to = places.get(edge.to)!
    const startX = from.x + NODE_WIDTH, startY = from.y + NODE_HEIGHT / 2, endX = to.x, endY = to.y + NODE_HEIGHT / 2
    const bend = (endX - startX) / 2
    const state = edgeState(steps.get(edge.from)!, steps.get(edge.to)!)
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', `M${startX} ${startY}C${startX + bend} ${startY} ${endX - bend} ${endY} ${endX} ${endY}`)
    path.setAttribute('class', `flow-edge ${state}`)
    path.setAttribute('marker-end', `url(#flow-arrow-${state})`)
    return path
  })
  svg.append(...paths)
  graph.append(svg, ...layout.nodes.map(place => nodeCard(steps.get(place.key)!, place)))
  host.replaceChildren(graph)

  if (!drawIn) return
  paths.forEach((path, index) => {
    const length = path.getTotalLength()
    path.animate([{ strokeDasharray: `${length}`, strokeDashoffset: length }, { strokeDasharray: `${length}`, strokeDashoffset: 0 }], { duration: DRAW_MS, delay: index * DRAW_STAGGER_MS, easing: 'ease-out', fill: 'backwards' })
  })
}
