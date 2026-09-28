import type { RunView } from '../server/run-view'

export type StepState = 'done' | 'active' | 'failed' | 'pending' | 'conditional' | 'proposed' | 'removed'
export type EdgeState = 'done' | 'flowing' | 'failed' | 'idle' | 'proposed'
export type GraphStep = { id: string; title: string; detail: string; state: StepState; engine: string; kind: string; since?: number; jobId?: string }
export type GraphEdge = { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked'; state: EdgeState; label?: string }
export type Placed = { id: string; x: number; y: number }
export type Route = { source: string; target: string; shape: 'forward' | 'down' | 'up' | 'back'; d: string }
export type Box = { x: number; y: number; width: number; height: number }
export type GraphFrame = { width: number; height: number; focus: Box | null }
export type Band = Box & { key: string; label: string; branch: string | null }

export const STEP_W = 160, STEP_H = 52, COL_STEP = 188, ROW_STEP = 70

const BACK_DIP = 26
const LABEL_H = 18
const BAND_PAD = 8
const BAND_GAP = 8
const BACK_LABEL_ROOM = 10
const ARROW = 6
const DRAW_MS = 700
const DRAW_STAGGER_MS = 140
const SVG = 'http://www.w3.org/2000/svg'
const EDGE_STATES: EdgeState[] = ['done', 'flowing', 'failed', 'idle', 'proposed']
const GLYPHS: Record<string, string> = {
  join: '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 5.1v5.8M5.4 4.3c3 .6 4.6 1.8 5.1 2.6M5.4 11.7c3-.6 4.6-1.8 5.1-2.6"/>',
  review: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
}

type LayoutEdge = { source: string; target: string; outcome: string }
type Section = RunView['sections'][number]
type Lane = { own: string[]; sections: { section: Section; paths: Lane[] }[]; band: { section: Section; index: number } | null }

function backEdges(ids: string[], pass: LayoutEdge[], entry: string): Set<LayoutEdge> {
  const back = new Set<LayoutEdge>()
  const state = new Map<string, 'open' | 'closed'>()
  const visit = (id: string): void => {
    state.set(id, 'open')
    for (const edge of pass) {
      if (edge.source !== id) continue
      const seen = state.get(edge.target)
      if (seen === 'open') back.add(edge)
      else if (!seen) visit(edge.target)
    }
    state.set(id, 'closed')
  }
  for (const id of [entry, ...ids]) if (ids.includes(id) && !state.has(id)) visit(id)
  return back
}

function rankWave(seeds: Map<string, number>, forward: LayoutEdge[], ranked: Map<string, number>): Map<string, number> {
  const wave = new Set(seeds.keys())
  const queue = [...wave]
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of forward) {
      if (edge.source !== id || wave.has(edge.target) || ranked.has(edge.target)) continue
      wave.add(edge.target)
      queue.push(edge.target)
    }
  }
  const rank = new Map(seeds)
  for (let round = 0; round <= wave.size; round++) {
    let changed = false
    for (const edge of forward) {
      const from = rank.get(edge.source)
      if (from === undefined || !wave.has(edge.target) || from + 1 <= (rank.get(edge.target) ?? -1)) continue
      rank.set(edge.target, from + 1)
      changed = true
    }
    if (!changed) break
  }
  return rank
}

function rankColumns(ids: string[], edges: LayoutEdge[], entry: string): Map<string, number> {
  const usable = edges.filter(edge => ids.includes(edge.source) && ids.includes(edge.target))
  const pass = usable.filter(edge => edge.outcome === 'pass')
  const back = backEdges(ids, pass, entry)
  const forward = pass.filter(edge => !back.has(edge))
  const column = new Map<string, number>()
  let seeds = new Map(ids.includes(entry) ? [[entry, 0]] : [])
  while (seeds.size) {
    for (const [id, rank] of rankWave(seeds, forward, column)) column.set(id, rank)
    seeds = new Map()
    for (const edge of usable) {
      if (edge.outcome === 'pass' || !column.has(edge.source) || column.has(edge.target)) continue
      seeds.set(edge.target, Math.min(seeds.get(edge.target) ?? Infinity, column.get(edge.source)!))
    }
  }
  const last = Math.max(-1, ...column.values()) + 1
  for (const id of ids) if (!column.has(id)) column.set(id, last)
  return column
}

