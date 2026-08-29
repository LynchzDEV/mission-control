import {
  NEXT_LABEL_DROP,
  STAGES,
  assigneeClass,
  flowContentH,
  nextLabelSpec,
  parsePlan,
  planLayout,
  planNodeSpecs,
  stepGlyph,
  templateNodeSpecs,
  templateTops,
  type Plan,
  type SessionFlow,
  type StageState,
} from './plan-view'
import { createFullFeed, type Feed } from './thread-view'
import {
  type Anime,
  type Animation,
  type JsonRecord,
  anime,
  getJson,
  markFixture,
  postJson,
  readNumber,
  readRecord,
  token,
} from './shared'

type Session = {
  stages: SessionFlow
  plan: Plan | null
  activity: string
  jobId: string
  finished: boolean
  archived: boolean
}

const FLOW_REFRESH_MS = 3_000

const PULSE = {
  boxShadow: [
    '0 0 0 0 rgba(51,255,102,0)',
    '0 0 0 3px rgba(51,255,102,.15)',
    '0 0 0 0 rgba(51,255,102,0)',
  ],
  duration: 2200,
  loop: true,
  ease: 'inOutSine',
}

let SESSIONS: Record<string, Session> = {}
let ARCHIVED: Record<string, Session> = {}
let CUR = ''
let SHAPE = ''
let ARCHIVE_OPEN = false
let ARCHIVED_COUNT = 0

let pulse: Animation | null = null
let processView: Feed | null = null

function pulseActive(A: Anime): void {
  pulse?.revert?.()
  pulse = null
  document.querySelectorAll<HTMLElement>('.node').forEach((n) => (n.style.boxShadow = ''))
  if (document.querySelector('.node.active') === null) return
  pulse = A.animate('.node.active', PULSE)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bool(value: unknown): boolean {
  return value === true
}

function parseStages(raw: JsonRecord): SessionFlow | null {
  const session: SessionFlow = {}
  for (const stage of STAGES) {
    const pair = raw[stage]
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') return null
    session[stage] = [pair[0] as StageState, typeof pair[1] === 'string' ? pair[1] : '']
  }
  return session
}

function parseSessions(raw: unknown): Record<string, Session> | null {
  const record = readRecord(raw)
  const parsed: Record<string, Session> = {}
  for (const [key, value] of Object.entries(record)) {
    const entry = readRecord(value)
    const stages = parseStages(entry)
    if (stages === null) return null
    parsed[key] = {
      stages,
      plan: parsePlan(entry.plan),
      activity: str(entry.currentActivity),
      jobId: str(entry.activityJobId),
      finished: bool(entry.finished),
      archived: bool(entry.archived),
    }
  }
  return parsed
}

function element(tag: string, className: string, textContent = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (textContent !== '') node.textContent = textContent
  return node
}

function planNodeIds(): string[] {
  const ids: string[] = []
  document.querySelectorAll<HTMLElement>('#plan-nodes .node').forEach((node) => ids.push(node.id))
  return ids
}

const TEMPLATE_ROW_IDS = ['nd-spec', 'nd-impl', 'nd-verify', 'nd-merged']

function flowContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.flow')
}

function renderPlanNodes(plan: Plan | null): void {
  const host = document.getElementById('plan-nodes')
  const flow = flowContainer()
  if (host === null || flow === null) return
  host.textContent = ''
  flow.classList.toggle('planned', plan !== null)
  if (plan === null) return

  const containerH = flow.clientHeight
  for (const spec of planNodeSpecs(plan, containerH)) {
    const node = element('div', spec.className)
    node.id = spec.id
    node.style.left = spec.left
    node.style.top = spec.top
    node.append(element('div', 'nn', spec.title), element('div', spec.chipClass, spec.chipText))
    host.appendChild(node)
  }

  const next = nextLabelSpec(plan, containerH)
  if (next === null) return
  const label = element('div', 'alabel next', next.text)
  label.style.left = next.left
  label.style.top = next.top
  host.appendChild(label)
}

function renderTemplateNodes(stages: SessionFlow): void {
  for (const spec of templateNodeSpecs(stages)) {
    const node = document.getElementById(spec.id)
    const chip = document.getElementById(spec.chipId)
    if (node === null || chip === null) continue
    node.className = spec.className
    node.style.boxShadow = ''
    if (spec.chipText !== '') chip.textContent = spec.chipText
    else if (spec.trimmable) chip.textContent = (chip.textContent ?? '').split(' ·')[0] as string
  }
}

