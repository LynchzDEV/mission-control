import { afterAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { fitView, followView, mountViewport, scaleRange, zoomAt } from '../client/flow-viewport'

const { window } = new JSDOM('')
Object.assign(globalThis, { window, document: window.document })
afterAll(() => { window.close(); for (const key of ['window', 'document', 'matchMedia']) Reflect.deleteProperty(globalThis, key) })

const wide = { min: 0.35, max: 1.5 }

test('the scale range is 0.35 to 1.5, and reaches 0.2 on a stage narrower than 600px', () => {
  expect(scaleRange(1000)).toEqual(wide)
  expect(scaleRange(600)).toEqual(wide)
  expect(scaleRange(599)).toEqual({ min: 0.2, max: 1.5 })
})

test('fit scales a wide graph to the stage width inside the padding and centres it vertically', () => {
  const view = fitView({ width: 2000, height: 300 }, { width: 1000, height: 400 })
  expect(view.scale).toBeCloseTo(0.484, 3)
  expect(view.x).toBeCloseTo(16, 6)
  expect(view.y).toBeCloseTo((400 - 300 * 0.484) / 2, 6)
})

test('fit never scales a small graph above 1 and centres it', () => {
  expect(fitView({ width: 400, height: 100 }, { width: 1000, height: 400 })).toEqual({ x: 300, y: 150, scale: 1 })
})

test('fit clamped at the minimum puts the entry at the left edge instead of centring', () => {
  const view = fitView({ width: 5000, height: 100 }, { width: 1000, height: 400 })
  expect(view.scale).toBe(0.35)
  expect(view.x).toBe(16)
  expect(fitView({ width: 5000, height: 100 }, { width: 390, height: 400 }).scale).toBe(0.2)
})

test('zoom keeps the point under the pointer still and stops at the range', () => {
  expect(zoomAt({ x: 0, y: 0, scale: 1 }, 2, { x: 100, y: 50 }, wide)).toEqual({ x: -50, y: -25, scale: 1.5 })
  expect(zoomAt({ x: 10, y: 10, scale: 1 }, 1.2, { x: 10, y: 10 }, wide)).toEqual({ x: 10, y: 10, scale: 1.2 })
  expect(zoomAt({ x: 0, y: 0, scale: 0.4 }, 0.1, { x: 0, y: 0 }, wide).scale).toBe(0.35)
})

test('follow centres a box that fits without changing the scale', () => {
  const view = followView({ x: 0, y: 0, scale: 1 }, { x: 800, y: 0, width: 160, height: 52 }, { width: 400, height: 300 }, wide)
  expect(view).toEqual({ x: 200 - 880, y: 150 - 26, scale: 1 })
})

test('follow zooms out for a box wider than the stage, but not below the minimum', () => {
  const view = followView({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0, width: 1000, height: 52 }, { width: 400, height: 300 }, { min: 0.2, max: 1.5 })
  expect(view.scale).toBeCloseTo(0.368, 6)
  expect(view.x).toBeCloseTo(16, 6)
  expect(followView({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0, width: 4000, height: 52 }, { width: 400, height: 300 }, wide).scale).toBe(0.35)
})

type Harness = { stage: HTMLElement; canvas: HTMLElement; zoom: HTMLElement; size: { width: number; height: number }; viewport: ReturnType<typeof mountViewport>; animations: unknown[] }

function harness(width = 1000, animate = false): Harness {
  document.body.innerHTML = `<div id="flow-stage" tabindex="0"><div id="flow-canvas" class="flow-canvas"><div class="flow-step" style="left: 1500px; top: 0px"></div></div><div class="flow-zoom" hidden><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="fit">Fit</button><button type="button" data-zoom="follow" aria-pressed="true">Follow</button></div></div>`
  const stage = document.getElementById('flow-stage')!, canvas = document.getElementById('flow-canvas')!
  const animations: unknown[] = []
  Object.assign(canvas, { animate: (frames: unknown) => { animations.push(frames) } })
  const size = { width, height: 300 }
  const viewport = mountViewport(stage, canvas, { animate: () => animate, size: () => size })
  return { stage, canvas, zoom: stage.querySelector('.flow-zoom')!, size, viewport, animations }
}

const pointer = (target: EventTarget, type: string, pointerId: number, clientX: number, clientY: number) => target.dispatchEvent(new window.PointerEvent(type, { pointerId, clientX, clientY, button: 0, bubbles: true }))
const drag = (stage: HTMLElement, by: number) => { pointer(stage, 'pointerdown', 1, 100, 100); pointer(stage, 'pointermove', 1, 100 + by, 100); pointer(stage, 'pointerup', 1, 100 + by, 100) }
const wheel = (stage: HTMLElement, init: Record<string, unknown>) => { const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 100, clientY: 50, ...init }); stage.dispatchEvent(event); return event }
const key = (target: HTMLElement, name: string) => { const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event }
const followButton = (h: Harness) => h.zoom.querySelector<HTMLButtonElement>('[data-zoom="follow"]')!
const wideGraph = { width: 2000, height: 300 }
const scaleOf = (h: Harness): number => Number(/scale\((.+)\)/.exec(h.canvas.style.transform)![1])