function buildLanes(ids: string[], sections: Section[]): Lane {
  const top: Lane = { own: [], sections: [], band: null }
  const laneOf = new Map(ids.map(id => [id, top]))
  for (const section of sections) {
    const parent = laneOf.get(section.fork)
    if (!parent) continue
    const paths = section.paths.flatMap((path, index): Lane[] => {
      const lane: Lane = { own: [], sections: [], band: { section, index } }
      const claimed = path.nodes.filter(id => laneOf.get(id) === parent && id !== section.fork && id !== section.join)
      for (const id of claimed) laneOf.set(id, lane)
      return claimed.length ? [lane] : []
    })
    if (paths.length) parent.sections.push({ section, paths })
  }
  for (const id of ids) laneOf.get(id)!.own.push(id)
  return top
}

const subtree = (lane: Lane): string[] => [...lane.own, ...lane.sections.flatMap(({ paths }) => paths.flatMap(subtree))]
const headerOf = (lane: Lane): number => (lane.band ? LABEL_H : 0) + Math.max(0, ...lane.sections.map(({ paths }) => headerOf(paths[0]!)))

function bandLabel(section: Section, index: number): Pick<Band, 'label' | 'branch'> {
  const path = section.paths[index]!
  const branch = (section.state === 'open' || section.state === 'conflict') ? path.branch : null
  if (!branch) return { label: `${path.title} path`, branch: null }
  return { label: `${path.title} path · ${section.state === 'conflict' ? 'kept on ' : ''}`, branch }
}

function placeLanes(top: Lane, column: Map<string, number>): { y: Map<string, number>; bands: Band[] } {
  const y = new Map<string, number>()
  const bands: Band[] = []
  const bottomOf = (ids: string[]): number => Math.max(-Infinity, ...ids.map(id => y.get(id)! + STEP_H))
  const place = (lane: Lane, laneTop: number): number => {
    const rowTop = laneTop + headerOf(lane)
    const colOf = (id: string): number => column.get(id)!
    const blocks = lane.sections
      .map(({ section, paths }) => { const cols = paths.flatMap(subtree).map(colOf); return { section, paths, span: [Math.min(...cols), Math.max(...cols)] as const } })
      .sort((a, b) => (column.get(a.section.fork) ?? 0) - (column.get(b.section.fork) ?? 0))
    const within = (col: number, span: readonly [number, number]): boolean => col >= span[0] && col <= span[1]
    const spanned = (id: string): boolean => blocks.some(({ span }) => within(colOf(id), span))
    const placedBlocks: { span: readonly [number, number]; bottom: number }[] = []
    const topRows = new Map<number, number>(), belowRows = new Map<number, number>()
    const stack = (id: string, floor: number, rows: Map<number, number>): void => {
      const row = rows.get(colOf(id)) ?? 0
      rows.set(colOf(id), row + 1)
      y.set(id, floor + row * ROW_STEP)
    }
    const stackBelowBlocks = (id: string): void => {
      const under = placedBlocks.filter(({ span }) => within(colOf(id), span)).map(({ bottom }) => bottom)
      stack(id, Math.max(rowTop - BAND_GAP, ...under) + BAND_GAP, belowRows)
    }
    for (const id of lane.own) if (!spanned(id)) stack(id, rowTop, topRows)
    for (const { section, paths, span } of blocks) {
      if (lane.own.includes(section.fork) && !y.has(section.fork)) stackBelowBlocks(section.fork)
      const overlapping = placedBlocks.filter(block => block.span[0] <= span[1] && block.span[1] >= span[0]).map(({ bottom }) => bottom + BAND_GAP)
      let pathTop = Math.max((y.get(section.fork) ?? rowTop) - headerOf(paths[0]!), ...overlapping)
      for (const path of paths) {
        const bottom = place(path, pathTop)
        const cols = subtree(path).map(colOf)
        const x = Math.min(...cols) * COL_STEP - BAND_PAD
        const band = { key: `${section.fork}:${path.band!.index}`, x, y: pathTop, width: Math.max(...cols) * COL_STEP + STEP_W + BAND_PAD - x, height: bottom + BAND_PAD - pathTop, ...bandLabel(section, path.band!.index) }
        bands.push(band)
        pathTop = band.y + band.height + BAND_GAP
      }
      placedBlocks.push({ span, bottom: pathTop - BAND_GAP })
    }
    for (const id of lane.own) if (!y.has(id)) stackBelowBlocks(id)
    return Math.max(rowTop + STEP_H, bottomOf(lane.own), ...placedBlocks.map(({ bottom }) => bottom))
  }
  place(top, 0)
  return { y, bands }
}

