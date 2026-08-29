import {
  DEFAULT_LAYOUT,
  HIT_PX,
  MIN_FLOW_H,
  MIN_PANEL_H,
  MIN_RACK_PX,
  STORE_KEY,
  clampFlowH,
  clampPanelH,
  normalizePair,
  normalizeTriple,
  parseLayout,
  recomputePairFr,
  recomputeTripleFr,
  serializeLayout,
  type LayoutState,
} from './resize-layout'

type DividerKind = 'flow' | 'panel' | 'rack-1' | 'rack-2' | 'plan'

const DIVIDER_KINDS: DividerKind[] = ['flow', 'panel', 'rack-1', 'rack-2', 'plan']

type DragStart = {
  kind: DividerKind
  clientX: number
  clientY: number
  flowH: number
  panelH: number
  rackFr: [number, number, number]
  planFr: [number, number]
  containerPx: number
  maxPx: number
}

let layout: LayoutState = { ...DEFAULT_LAYOUT }
let drag: DragStart | null = null
let latestMoveEvent: PointerEvent | null = null
let framePending = false

function bodyEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.body')
}

function dividerEl(kind: DividerKind): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mc-divider[data-resize="${kind}"]`)
}

function flowEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.flow')
}

function panelEl(): HTMLElement | null {
  return document.getElementById('flowpanel')
}

function racksEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.racks')
}

function rackEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.racks .rack'))
}

function planColEl(): HTMLElement | null {
  return document.getElementById('plan-col')
}

function activityColEl(): HTMLElement | null {
  return document.getElementById('activity-col')
}

function panelVisible(): boolean {
  const panel = panelEl()
  return panel !== null && !panel.classList.contains('off')
}

function setVar(el: HTMLElement, name: string, value: number | null, unit: string): void {
  if (value === null) el.style.removeProperty(name)
  else el.style.setProperty(name, `${value}${unit}`)
}

function setFrVars(el: HTMLElement, names: string[], values: number[] | null): void {
  names.forEach((name, index) => {
    if (values === null) el.style.removeProperty(name)
    else el.style.setProperty(name, `${values[index]}fr`)
  })
}

function applyLayout(): void {
  const body = bodyEl()
  if (body === null) return
  setVar(body, '--flow-h', layout.flowH, 'px')
  setVar(body, '--panel-h', layout.panelH, 'px')
  setFrVars(body, ['--rack-1', '--rack-2', '--rack-3'], layout.rackFr)
  setFrVars(body, ['--plan-1', '--plan-2'], layout.planFr)
}

function loadLayout(): LayoutState {
  try {
    return parseLayout(localStorage.getItem(STORE_KEY))
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

function saveLayout(): void {
  try {
    localStorage.setItem(STORE_KEY, serializeLayout(layout))
  } catch {
    /* private mode or full quota — layout still applies for this page load */
  }
}

function positionHorizontal(kind: DividerKind, edge: number | null, body: DOMRect): void {
  const el = dividerEl(kind)
  if (el === null) return
  if (edge === null) {
    el.classList.add('mc-divider-hidden')
    return
  }
  el.classList.remove('mc-divider-hidden')
  el.style.left = '0'
  el.style.right = '0'
  el.style.top = `${edge - body.top - HIT_PX / 2}px`
}

function positionVertical(kind: DividerKind, edge: number | null, span: DOMRect | null, body: DOMRect): void {
  const el = dividerEl(kind)
  if (el === null) return
  if (edge === null || span === null) {
    el.classList.add('mc-divider-hidden')
    return
  }
  el.classList.remove('mc-divider-hidden')
  el.style.left = `${edge - body.left - HIT_PX / 2}px`
  el.style.top = `${span.top - body.top}px`
  el.style.height = `${span.height}px`
}

function positionDividers(): void {
  const body = bodyEl()
  if (body === null) return
  const bodyRect = body.getBoundingClientRect()

  positionHorizontal('flow', flowEl()?.getBoundingClientRect().bottom ?? null, bodyRect)

  const panel = panelEl()
  const showPanel = panelVisible()
  positionHorizontal('panel', showPanel && panel !== null ? panel.getBoundingClientRect().bottom : null, bodyRect)

  const racksRect = racksEl()?.getBoundingClientRect() ?? null
  const [rack1, rack2] = rackEls()
  positionVertical('rack-1', rack1 ? rack1.getBoundingClientRect().right : null, racksRect, bodyRect)
  positionVertical('rack-2', rack2 ? rack2.getBoundingClientRect().right : null, racksRect, bodyRect)

  const planCol = planColEl()
  const panelRect = showPanel && panel !== null ? panel.getBoundingClientRect() : null
  const planEdge = showPanel && planCol !== null ? planCol.getBoundingClientRect().right : null
  positionVertical('plan', planEdge, panelRect, bodyRect)
}

function currentRackFr(): [number, number, number] {
  if (layout.rackFr !== null) return layout.rackFr
  const [rack1, rack2, rack3] = rackEls()
  if (rack1 && rack2 && rack3) {
    return normalizeTriple([
      rack1.getBoundingClientRect().width,
      rack2.getBoundingClientRect().width,
      rack3.getBoundingClientRect().width,
    ])
  }
  return [1, 1, 1]
}

function currentPlanFr(): [number, number] {
  if (layout.planFr !== null) return layout.planFr
  const planCol = planColEl()
  const activityCol = activityColEl()
  if (planCol !== null && activityCol !== null) {
    return normalizePair([planCol.getBoundingClientRect().width, activityCol.getBoundingClientRect().width])
  }
  return [1, 1]
}

function beginDrag(kind: DividerKind, event: PointerEvent): void {
  const el = dividerEl(kind)
  const body = bodyEl()
  if (el === null || body === null) return
  const bodyRect = body.getBoundingClientRect()

  const containerPx =
    kind === 'rack-1' || kind === 'rack-2'
      ? (racksEl()?.getBoundingClientRect().width ?? 0)
      : kind === 'plan'
        ? (panelEl()?.getBoundingClientRect().width ?? 0)
        : 0

  drag = {
    kind,
    clientX: event.clientX,
    clientY: event.clientY,
    flowH: flowEl()?.getBoundingClientRect().height ?? MIN_FLOW_H,
    panelH: panelEl()?.getBoundingClientRect().height ?? MIN_PANEL_H,
    rackFr: currentRackFr(),
    planFr: currentPlanFr(),
    containerPx,
    maxPx: Math.max(bodyRect.height - 100, MIN_FLOW_H),
  }

  el.classList.add('dragging')
  el.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function applyDrag(event: PointerEvent): void {
  if (drag === null) return
  const deltaX = event.clientX - drag.clientX
  const deltaY = event.clientY - drag.clientY

  if (drag.kind === 'flow') {
    layout = { ...layout, flowH: clampFlowH(drag.flowH + deltaY, drag.maxPx) }
  } else if (drag.kind === 'panel') {
    layout = { ...layout, panelH: clampPanelH(drag.panelH + deltaY, drag.maxPx) }
  } else if (drag.kind === 'rack-1') {
    const next = recomputeTripleFr(drag.rackFr, drag.containerPx, 0, deltaX, MIN_RACK_PX)
    layout = { ...layout, rackFr: normalizeTriple(next) }
  } else if (drag.kind === 'rack-2') {
    const next = recomputeTripleFr(drag.rackFr, drag.containerPx, 1, deltaX, MIN_RACK_PX)
    layout = { ...layout, rackFr: normalizeTriple(next) }
  } else {
    const next = recomputePairFr(drag.planFr, drag.containerPx, deltaX, MIN_PANEL_H)
    layout = { ...layout, planFr: normalizePair(next) }
  }

  applyLayout()
  positionDividers()
  dispatchEvent(new Event('resize'))
}

function onPointerMove(event: PointerEvent): void {
  if (drag === null) return
  latestMoveEvent = event
  if (framePending) return
  framePending = true
  requestAnimationFrame(() => {
    framePending = false
    if (latestMoveEvent !== null) applyDrag(latestMoveEvent)
  })
}

function endDrag(event: PointerEvent): void {
  if (drag === null) return
  const el = dividerEl(drag.kind)
  el?.classList.remove('dragging')
  if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
  drag = null
  latestMoveEvent = null
  saveLayout()
}

function resetAxis(kind: DividerKind): void {
  if (kind === 'flow') layout = { ...layout, flowH: null }
  else if (kind === 'panel') layout = { ...layout, panelH: null }
  else if (kind === 'rack-1' || kind === 'rack-2') layout = { ...layout, rackFr: null }
  else layout = { ...layout, planFr: null }

  applyLayout()
  positionDividers()
  saveLayout()
  dispatchEvent(new Event('resize'))
}

function wireDivider(kind: DividerKind): void {
  const el = dividerEl(kind)
  if (el === null) return
  el.addEventListener('pointerdown', (event) => beginDrag(kind, event))
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', endDrag)
  el.addEventListener('pointercancel', endDrag)
  el.addEventListener('dblclick', () => resetAxis(kind))
}

export function installResize(): void {
  if (document.querySelector('.mc-divider') === null) return

  layout = loadLayout()
  applyLayout()
  positionDividers()
  dispatchEvent(new Event('resize'))

  for (const kind of DIVIDER_KINDS) wireDivider(kind)
  addEventListener('resize', () => positionDividers())
  observeLayoutChanges()
}

let repositionQueued = false

function queueReposition(): void {
  if (repositionQueued) return
  repositionQueued = true
  requestAnimationFrame(() => {
    repositionQueued = false
    positionDividers()
  })
}

function observeLayoutChanges(): void {
  const watched = [flowEl(), panelEl(), racksEl(), planColEl(), activityColEl()].filter(
    (el): el is HTMLElement => el !== null,
  )
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => queueReposition())
    for (const el of watched) ro.observe(el)
  }
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => queueReposition())
    for (const el of watched) mo.observe(el, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] })
  }
}

installResize()