beforeEach(() => { Reflect.deleteProperty(globalThis, 'matchMedia') })

test('the first paint fits the graph, sizes the stage and shows the controls only when the graph does not fit at 1', () => {
  const h = harness()
  h.viewport.paint('small', { width: 400, height: 100 }, null)
  expect(h.canvas.style.transform).toBe('translate(300px, 16px) scale(1)')
  expect(h.stage.style.height).toBe('132px')
  expect(h.zoom.hidden).toBe(true)
  h.viewport.paint('wide', wideGraph, null)
  expect(h.zoom.hidden).toBe(false)
  expect(h.stage.style.height).toBe('178px')
})

test('a drag over 4px pans, turns Follow off, keeps the view on later paints and swallows the click after it', () => {
  const h = harness()
  h.viewport.paint('drag', wideGraph, null)
  const before = h.canvas.style.transform
  const clicks: string[] = []
  h.stage.addEventListener('click', () => clicks.push('click'))
  drag(h.stage, 20)
  h.stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  expect(clicks).toEqual([])
  expect(h.canvas.style.transform).not.toBe(before)
  expect(followButton(h).getAttribute('aria-pressed')).toBe('false')
  const moved = h.canvas.style.transform
  h.viewport.paint('drag', { width: 2200, height: 300 }, { x: 2000, y: 0, width: 160, height: 52 })
  expect(h.canvas.style.transform).toBe(moved)
  drag(h.stage, 3)
  h.stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  expect(clicks).toEqual(['click'])
  expect(h.canvas.style.transform).toBe(moved)
})

test('a drag whose click never arrives does not swallow a later keyboard or programmatic click', async () => {
  const h = harness()
  h.viewport.paint('stray', wideGraph, null)
  const clicks: string[] = []
  h.stage.addEventListener('click', () => clicks.push('click'))
  drag(h.stage, 20)
  await new Promise(resolve => setTimeout(resolve, 0))
  h.stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  expect(clicks).toEqual(['click'])
})

test('two pointers pinch-zoom around their midpoint', () => {
  const h = harness()
  h.viewport.paint('pinch', { width: 400, height: 100 }, null)
  pointer(h.stage, 'pointerdown', 1, 100, 50)
  pointer(h.stage, 'pointerdown', 2, 200, 50)
  pointer(h.stage, 'pointermove', 2, 250, 50)
  expect(h.canvas.style.transform).toBe(`translate(${150 - (150 - 300) * 1.5 - 150 + 175}px, ${50 - (50 - 16) * 1.5}px) scale(1.5)`)
})

test('ctrl or meta + wheel zooms around the pointer and keeps the page still', () => {
  const h = harness()
  h.viewport.paint('wheel-zoom', { width: 400, height: 100 }, null)
  const event = wheel(h.stage, { deltaY: -100, ctrlKey: true })
  expect(event.defaultPrevented).toBe(true)
  const factor = Math.exp(100 * 0.0015)
  expect(h.canvas.style.transform).toBe(`translate(${100 + 200 * factor}px, ${50 - 34 * factor}px) scale(${factor})`)
  wheel(h.stage, { deltaY: 10, deltaMode: 1, metaKey: true })
  expect(h.canvas.style.transform).toContain(`scale(${factor * Math.exp(-160 * 0.0015)})`)
})

test('a plain wheel scrolls the page when the graph fits and pans it when it overflows', () => {
  const h = harness()
  h.viewport.paint('wheel-pan', { width: 400, height: 100 }, null)
  expect(wheel(h.stage, { deltaY: 30 }).defaultPrevented).toBe(false)
  expect(h.canvas.style.transform).toBe('translate(300px, 16px) scale(1)')
  h.viewport.paint('wheel-pan-wide', { width: 3000, height: 1000 }, null)
  const before = h.canvas.style.transform
  expect(wheel(h.stage, { deltaX: 5, deltaY: 30 }).defaultPrevented).toBe(true)
  const at = (transform: string) => transform.match(/translate\((.+)px, (.+)px\)/)!.slice(1).map(Number)
  const [x0, y0] = at(before), [x1, y1] = at(h.canvas.style.transform)
  expect([x1! - x0!, y1! - y0!]).toEqual([-5, -30])
})

test('keys on the stage zoom, pan and fit', () => {
  const h = harness()
  h.viewport.paint('keys', { width: 400, height: 100 }, null)
  expect(key(h.stage, 'ArrowLeft').defaultPrevented).toBe(true)
  expect(h.canvas.style.transform).toBe('translate(340px, 16px) scale(1)')
  key(h.stage, 'ArrowUp')
  expect(h.canvas.style.transform).toBe('translate(340px, 56px) scale(1)')
  key(h.stage, '-')
  expect(scaleOf(h)).toBeCloseTo(1 / 1.2, 9)
  key(h.stage, '=')
  key(h.stage, '+')
  expect(scaleOf(h)).toBeCloseTo(1.2, 9)
  key(h.stage, '0')
  expect(h.canvas.style.transform).toBe('translate(300px, 16px) scale(1)')
  expect(key(h.stage, 'x').defaultPrevented).toBe(false)
})

