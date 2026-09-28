import { STEP_H, STEP_W, type Box } from './flow-graph'

export type View = { x: number; y: number; scale: number }
type Size = { width: number; height: number }
type Range = { min: number; max: number }
type Point = { x: number; y: number }
type RunState = { view: View | null; follow: boolean; moved: boolean }
type ViewportOptions = { animate: () => boolean; size?: () => Size }

const PADDING = 16
const MIN_SCALE = 0.35
const NARROW_MIN_SCALE = 0.2
const NARROW_STAGE = 600
const MAX_SCALE = 1.5
const MIN_STAGE_HEIGHT = 120
const MAX_STAGE_HEIGHT = 420
const STAGE_VIEWPORT_SHARE = 0.46
const CLICK_SLOP = 4
const WHEEL_ZOOM_RATE = 0.0015
const WHEEL_LINE_PX = 16
const KEY_ZOOM = 1.2
const KEY_PAN = 40
const MOVE_MS = 260

export function scaleRange(stageWidth: number): Range {
  return { min: stageWidth < NARROW_STAGE ? NARROW_MIN_SCALE : MIN_SCALE, max: MAX_SCALE }
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

export function fitView(content: Size, stage: Size, padding = PADDING): View {
  const range = scaleRange(stage.width)
  const fits = Math.min(1, (stage.width - 2 * padding) / content.width, (stage.height - 2 * padding) / content.height)
  const scale = Math.max(range.min, fits)
  const centred = (room: number, length: number): number => room >= length ? (room - length) / 2 : padding
  const x = fits < range.min ? padding : centred(stage.width, content.width * scale)
  return { x, y: centred(stage.height, content.height * scale), scale }
}

export function zoomAt(view: View, factor: number, point: Point, range: Range): View {
  const scale = clamp(view.scale * factor, range.min, range.max)
  const ratio = scale / view.scale
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, scale }
}

export function followView(view: View, box: Box, stage: Size, range: Range): View {
  const fits = Math.min((stage.width - 2 * PADDING) / box.width, (stage.height - 2 * PADDING) / box.height)
  const scale = box.width * view.scale > stage.width ? Math.max(range.min, Math.min(view.scale, fits)) : view.scale
  return { x: stage.width / 2 - (box.x + box.width / 2) * scale, y: stage.height / 2 - (box.y + box.height / 2) * scale, scale }
}

function boxVisible(view: View, box: Box, stage: Size): boolean {
  const left = view.x + box.x * view.scale, top = view.y + box.y * view.scale
  return left >= 0 && top >= 0 && left + box.width * view.scale <= stage.width && top + box.height * view.scale <= stage.height
}

const transformOf = (view: View): string => `translate(${view.x}px, ${view.y}px) scale(${view.scale})`

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

type Anchor = { before: Point; after: Point }

