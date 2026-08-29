export const STORE_KEY = 'mc.lanes.layout'
export const MIN_FLOW_H = 120
export const MIN_PANEL_H = 80
export const MIN_RACK_PX = 180
// Mirrored by `.racks { min-height }` in theme.css — both must move together.
export const MIN_RACKS_H = 200
export const HIT_PX = 7

export type LayoutState = {
  flowH: number | null
  panelH: number | null
  rackFr: [number, number, number] | null
  planFr: [number, number] | null
}

export const DEFAULT_LAYOUT: LayoutState = { flowH: null, panelH: null, rackFr: null, planFr: null }

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
}

function isPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
}

export function serializeLayout(state: LayoutState): string {
  return JSON.stringify(state)
}

export function parseLayout(raw: string | null): LayoutState {
  if (raw === null) return { ...DEFAULT_LAYOUT }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_LAYOUT }
    const obj = parsed as Record<string, unknown>
    return {
      flowH: isFiniteNumber(obj.flowH) ? obj.flowH : null,
      panelH: isFiniteNumber(obj.panelH) ? obj.panelH : null,
      rackFr: isTriple(obj.rackFr) ? obj.rackFr : null,
      planFr: isPair(obj.planFr) ? obj.planFr : null,
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function clampFlowH(px: number, maxPx: number): number {
  return clamp(px, MIN_FLOW_H, Math.max(MIN_FLOW_H, maxPx))
}

export function clampPanelH(px: number, maxPx: number): number {
  return clamp(px, MIN_PANEL_H, Math.max(MIN_PANEL_H, maxPx))
}

export function maxFlowH(bodyPx: number, panelPx: number, minRacksPx = MIN_RACKS_H): number {
  return Math.max(MIN_FLOW_H, bodyPx - panelPx - minRacksPx)
}

export function maxPanelH(bodyPx: number, flowPx: number, minRacksPx = MIN_RACKS_H): number {
  return Math.max(MIN_PANEL_H, bodyPx - flowPx - minRacksPx)
}

export function fitVerticalLayout(
  flowPx: number,
  panelPx: number,
  bodyPx: number,
  minRacksPx = MIN_RACKS_H,
): { flowH: number; panelH: number } {
  const minPanel = panelPx > 0 ? MIN_PANEL_H : 0
  const flow = Math.max(MIN_FLOW_H, flowPx)
  const panel = panelPx > 0 ? Math.max(MIN_PANEL_H, panelPx) : 0
  const room = bodyPx - minRacksPx
  if (flow + panel <= room) return { flowH: flow, panelH: panel }

  const slack = room - MIN_FLOW_H - minPanel
  const stretch = flow - MIN_FLOW_H + (panel - minPanel)
  if (slack <= 0 || stretch <= 0) return { flowH: MIN_FLOW_H, panelH: minPanel }

  const scale = slack / stretch
  return {
    flowH: Math.floor(MIN_FLOW_H + (flow - MIN_FLOW_H) * scale),
    panelH: Math.floor(minPanel + (panel - minPanel) * scale),
  }
}

export function recomputePairFr(
  fr: [number, number],
  containerPx: number,
  deltaPx: number,
  minPx: number,
): [number, number] {
  const total = fr[0] + fr[1]
  if (containerPx <= 0 || total <= 0) return fr
  const pxPerFr = containerPx / total
  const minFr = minPx / pxPerFr
  const deltaFr = clamp(deltaPx / pxPerFr, minFr - fr[0], fr[1] - minFr)
  return [fr[0] + deltaFr, fr[1] - deltaFr]
}

export function recomputeTripleFr(
  fr: [number, number, number],
  containerPx: number,
  dividerIndex: 0 | 1,
  deltaPx: number,
  minPx: number,
): [number, number, number] {
  const total = fr[0] + fr[1] + fr[2]
  if (containerPx <= 0 || total <= 0) return fr
  const pxPerFr = containerPx / total
  const minFr = minPx / pxPerFr
  const values: number[] = [fr[0], fr[1], fr[2]]
  const a = dividerIndex
  const b = dividerIndex + 1
  const deltaFr = clamp(deltaPx / pxPerFr, minFr - values[a]!, values[b]! - minFr)
  values[a] = values[a]! + deltaFr
  values[b] = values[b]! - deltaFr
  return [values[0]!, values[1]!, values[2]!]
}

export function normalizeTriple(fr: [number, number, number]): [number, number, number] {
  const avg = (fr[0] + fr[1] + fr[2]) / 3
  if (avg <= 0) return [1, 1, 1]
  return [fr[0] / avg, fr[1] / avg, fr[2] / avg]
}

export function normalizePair(fr: [number, number]): [number, number] {
  const avg = (fr[0] + fr[1]) / 2
  if (avg <= 0) return [1, 1]
  return [fr[0] / avg, fr[1] / avg]
}