function backFloor(from: Placed, to: Placed, bands: Box[]): number {
  const left = Math.min(from.x, to.x), right = Math.max(from.x, to.x) + STEP_W
  const spanned = bands.filter(band => band.x < right && band.x + band.width > left).map(band => band.y + band.height)
  return Math.max(from.y + STEP_H, to.y + STEP_H, ...spanned) + BACK_DIP
}

export function layoutRun(steps: { id: string; kind?: string }[], edges: LayoutEdge[], entry: string, sections: Section[] = []): { placed: Placed[]; bands: Band[]; width: number; height: number } {
  const ids = steps.map(step => step.id)
  const column = rankColumns(ids, edges, entry)
  const { y, bands: unordered } = placeLanes(buildLanes(ids, sections), column)
  const order = sections.flatMap(section => section.paths.map((_, index) => `${section.fork}:${index}`))
  const bands = [...unordered].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  const placed = steps.map(step => ({ id: step.id, x: column.get(step.id)! * COL_STEP, y: y.get(step.id)! }))
  const places = new Map(placed.map(place => [place.id, place]))
  const dips = edges.filter(edge => places.has(edge.source) && places.has(edge.target) && routeShape(places.get(edge.source)!, places.get(edge.target)!) === 'back')
    .map(edge => backFloor(places.get(edge.source)!, places.get(edge.target)!, bands) + BACK_LABEL_ROOM)
  const width = Math.max(0, ...placed.map(step => step.x + STEP_W), ...bands.map(band => band.x + band.width))
  const height = Math.max(0, ...placed.map(step => step.y + STEP_H), ...bands.map(band => band.y + band.height), ...dips)
  return { placed, bands, width, height }
}

function routeShape(from: Placed, to: Placed): Route['shape'] {
  if (to.x > from.x) return 'forward'
  if (to.x === from.x && to.y > from.y) return 'down'
  if (to.x === from.x && to.y < from.y) return 'up'
  return 'back'
}

export function routeEdge(from: Placed, to: Placed, bands: Box[] = []): Route {
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
  const dip = backFloor(from, to, bands)
  return { ...ends, d: `M${startX} ${from.y + STEP_H}C${startX} ${dip} ${endX} ${dip} ${endX} ${to.y + STEP_H}` }
}