function renderPlanColumn(plan: Plan | null): void {
  const host = document.getElementById('plan-steps')
  const next = document.getElementById('plan-next')
  const column = document.getElementById('plan-col')
  if (host === null || next === null || column === null) return
  host.textContent = ''
  next.textContent = ''
  column.classList.toggle('off', plan === null)
  if (plan === null) return

  plan.steps.forEach((step, index) => {
    const row = element('div', `pstep ${step.status}`)
    row.append(
      element('i', 'glyph', stepGlyph(step.status)),
      element('b', 'num', String(index + 1).padStart(2, '0')),
      element('span', 'title', step.title),
      element('span', `chip ${assigneeClass(step.assignee)}`, step.assignee.toUpperCase()),
    )
    host.appendChild(row)
  })
  if (plan.next !== '') next.textContent = `NEXT → ${plan.next}`
}

function syncPanel(): void {
  const panel = document.getElementById('flowpanel')
  if (panel === null) return
  const planned = document.getElementById('plan-col')?.classList.contains('off') === false
  const active = document.getElementById('activity-col')?.classList.contains('off') === false
  panel.classList.toggle('off', !planned && !active)
}

function stopProcess(): void {
  processView?.stop()
  processView = null
}

function startProcess(session: Session): void {
  stopProcess()
  const host = document.getElementById('activity-feed')
  const column = document.getElementById('activity-col')
  if (host === null || column === null) return
  host.textContent = ''

  if (session.jobId === '') {
    if (session.activity !== '') host.appendChild(element('div', 'aevent', session.activity))
    column.classList.toggle('off', host.childElementCount === 0)
    syncPanel()
    return
  }

  processView = createFullFeed(session.jobId)
  host.appendChild(processView.root)
  processView.start()
  column.classList.remove('off')
  syncPanel()
}

export function setSession(k: string): void {
  const session = SESSIONS[k]
  if (session === undefined) return
  CUR = k
  renderPlanNodes(session.plan)
  if (session.plan === null) renderTemplateNodes(session.stages)
  renderPlanColumn(session.plan)
  startProcess(session)

  document
    .querySelectorAll<HTMLElement>('#chips .chip')
    .forEach((c) => c.classList.toggle('on', c.dataset.s === k))

  const A = anime()
  if (A !== null) {
    A.animate('.node', { opacity: { from: 0.2 }, duration: 350, ease: 'outQuad' })
    pulseActive(A)
  }
  layoutFlow()
}

async function archiveSession(label: string): Promise<void> {
  await postJson(`/api/flow/${encodeURIComponent(label)}/archive`, {})
  SHAPE = ''
  await hydrate()
}

async function unarchiveSession(label: string): Promise<void> {
  await postJson(`/api/flow/${encodeURIComponent(label)}/unarchive`, {})
  delete ARCHIVED[label]
  SHAPE = ''
  await hydrate()
  if (ARCHIVE_OPEN) await loadArchived()
}

async function loadArchived(): Promise<void> {
  const result = await getJson('/api/flow?includeArchived=1')
  const parsed = result.ok ? parseSessions(result.data.sessions) : null
  if (parsed === null) return
  ARCHIVED = Object.fromEntries(Object.entries(parsed).filter(([, session]) => session.archived))
  buildChips()
}

function toggleArchived(): void {
  ARCHIVE_OPEN = !ARCHIVE_OPEN
  if (ARCHIVE_OPEN) void loadArchived()
  else buildChips()
}

function chipElement(key: string, archived: boolean, finished: boolean): HTMLElement {
  const chip = element('span', archived ? 'chip archived' : 'chip', key)
  chip.dataset.s = key
  if (archived) {
    const undo = element('i', 'x', '↺')
    undo.onclick = (event) => {
      event.stopPropagation()
      void unarchiveSession(key)
    }
    chip.appendChild(undo)
    return chip
  }

  chip.onclick = () => setSession(key)
  if (finished) {
    const close = element('i', 'x', '×')
    close.onclick = (event) => {
      event.stopPropagation()
      void archiveSession(key)
    }
    chip.appendChild(close)
  }
  return chip
}

function buildChips(): void {
  const chips = document.getElementById('chips')
  if (chips === null) return
  chips.textContent = ''
  Object.entries(SESSIONS).forEach(([key, session]) => {
    chips.appendChild(chipElement(key, false, session.finished))
  })

  if (ARCHIVED_COUNT > 0) {
    const toggle = element(
      'span',
      ARCHIVE_OPEN ? 'archived-toggle on' : 'archived-toggle',
      `ARCHIVED (${ARCHIVED_COUNT})`,
    )
    toggle.onclick = () => toggleArchived()
    chips.appendChild(toggle)
  }

  if (ARCHIVE_OPEN) {
    Object.entries(ARCHIVED).forEach(([key, session]) => {
      chips.appendChild(chipElement(key, true, session.finished))
    })
  }
}