export function mountViewport(stage: HTMLElement, canvas: HTMLElement, options: ViewportOptions): { paint(runId: string, content: Size, focus: Box | null, anchor?: Anchor): void; forget(runId: string): void } {
  const size = options.size ?? ((): Size => ({ width: stage.clientWidth, height: stage.clientHeight }))
  const controls = stage.querySelector<HTMLElement>('.flow-zoom')
  const followButton = controls?.querySelector<HTMLButtonElement>('[data-zoom="follow"]') ?? null
  const runs = new Map<string, RunState>()
  const pointers = new Map<number, Point>()
  let state: RunState = { view: null, follow: true, moved: false }
  let content: Size = { width: 0, height: 0 }
  let focus: Box | null = null
  let height = MIN_STAGE_HEIGHT
  let gesture: { view: View; start: Point; distance: number } | null = null
  let panned = false
  let swallowClick = false

  const stageBox = (): Size => ({ width: size().width, height })
  const range = (): Range => scaleRange(size().width)
  const heightCap = (): number => Math.min(window.innerHeight * STAGE_VIEWPORT_SHARE, MAX_STAGE_HEIGHT)
  const heightFor = (scale: number): number => Math.ceil(clamp(content.height * scale + 2 * PADDING, MIN_STAGE_HEIGHT, Math.max(MIN_STAGE_HEIGHT, heightCap())))

  function fitted(): View {
    const width = size().width
    height = heightFor(fitView(content, { width, height: heightCap() }).scale)
    return fitView(content, { width, height })
  }

  function paintControls(view: View): void {
    if (followButton) followButton.setAttribute('aria-pressed', String(state.follow))
    if (!controls) return
    const overflows = content.width * view.scale + 2 * PADDING > size().width || content.height * view.scale + 2 * PADDING > height
    controls.hidden = fitView(content, { width: size().width, height: heightCap() }).scale === 1 && !overflows
  }

  function apply(view: View, animate: boolean): void {
    const before = canvas.style.transform
    const after = transformOf(view)
    state.view = view
    stage.style.height = `${height}px`
    canvas.style.transform = after
    paintControls(view)
    if (animate && before && before !== after && options.animate() && !reducedMotion() && typeof canvas.animate === 'function') {
      canvas.animate([{ transform: before }, { transform: after }], { duration: MOVE_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    }
  }

  function settle(animate: boolean): void {
    if (!size().width || !content.width) return
    const first = !state.view
    let view = state.moved && state.view ? state.view : fitted()
    if (state.follow && focus && !boxVisible(view, focus, stageBox())) view = followView(view, focus, stageBox(), range())
    apply(view, animate && !first)
  }

  function userMoved(view: View): void {
    state.moved = true
    state.follow = false
    height = heightFor(view.scale)
    apply(view, false)
  }

  function stagePoint(event: { clientX: number; clientY: number }): Point {
    const rect = stage.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const current = (): View | null => state.view

  function zoomBy(factor: number, point: Point): void {
    const view = current()
    if (view) userMoved(zoomAt(view, factor, point, range()))
  }

  function panBy(dx: number, dy: number): void {
    const view = current()
    if (view) userMoved({ ...view, x: view.x + dx, y: view.y + dy })
  }

  function fitNow(): void {
    state.moved = false
    state.follow = true
    settle(true)
  }

  function toggleFollow(): void {
    state.follow = !state.follow
    if (state.follow) settle(true)
    else paintControls(current() ?? { x: 0, y: 0, scale: 1 })
  }

  const centre = (): Point => ({ x: size().width / 2, y: height / 2 })
  const buttons: Record<string, () => void> = { in: () => zoomBy(KEY_ZOOM, centre()), out: () => zoomBy(1 / KEY_ZOOM, centre()), fit: fitNow, follow: toggleFollow }
  controls?.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-zoom]')
    buttons[button?.dataset.zoom ?? '']?.()
  })

  function pinchCentre(): { at: Point; distance: number } {
    const [a, b] = [...pointers.values()] as [Point, Point]
    return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) }
  }

  function startGesture(): void {
    const view = current()
    if (!view) { gesture = null; return }
    const pinch = pointers.size > 1 ? pinchCentre() : null
    gesture = { view, start: pinch?.at ?? [...pointers.values()][0]!, distance: pinch?.distance ?? 0 }
  }

  stage.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('.flow-zoom') || event.button !== 0) return
    if (!pointers.size) { panned = false; swallowClick = false }
    pointers.set(event.pointerId, stagePoint(event))
    try { stage.setPointerCapture(event.pointerId) } catch {}
    startGesture()
  })

  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId) || !gesture) return
    pointers.set(event.pointerId, stagePoint(event))
    if (pointers.size > 1) {
      const pinch = pinchCentre()
      const zoomed = zoomAt(gesture.view, pinch.distance / (gesture.distance || 1), gesture.start, range())
      panned = true
      userMoved({ ...zoomed, x: zoomed.x + pinch.at.x - gesture.start.x, y: zoomed.y + pinch.at.y - gesture.start.y })
      return
    }
    const at = pointers.get(event.pointerId)!
    const dx = at.x - gesture.start.x, dy = at.y - gesture.start.y
    if (!panned && Math.hypot(dx, dy) <= CLICK_SLOP) return
    if (!panned) gesture = { ...gesture, view: current() ?? gesture.view }
    panned = true
    userMoved({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy })
  })

  function release(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) return
    try { stage.releasePointerCapture(event.pointerId) } catch {}
    if (panned) {
      swallowClick = true
      setTimeout(() => { swallowClick = false }, 0)
    }
    startGesture()
  }
  stage.addEventListener('pointerup', release)
  stage.addEventListener('pointercancel', release)

  stage.addEventListener('click', (event) => {
    if (!swallowClick) return
    swallowClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }, { capture: true })

  stage.addEventListener('wheel', (event) => {
    const view = current()
    if (!view) return
    const lines = event.deltaMode === 1 ? WHEEL_LINE_PX : 1
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      zoomBy(Math.exp(-event.deltaY * lines * WHEEL_ZOOM_RATE), stagePoint(event))
      return
    }
    const overflows = content.width * view.scale > size().width || content.height * view.scale > height
    if (!overflows) return
    event.preventDefault()
    panBy(-event.deltaX * lines, -event.deltaY * lines)
  }, { passive: false })

  const keys: Record<string, () => void> = {
    '=': () => zoomBy(KEY_ZOOM, centre()), '+': () => zoomBy(KEY_ZOOM, centre()), '-': () => zoomBy(1 / KEY_ZOOM, centre()), '0': fitNow,
    ArrowLeft: () => panBy(KEY_PAN, 0), ArrowRight: () => panBy(-KEY_PAN, 0), ArrowUp: () => panBy(0, KEY_PAN), ArrowDown: () => panBy(0, -KEY_PAN),
  }
  stage.addEventListener('keydown', (event) => {
    const action = keys[event.key]
    if (!action || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    action()
  })

  stage.addEventListener('focusin', (event) => {
    const card = (event.target as Element).closest<HTMLElement>('.flow-step')
    const view = current()
    if (!card || !view) return
    stage.scrollLeft = 0
    stage.scrollTop = 0
    const box = { x: parseFloat(card.style.left) || 0, y: parseFloat(card.style.top) || 0, width: STEP_W, height: STEP_H }
    if (!boxVisible(view, box, stageBox())) userMoved(followView(view, box, stageBox(), range()))
  })

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => settle(false)).observe(stage)

  function select(runId: string): void {
    const saved = runs.get(runId)
    if (saved === state) return
    state = saved ?? { view: null, follow: true, moved: false }
    runs.set(runId, state)
    canvas.style.transform = ''
  }

  return {
    paint(runId, nextContent, nextFocus, anchor) {
      select(runId)
      content = nextContent
      focus = nextFocus
      if (anchor && state.view) {
        const { x, y, scale } = state.view
        state.view = { x: x - (anchor.after.x - anchor.before.x) * scale, y: y - (anchor.after.y - anchor.before.y) * scale, scale }
        state.moved = true
      }
      if (state.view && state.moved) height = heightFor(state.view.scale)
      settle(true)
    },
    forget(runId) {
      if (runs.get(runId) === state) state = { view: null, follow: true, moved: false }
      runs.delete(runId)
    },
  }
}
