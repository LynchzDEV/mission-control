import { getJson, readArray, readRecord } from './shared'
import { MORPH_EASE, MORPH_MS, reveal, rollText } from './morph'

export type Outcome = {
  seq: number
  at: number
  ok: boolean
  kind: string
  tool: string
  target: string
  result: string
  detail: string
  actor: { by: 'main' | 'spawned'; label: string; engine: string }
}
export type OutcomeStrip = { element: HTMLElement; refresh(): void; setSource(source: string | null): void; destroy(): void }

export const CELL_PX = 10
export const GAP_PX = 3
export const POLL_MS = 5000
const KEEP = 500
const SPAWN_TOOLS = new Set(['Job', 'Agent', 'Task'])

export function capacity(width: number): number {
  return Math.max(0, Math.floor((width + GAP_PX) / (CELL_PX + GAP_PX)))
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export function whoText(outcome: Outcome): string {
  return SPAWN_TOOLS.has(outcome.tool) ? 'Started by the main agent' : outcome.actor.label
}

export function mergeOutcomes(current: readonly Outcome[], incoming: readonly Outcome[]): Outcome[] {
  const last = current.at(-1)?.seq ?? 0
  return [...current, ...incoming.filter((item) => item.seq > last)].slice(-KEEP)
}

let tip: HTMLElement | null = null
function tooltip(): HTMLElement {
  if (tip) return tip
  tip = Object.assign(document.createElement('div'), { className: 'oc-tip', hidden: true })
  tip.setAttribute('role', 'tooltip')
  document.body.append(tip)
  return tip
}

function square(outcome: Outcome): HTMLElement {
  const cell = document.createElement('i')
  cell.className = 'oc-sq'
  cell.dataset.ok = String(outcome.ok)
  cell.dataset.by = outcome.actor.by
  return cell
}

function paintTip(box: HTMLElement, outcome: Outcome): void {
  const head = document.createElement('div')
  head.className = 'oc-tip-head'
  const code = document.createElement('code')
  code.textContent = outcome.target
  head.append(square(outcome), outcome.tool, code)
  const result = Object.assign(document.createElement('p'), { className: 'oc-tip-result', textContent: outcome.result })
  result.dataset.ok = String(outcome.ok)
  const meta = document.createElement('p')
  meta.className = 'oc-tip-meta'
  const logo = Object.assign(document.createElement('img'), { src: `/providers/${outcome.actor.engine}.svg`, alt: '' })
  meta.append(logo, `${whoText(outcome)} · ${relativeTime(outcome.at, Date.now())}`)
  const parts: HTMLElement[] = [head, result]
  if (outcome.detail) parts.push(Object.assign(document.createElement('p'), { className: 'oc-tip-detail', textContent: outcome.detail }))
  box.replaceChildren(...parts, meta)
}

function showTip(cell: HTMLElement, outcome: Outcome): void {
  const box = tooltip()
  paintTip(box, outcome)
  const appearing = box.hidden
  box.hidden = false
  const rect = cell.getBoundingClientRect()
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - box.offsetWidth / 2), innerWidth - box.offsetWidth - 8)
  const above = rect.top - box.offsetHeight - 10
  box.style.left = `${left}px`
  box.style.top = `${above > 8 ? above : rect.bottom + 10}px`
  if (appearing) box.animate?.([{ opacity: 0, transform: 'translateY(4px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: MORPH_MS * .6, easing: MORPH_EASE })
}

function hideTip(): void {
  if (tip) tip.hidden = true
}

export function createOutcomeStrip(): OutcomeStrip {
  const element = document.createElement('div')
  element.className = 'oc-line'
  element.hidden = true
  const label = Object.assign(document.createElement('span'), { className: 'oc-label', textContent: 'This session' })
  const cells = Object.assign(document.createElement('span'), { className: 'oc-cells' })
  const passed = document.createElement('b')
  const failed = document.createElement('b')
  const sum = Object.assign(document.createElement('span'), { className: 'oc-sum' })
  const ok = Object.assign(document.createElement('span'), { className: 'ok' })
  const bad = Object.assign(document.createElement('span'), { className: 'bad' })
  ok.append(passed, ' passed')
  bad.append(failed, ' failed')
  sum.append(ok, bad)
  element.append(label, cells, sum)

  let source: string | null = null
  let items: Outcome[] = []
  let last = 0
  let timer = 0
  let generation = 0
  let fits = 0
  let polling = false
  let destroyed = false
  let paintedUpTo = 0

  function paint(): void {
    const shown = fits > 0 ? items.slice(-fits) : []
    if (items.length === 0) cells.replaceChildren(Object.assign(document.createElement('span'), { className: 'oc-empty', textContent: 'No actions yet' }))
    else cells.replaceChildren(...shown.map((outcome) => {
      const cell = square(outcome)
      cell.onmouseenter = () => showTip(cell, outcome)
      cell.onmouseleave = hideTip
      if (paintedUpTo > 0 && outcome.seq > paintedUpTo) cell.animate?.([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.35)', opacity: 1, offset: .7 }, { transform: 'scale(1)' }], { duration: 320, easing: MORPH_EASE })
      return cell
    }))
    paintedUpTo = items.at(-1)?.seq ?? 0
  }

  async function fetchOnce(mine: number): Promise<void> {
    const onScreen = Boolean(element.parentElement?.offsetParent)
    if (source === null || document.visibilityState !== 'visible' || !onScreen) return
    const response = await getJson(`/api/outcomes?${source}&after=${last}`)
    if (mine !== generation) return
    if (response.status === 404) { element.hidden = true; return }
    if (!response.ok) return
    const totals = readRecord(response.data.totals)
    items = mergeOutcomes(items, readArray(response.data.items) as unknown as Outcome[])
    last = typeof response.data.last === 'number' ? response.data.last : last
    rollText(passed, String(totals.passed ?? 0))
    rollText(failed, String(totals.failed ?? 0))
    reveal(element, true, 'center bottom')
    paint()
  }

  async function poll(): Promise<void> {
    if (polling || destroyed) return
    polling = true
    clearTimeout(timer)
    const mine = generation
    try {
      await fetchOnce(mine)
    } finally {
      polling = false
    }
    if (destroyed) return
    if (mine !== generation) void poll()
    else timer = window.setTimeout(() => void poll(), POLL_MS)
  }

  const observer = new ResizeObserver(() => {
    const next = capacity(cells.clientWidth)
    if (next !== fits) { fits = next; paint() }
  })
  observer.observe(cells)

  return {
    element,
    refresh: () => void poll(),
    setSource(next) {
      if (next === source) return
      generation += 1
      source = next
      items = []
      paintedUpTo = 0
      last = 0
      element.hidden = true
      hideTip()
      void poll()
    },
    destroy() {
      destroyed = true
      clearTimeout(timer)
      observer.disconnect()
      hideTip()
      element.remove()
    },
  }
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hideTip)