function labelPoint(from: Placed, to: Placed, shape: Route['shape'], bands: Box[]): { left: number; top: number } {
  if (shape === 'back') return { left: (from.x + to.x + STEP_W) / 2, top: backFloor(from, to, bands) }
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

const isSectionBox = (id: string): boolean => id.startsWith('section:')

export function describeCard(card: HTMLElement, step: GraphStep): void {
  card.title = step.title
  const box = isSectionBox(step.id)
  if (!box && !step.jobId) { card.setAttribute('aria-label', `${step.title}, ${step.detail}`); return }
  card.setAttribute('role', 'button')
  card.tabIndex = 0
  card.setAttribute('aria-label', `${step.title}, ${step.detail}, ${box ? 'show its steps' : 'open its agent'}`)
  if (box) card.setAttribute('aria-expanded', 'false')
}

function stepCard(step: GraphStep, place: Placed): HTMLElement {
  const card = document.createElement('div')
  card.className = 'flow-step'
  card.dataset.step = step.id
  card.dataset.state = step.state
  card.dataset.kind = step.kind
  describeCard(card, step)
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

function boxAround(places: Placed[]): Box | null {
  if (!places.length) return null
  const left = Math.min(...places.map(place => place.x)), top = Math.min(...places.map(place => place.y))
  const right = Math.max(...places.map(place => place.x + STEP_W)), bottom = Math.max(...places.map(place => place.y + STEP_H))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function focusBox(steps: GraphStep[], places: Map<string, Placed>, entry: string): Box | null {
  const placesIn = (state: StepState): Placed[] => steps.filter(step => step.state === state && places.has(step.id)).map(step => places.get(step.id)!)
  for (const state of ['active', 'failed'] as const) {
    const box = boxAround(placesIn(state))
    if (box) return box
  }
  return boxAround(places.has(entry) ? [places.get(entry)!] : [])
}

function bandElement(band: Band, collapsible: string | null): HTMLElement {
  const element = document.createElement('div')
  element.className = 'flow-band'
  element.dataset.band = band.key
  Object.assign(element.style, { left: `${band.x}px`, top: `${band.y}px`, width: `${band.width}px`, height: `${band.height}px` })
  const label = document.createElement('span')
  label.className = 'flow-band-label'
  label.append(band.label)
  if (band.branch) {
    const branch = document.createElement('code')
    branch.textContent = band.branch
    label.append(branch)
  }
  element.append(label)
  if (collapsible) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'flow-band-collapse'
    button.dataset.collapse = collapsible
    button.textContent = 'Collapse'
    element.append(button)
  }
  return element
}

function collapsibleFork(band: Band, sections: Section[]): string | null {
  const [fork, index] = band.key.split(':')
  return index === '0' && sections.some(section => section.fork === fork && section.state === 'joined') ? fork! : null
}

const frames = new WeakMap<HTMLElement, GraphFrame>()
const drawnRuns = new WeakMap<HTMLElement, Set<string>>()
const EMPTY_FRAME: GraphFrame = { width: 0, height: 0, focus: null }

export function renderRunGraph(host: HTMLElement, steps: GraphStep[], edges: GraphEdge[], entry: string, options: { animate: boolean; sections?: Section[]; runId?: string }): GraphFrame {
  const sections = options.sections ?? []
  const runKey = options.runId ?? ''
  const paintSignature = JSON.stringify([options.animate, runKey, entry, steps, edges, sections])
  if (host.dataset.sig === paintSignature && host.firstChild) return frames.get(host) ?? EMPTY_FRAME
  host.dataset.sig = paintSignature
  const drawn = drawnRuns.get(host) ?? drawnRuns.set(host, new Set()).get(host)!
  const shouldDrawIn = options.animate && !drawn.has(runKey)
  drawn.add(runKey)
  if (!steps.length) { host.replaceChildren(); frames.set(host, EMPTY_FRAME); return EMPTY_FRAME }

  const layout = layoutRun(steps, edges, entry, sections)
  const places = new Map(layout.placed.map(place => [place.id, place]))
  const drawable = edges.filter(edge => places.has(edge.source) && places.has(edge.target))
  const routes = drawable.map(edge => routeEdge(places.get(edge.source)!, places.get(edge.target)!, layout.bands))
  const frame = { width: layout.width, height: layout.height, focus: focusBox(steps, places, entry) }
  frames.set(host, frame)
  const graph = document.createElement('div')
  graph.className = options.animate ? 'flow-run' : 'flow-run still'
  graph.setAttribute('role', 'group')
  graph.style.width = `${frame.width}px`
  graph.style.height = `${frame.height}px`
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'flow-run-edges')
  svg.setAttribute('width', String(frame.width))
  svg.setAttribute('height', String(frame.height))
  svg.setAttribute('aria-hidden', 'true')
  const defs = document.createElementNS(SVG, 'defs')
  defs.append(...EDGE_STATES.map(tipMarker))
  svg.append(defs)

  const paths = drawable.map((edge, index) => routePath(routes[index]!, edge.state))
  svg.append(...paths)
  const labels = drawable.filter(edge => edge.label).map(edge => {
    const from = places.get(edge.source)!, to = places.get(edge.target)!
    return routeLabel(edge.label!, edge.state, labelPoint(from, to, routeShape(from, to), layout.bands))
  })
  graph.append(...layout.bands.map(band => bandElement(band, collapsibleFork(band, sections))), svg, ...labels, ...steps.map(step => stepCard(step, places.get(step.id)!)))
  host.replaceChildren(graph)
  if (shouldDrawIn) drawIn(paths)
  return frame
}