type Rect = { l: number; r: number; t: number; b: number; cx: number; cy: number }

function rectOf(id: string, box: DOMRect): Rect | null {
  const node = document.getElementById(id)
  if (node === null) return null
  const r = node.getBoundingClientRect()
  return {
    l: r.left - box.left,
    r: r.right - box.left,
    t: r.top - box.top,
    b: r.bottom - box.top,
    cy: r.top - box.top + r.height / 2,
    cx: r.left - box.left + r.width / 2,
  }
}

function edgePath(svg: Element, d: string, stroke: string, dash: number, marker: string, op?: string) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', d)
  p.setAttribute('stroke', stroke)
  p.setAttribute('fill', 'none')
  p.setAttribute('stroke-width', '1.5')
  if (dash) p.setAttribute('stroke-dasharray', '5 4')
  p.setAttribute('marker-end', 'url(#' + marker + ')')
  if (op) p.setAttribute('opacity', op)
  p.classList.add('edge')
  svg.appendChild(p)
  return p
}

function planEdges(svg: Element, box: DOMRect, ids: string[]): SVGPathElement[] {
  const edge = token('--mc-edge')
  const edges: SVGPathElement[] = []
  for (let index = 0; index + 1 < ids.length; index += 1) {
    const from = rectOf(ids[index] as string, box)
    const to = rectOf(ids[index + 1] as string, box)
    if (from === null || to === null) continue
    const wraps = to.cy - from.cy > 8
    const d = wraps
      ? `M ${from.cx} ${from.b} C ${from.cx} ${from.b + 26}, ${to.cx} ${to.t - 26}, ${to.cx} ${to.t - 6}`
      : `M ${from.r} ${from.cy} L ${to.l - 6} ${to.cy}`
    edges.push(edgePath(svg, d, edge, wraps ? 1 : 0, 'ar'))
  }
  return edges
}

function templateEdges(svg: Element, box: DOMRect): SVGPathElement[] {
  const S = rectOf('nd-spec', box)
  const I = rectOf('nd-impl', box)
  const C = rectOf('nd-codex', box)
  const V = rectOf('nd-verify', box)
  const M = rectOf('nd-merged', box)
  if (S === null || I === null || C === null || V === null || M === null) return []
  const edge = token('--mc-edge')
  const edgeDim = token('--mc-edge-dim')
  const amber = token('--mc-amber')
  return [
    edgePath(svg, `M ${S.r} ${S.cy} L ${I.l - 6} ${I.cy}`, edge, 0, 'ar'),
    edgePath(svg, `M ${I.r} ${I.cy} L ${V.l - 6} ${V.cy}`, edge, 0, 'ar'),
    edgePath(
      svg,
      `M ${I.r - 20} ${I.t} C ${I.r + 30} ${C.cy}, ${C.l - 60} ${C.cy}, ${C.l - 6} ${C.cy}`,
      amber,
      1,
      'arA',
    ),
    edgePath(
      svg,
      `M ${C.l + 20} ${C.b} C ${C.l - 10} ${C.b + 40}, ${V.cx - 40} ${V.t - 20}, ${V.cx} ${V.t - 6}`,
      edgeDim,
      1,
      'ar',
    ),
    edgePath(svg, `M ${V.r} ${V.cy} L ${M.l - 6} ${M.cy}`, edgeDim, 0, 'ar', '.5'),
  ]
}

function placePlanNodes(containerH: number): number[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('#plan-nodes .node'))
  const boxes = planLayout(nodes.length, containerH)
  nodes.forEach((node, index) => {
    const box = boxes[index]
    if (box !== undefined) node.style.top = box.top
  })

  const tops = boxes.map((box) => Number.parseInt(box.top, 10))
  const label = document.querySelector<HTMLElement>('#plan-nodes .alabel.next')
  const last = tops[tops.length - 1]
  if (label !== null && last !== undefined) label.style.top = `${last + NEXT_LABEL_DROP}px`
  return tops
}

