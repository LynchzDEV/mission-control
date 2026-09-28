export type StepState = 'done' | 'active' | 'failed' | 'pending' | 'conditional'
export type EdgeState = 'done' | 'flowing' | 'failed' | 'idle'
export type GraphStep = { id: string; title: string; detail: string; state: StepState; engine: string; kind: string; since?: number }
export type GraphEdge = { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked'; state: EdgeState; label?: string }
export type Placed = { id: string; x: number; y: number }
export type Route = { source: string; target: string; shape: 'forward' | 'down' | 'up' | 'back'; d: string }

export const STEP_W = 160, STEP_H = 52, COL_STEP = 188, ROW_STEP = 70

const BACK_DIP = 26
const ARROW = 6
const DRAW_MS = 700
const DRAW_STAGGER_MS = 140
const SVG = 'http://www.w3.org/2000/svg'
const EDGE_STATES: EdgeState[] = ['done', 'flowing', 'failed', 'idle']
const GLYPHS: Record<string, string> = {
  join: '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 5.1v5.8M5.4 4.3c3 .6 4.6 1.8 5.1 2.6M5.4 11.7c3-.6 4.6-1.8 5.1-2.6"/>',
  review: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
}

export function layoutRun(steps: { id: string }[], edges: { source: string; target: string; outcome: string }[], entry: string): { placed: Placed[]; width: number; height: number } {
  const column = new Map<string, number>()
  const row = new Map<string, number>()
  const used = new Map<number, number>()
  const place = (id: string, col: number) => { const next = used.get(col) ?? 0; column.set(id, col); row.set(id, next); used.set(col, next + 1) }
  const queue = [entry]
  if (steps.some(step => step.id === entry)) place(entry, 0)
  while (queue.length) {
    const id = queue.shift()!
    const outgoing = edges.filter(edge => edge.source === id).sort((a, b) => Number(a.outcome !== 'pass') - Number(b.outcome !== 'pass'))
    for (const edge of outgoing) {
      if (column.has(edge.target)) continue
      place(edge.target, column.get(id)! + (edge.outcome === 'pass' ? 1 : 0))
      queue.push(edge.target)
    }
  }
  const last = Math.max(-1, ...column.values()) + 1
  for (const step of steps) if (!column.has(step.id)) place(step.id, last)
  const placed = steps.map(step => ({ id: step.id, x: column.get(step.id)! * COL_STEP, y: row.get(step.id)! * ROW_STEP }))
  const width = Math.max(0, ...placed.map(step => step.x + STEP_W))
  const height = Math.max(0, ...placed.map(step => step.y + STEP_H))
  return { placed, width, height }
}

function routeShape(from: Placed, to: Placed): Route['shape'] {
  if (to.x > from.x) return 'forward'
  if (to.x === from.x && to.y > from.y) return 'down'
  if (to.x === from.x && to.y < from.y) return 'up'
  return 'back'
}

export function routeEdge(from: Placed, to: Placed): Route {
  const shape = routeShape(from, to)
  const ends = { source: from.id, target: to.id, shape }
  if (shape === 'forward') {
    const startX = from.x + STEP_W, startY = from.y + STEP_H / 2, endX = to.x, endY = to.y + STEP_H / 2
    const bend = (endX - startX) / 2
    return { ...ends, d: `M${startX} ${startY}C${startX + bend} ${startY} ${endX - bend} ${endY} ${endX} ${endY}` }
  }
  if (shape === 'down') return { ...ends, d: `M${from.x + STEP_W * 0.3} ${from.y + STEP_H}L${to.x + STEP_W * 0.3} ${to.y}` }
  if (shape === 'up') return { ...ends, d: `M${from.x + STEP_W * 0.7} ${from.y}L${to.x + STEP_W * 0.7} ${to.y + STEP_H}` }
  const startX = from.x + STEP_W / 2, endX = to.x + STEP_W / 2
  const dip = Math.max(from.y, to.y) + STEP_H + BACK_DIP
  return { ...ends, d: `M${startX} ${from.y + STEP_H}C${startX} ${dip} ${endX} ${dip} ${endX} ${to.y + STEP_H}` }
}

function labelPoint(from: Placed, to: Placed, shape: Route['shape']): { left: number; top: number } {
  if (shape === 'back') return { left: (from.x + to.x + STEP_W) / 2, top: Math.max(from.y, to.y) + STEP_H + BACK_DIP }
  if (shape === 'forward') return { left: (from.x + STEP_W + to.x) / 2, top: (from.y + to.y + STEP_H) / 2 }
  return { left: from.x + STEP_W + 6, top: (Math.min(from.y, to.y) + Math.max(from.y, to.y) + STEP_H) / 2 }
}

function tipMarker(state: EdgeState): SVGMarkerElement {
  const marker = document.createElementNS(SVG, 'marker')
  marker.id = `flow-tip-${state}`
  for (const [name, value] of Object.entries({ viewBox: `0 0 ${ARROW} ${ARROW}`, refX: String(ARROW), refY: String(ARROW / 2), markerWidth: String(ARROW), markerHeight: String(ARROW), markerUnits: 'userSpaceOnUse', orient: 'auto' })) marker.setAttribute(name, value)
  const tip = document.createElementNS(SVG, 'path')
  tip.setAttribute('d', `M0 0L${ARROW} ${ARROW / 2}L0 ${ARROW}Z`)
  tip.setAttribute('class', 'flow-tip')
  tip.dataset.state = state
  marker.append(tip)
  return marker
}

function stepIcon(step: GraphStep): Element {
  if (step.engine) {
    const logo = document.createElement('img')
    logo.className = 'flow-step-logo'
    logo.src = `/providers/${step.engine}.svg`
    logo.alt = ''
    return logo
  }
  const glyph = document.createElementNS(SVG, 'svg')
  glyph.setAttribute('class', 'flow-step-glyph')
  glyph.setAttribute('viewBox', '0 0 16 16')
  glyph.setAttribute('aria-hidden', 'true')
  glyph.innerHTML = GLYPHS[step.kind === 'review' ? 'review' : 'join']!
  return glyph
}

function stepCard(step: GraphStep, place: Placed): HTMLElement {
  const card = document.createElement('div')
  card.className = 'flow-step'
  card.dataset.state = step.state
  card.dataset.kind = step.kind
  card.setAttribute('role', 'listitem')
  card.style.left = `${place.x}px`
  card.style.top = `${place.y}px`
  const title = document.createElement('strong')
  title.textContent = step.title
  const detail = document.createElement('small')
  detail.textContent = step.detail
  if (step.since !== undefined) detail.dataset.since = String(step.since)
  const mark = document.createElement('span')
  mark.className = 'flow-mark'
  mark.dataset.state = step.state
  card.append(stepIcon(step), title, detail, mark)
  return card
}

function routePath(route: Route, state: EdgeState): SVGPathElement {
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', route.d)
  path.setAttribute('class', 'flow-route')
  path.dataset.state = state
  path.setAttribute('marker-end', `url(#flow-tip-${state})`)
  return path
}

function routeLabel(text: string, state: EdgeState, at: { left: number; top: number }): HTMLElement {
  const label = document.createElement('span')
  label.className = 'flow-route-label'
  label.dataset.state = state
  label.textContent = text
  label.style.left = `${at.left}px`
  label.style.top = `${at.top}px`
  return label
}

function drawIn(paths: SVGPathElement[]): void {
  paths.forEach((path, index) => {
    const length = path.getTotalLength()
    path.animate([{ strokeDasharray: `${length}`, strokeDashoffset: length }, { strokeDasharray: `${length}`, strokeDashoffset: 0 }], { duration: DRAW_MS, delay: index * DRAW_STAGGER_MS, easing: 'ease-out', fill: 'backwards' })
  })
}

export function renderRunGraph(host: HTMLElement, steps: GraphStep[], edges: GraphEdge[], entry: string, options: { animate: boolean }): void {
  const paintSignature = JSON.stringify([options.animate, entry, steps, edges])
  if (host.dataset.sig === paintSignature && host.firstChild) return
  host.dataset.sig = paintSignature
  const stepKeys = steps.map(step => step.id).join('|')
  const shouldDrawIn = options.animate && (host.dataset.graphKeys !== stepKeys || !host.firstChild)
  host.dataset.graphKeys = stepKeys
  if (!steps.length) { host.replaceChildren(); return }

  const layout = layoutRun(steps, edges, entry)
  const places = new Map(layout.placed.map(place => [place.id, place]))
  const graph = document.createElement('div')
  graph.className = options.animate ? 'flow-run' : 'flow-run still'
  graph.style.width = `${layout.width}px`
  graph.style.height = `${layout.height}px`
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'flow-run-edges')
  svg.setAttribute('width', String(layout.width))
  svg.setAttribute('height', String(layout.height))
  svg.setAttribute('aria-hidden', 'true')
  const defs = document.createElementNS(SVG, 'defs')
  defs.append(...EDGE_STATES.map(tipMarker))
  svg.append(defs)

  const drawable = edges.filter(edge => places.has(edge.source) && places.has(edge.target))
  const paths = drawable.map(edge => routePath(routeEdge(places.get(edge.source)!, places.get(edge.target)!), edge.state))
  svg.append(...paths)
  const labels = drawable.filter(edge => edge.label).map(edge => {
    const from = places.get(edge.source)!, to = places.get(edge.target)!
    return routeLabel(edge.label!, edge.state, labelPoint(from, to, routeShape(from, to)))
  })
  graph.append(svg, ...labels, ...steps.map(step => stepCard(step, places.get(step.id)!)))
  host.replaceChildren(graph)
  if (shouldDrawIn) drawIn(paths)
}