test('Fit and Follow turn Follow on; Follow toggles off; the zoom buttons zoom around the stage centre', () => {
  const h = harness()
  h.viewport.paint('buttons', wideGraph, null)
  const fitted = h.canvas.style.transform
  h.zoom.querySelector<HTMLButtonElement>('[data-zoom="in"]')!.click()
  expect(h.canvas.style.transform).not.toBe(fitted)
  expect(followButton(h).getAttribute('aria-pressed')).toBe('false')
  h.zoom.querySelector<HTMLButtonElement>('[data-zoom="fit"]')!.click()
  expect(h.canvas.style.transform).toBe(fitted)
  expect(followButton(h).getAttribute('aria-pressed')).toBe('true')
  followButton(h).click()
  expect(followButton(h).getAttribute('aria-pressed')).toBe('false')
  followButton(h).click()
  expect(followButton(h).getAttribute('aria-pressed')).toBe('true')
})

test('pointer presses on the zoom controls never start a pan', () => {
  const h = harness()
  h.viewport.paint('controls', wideGraph, null)
  const before = h.canvas.style.transform
  const fit = h.zoom.querySelector<HTMLButtonElement>('[data-zoom="fit"]')!
  pointer(fit, 'pointerdown', 1, 100, 100)
  pointer(fit, 'pointermove', 1, 140, 100)
  pointer(fit, 'pointerup', 1, 140, 100)
  expect(h.canvas.style.transform).toBe(before)
})

test('with Follow on, a paint follows the working box when it is off screen; the fit still comes first', () => {
  const h = harness(300)
  const content = { width: 1476, height: 52 }
  h.viewport.paint('follow', content, { x: 0, y: 0, width: 160, height: 52 })
  const fitted = `translate(16px, ${(120 - 52 * 0.2) / 2}px) scale(0.2)`
  expect(h.canvas.style.transform).toBe(fitted)
  expect(h.stage.style.height).toBe('120px')
  h.viewport.paint('follow', content, { x: 1316, y: 0, width: 160, height: 52 })
  expect(h.canvas.style.transform).toBe(`translate(${150 - 1396 * 0.2}px, ${60 - 26 * 0.2}px) scale(0.2)`)
  h.viewport.paint('follow', content, { x: 0, y: 0, width: 160, height: 52 })
  expect(h.canvas.style.transform).toBe(fitted)
})

test('programmatic moves animate only when motion is allowed and the OS does not ask for reduced motion', () => {
  const content = { width: 1476, height: 52 }
  const reduced = harness(300, true)
  Object.assign(globalThis, { matchMedia: () => ({ matches: true }) })
  reduced.viewport.paint('reduced', content, { x: 0, y: 0, width: 160, height: 52 })
  reduced.viewport.paint('reduced', content, { x: 1316, y: 0, width: 160, height: 52 })
  expect(reduced.animations).toEqual([])
  const paused = harness(300, false)
  Object.assign(globalThis, { matchMedia: () => ({ matches: false }) })
  paused.viewport.paint('paused', content, { x: 0, y: 0, width: 160, height: 52 })
  paused.viewport.paint('paused', content, { x: 1316, y: 0, width: 160, height: 52 })
  expect(paused.animations).toEqual([])
  const moving = harness(300, true)
  moving.viewport.paint('moving', content, { x: 0, y: 0, width: 160, height: 52 })
  expect(moving.animations).toEqual([])
  moving.viewport.paint('moving', content, { x: 1316, y: 0, width: 160, height: 52 })
  expect(moving.animations).toHaveLength(1)
})

test('focusing a card off screen resets the stage scroll and brings the card into view', () => {
  const h = harness()
  h.viewport.paint('focus', { width: 400, height: 100 }, null)
  h.stage.scrollLeft = 40
  h.stage.querySelector('.flow-step')!.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
  expect(h.stage.scrollLeft).toBe(0)
  expect(h.canvas.style.transform).toBe(`translate(${500 - 1580}px, ${132 / 2 - 26}px) scale(1)`)
})

test('each run keeps its own view for the page life, and forget drops it', () => {
  const h = harness()
  h.viewport.paint('run-a', wideGraph, null)
  drag(h.stage, 30)
  const moved = h.canvas.style.transform
  h.viewport.paint('run-b', wideGraph, null)
  expect(h.canvas.style.transform).not.toBe(moved)
  h.viewport.paint('run-a', wideGraph, null)
  expect(h.canvas.style.transform).toBe(moved)
  h.viewport.forget('run-a')
  h.viewport.paint('run-a', wideGraph, null)
  expect(h.canvas.style.transform).not.toBe(moved)
})

test('a stage with no size is skipped', () => {
  const h = harness(0)
  h.size.height = 0
  h.viewport.paint('hidden', wideGraph, null)
  expect(h.canvas.style.transform).toBe('')
})