function placeTemplateNodes(containerH: number): number[] {
  const tops = templateTops(containerH)
  for (const id of TEMPLATE_ROW_IDS) {
    const node = document.getElementById(id)
    if (node !== null) node.style.top = `${Math.round(tops.main)}px`
  }
  const raised = document.getElementById('nd-codex')
  if (raised !== null) raised.style.top = `${Math.round(tops.raised)}px`

  const labels = Array.from(document.querySelectorAll<HTMLElement>('.flow .alabel.tpl'))
  if (labels[0] !== undefined) labels[0].style.top = `${Math.round(tops.labelA)}px`
  if (labels[1] !== undefined) labels[1].style.top = `${Math.round(tops.labelB)}px`
  return [tops.raised, tops.main]
}

export function layoutFlow(): void {
  const flow = flowContainer()
  if (flow === null) return
  const containerH = flow.clientHeight
  const tops = flow.classList.contains('planned')
    ? placePlanNodes(containerH)
    : placeTemplateNodes(containerH)

  const svg = document.getElementById('fsvg')
  if (svg !== null) svg.style.height = `${Math.max(containerH, Math.round(flowContentH(tops)))}px`
  drawFlow()
}

export function drawFlow(): void {
  const svg = document.getElementById('fsvg')
  if (svg === null) return
  const box = svg.getBoundingClientRect()
  svg.querySelectorAll('.edge').forEach((e) => e.remove())

  const planned = planNodeIds()
  const edges =
    planned.length > 0 ? planEdges(svg, box, planned) : templateEdges(svg, box)

  const A = anime()
  edges.forEach((p, i) => {
    const L = p.getTotalLength()
    if (!p.getAttribute('stroke-dasharray')) {
      p.setAttribute('stroke-dasharray', String(L))
      p.setAttribute('stroke-dashoffset', String(L))
      if (A !== null) {
        A.animate(p, { strokeDashoffset: [L, 0], duration: 700, delay: 350 + i * 140, ease: 'outQuad' })
      }
    }
  })
}

// Only the graph shape drives a re-render — currentActivity changes every poll and would
// otherwise restage the node animation on every tick.
function shapeOf(sessions: Record<string, Session>, archivedCount: number): string {
  return JSON.stringify([
    Object.entries(sessions).map(([key, session]) => [
      key,
      session.stages,
      session.plan,
      session.jobId,
      session.finished,
    ]),
    archivedCount,
  ])
}

async function hydrate(): Promise<void> {
  const result = await getJson('/api/flow')
  const parsed = result.ok ? parseSessions(result.data.sessions) : null
  if (parsed === null) {
    markFixture('flow', true)
    return
  }
  markFixture('flow', false)

  const archivedCount = readNumber(result.data.archivedCount) ?? 0
  const shape = shapeOf(parsed, archivedCount)
  const keys = Object.keys(parsed)
  SESSIONS = parsed
  ARCHIVED_COUNT = archivedCount

  const flowEl = document.querySelector('.flow')
  if (keys.length === 0) {
    stopProcess()
    flowEl?.classList.add('empty')
    document.getElementById('flowpanel')?.classList.add('off')
    SHAPE = shape
    buildChips()
    return
  }
  flowEl?.classList.remove('empty')
  if (shape === SHAPE && SESSIONS[CUR] !== undefined) return
  SHAPE = shape

  const current = str(result.data.current)
  CUR = parsed[current] !== undefined ? current : (keys[0] as string)
  buildChips()
  setSession(CUR)
}

export function installFlow(): void {
  if (document.getElementById('fsvg') === null) return
  const A = anime()
  if (A !== null) {
    A.animate('.node', {
      opacity: { from: 0 },
      translateY: [8, 0],
      delay: A.stagger(90, { start: 200 }),
      duration: 500,
      ease: 'outExpo',
    })
    pulseActive(A)
  }
  // Station rows are rendered by the lanes island after this runs, so the click has to be delegated.
  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const task = target.closest<HTMLElement>('.task[data-s]')
    if (task !== null) setSession(task.dataset.s ?? '')
  })
  void hydrate()
  setInterval(() => void hydrate(), FLOW_REFRESH_MS)
  addEventListener('resize', () => layoutFlow())
  observeFlowArea()
}

let relayoutQueued = false

function queueLayoutFlow(): void {
  if (relayoutQueued) return
  relayoutQueued = true
  requestAnimationFrame(() => {
    relayoutQueued = false
    layoutFlow()
  })
}

function observeFlowArea(): void {
  const flow = flowContainer()
  if (flow === null || typeof ResizeObserver === 'undefined') return
  new ResizeObserver(() => queueLayoutFlow()).observe(flow)
}

installFlow()
