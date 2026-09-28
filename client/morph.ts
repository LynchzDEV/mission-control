export const MORPH_MS = 240
export const MORPH_EASE = 'cubic-bezier(.2, .8, .2, 1)'
const timing: KeyframeAnimationOptions = { duration: MORPH_MS, easing: MORPH_EASE }

const still = (): boolean => typeof matchMedia === 'undefined' || matchMedia('(prefers-reduced-motion: reduce)').matches
const onScreen = (el: HTMLElement): boolean => el.isConnected && el.getClientRects().length > 0

export type Snapshot = { width: number; height: number; backgroundColor: string; color: string; borderRadius: string }

export function snapshot(el: HTMLElement): Snapshot {
  const { width, height } = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  return { width, height, backgroundColor: style.backgroundColor, color: style.color, borderRadius: style.borderRadius }
}

export function morphFrom(el: HTMLElement, from: Snapshot): void {
  if (still() || !onScreen(el)) return
  const to = snapshot(el)
  if (from.width === to.width && from.height === to.height && from.backgroundColor === to.backgroundColor && from.color === to.color) return
  el.classList.add('morphing')
  el.animate([
    { width: `${from.width}px`, height: `${from.height}px`, backgroundColor: from.backgroundColor, color: from.color, borderRadius: from.borderRadius },
    { width: `${to.width}px`, height: `${to.height}px`, backgroundColor: to.backgroundColor, color: to.color, borderRadius: to.borderRadius },
  ], timing).onfinish = () => el.classList.remove('morphing')
  for (const child of el.children) (child as HTMLElement).animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], timing)
}

export function morph(el: HTMLElement, apply: () => void): void {
  if (still() || !onScreen(el)) { apply(); return }
  const from = snapshot(el)
  apply()
  morphFrom(el, from)
}

export function reveal(el: HTMLElement, show: boolean, origin = 'center', base = ''): void {
  if (el.hidden === !show) return
  if (still()) { el.hidden = !show; return }
  el.style.transformOrigin = origin
  if (show) {
    el.hidden = false
    el.animate([{ opacity: 0, transform: `${base} scale(.92)`, filter: 'blur(2px)' }, { opacity: 1, transform: base || 'none', filter: 'none' }], timing)
    return
  }
  el.animate([{ opacity: 1, transform: base || 'none' }, { opacity: 0, transform: `${base} scale(.94)` }], { ...timing, duration: MORPH_MS * .75 }).onfinish = () => { el.hidden = true }
}

export function fold(el: HTMLElement, done: () => void = () => { el.hidden = true }): void {
  if (still() || !onScreen(el)) { done(); return }
  const { height } = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  el.style.overflow = 'hidden'
  el.animate([
    { height: `${height}px`, opacity: 1, marginTop: style.marginTop, marginBottom: style.marginBottom, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom },
    { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' },
  ], timing).onfinish = () => { el.style.overflow = ''; done() }
}

export function settleIn(el: HTMLElement): void {
  if (still() || !onScreen(el)) return
  el.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], timing)
}

export function blendColor(el: HTMLElement, from: string | undefined): void {
  if (!from || still() || !onScreen(el)) return
  const to = getComputedStyle(el).backgroundColor
  if (to !== from) el.animate([{ backgroundColor: from }, { backgroundColor: to }], timing)
}

export function glide(host: HTMLElement, from: HTMLElement, to: HTMLElement, className: string): void {
  if (still() || !onScreen(from) || !onScreen(to)) return
  const base = host.getBoundingClientRect()
  const place = (el: HTMLElement): Keyframe => { const box = el.getBoundingClientRect(); return { top: `${box.top - base.top + host.scrollTop}px`, left: `${box.left - base.left}px`, width: `${box.width}px`, height: `${box.height}px` } }
  const ghost = Object.assign(document.createElement('div'), { className })
  host.prepend(ghost)
  to.classList.add('arriving')
  ghost.animate([place(from), place(to)], timing).onfinish = () => { ghost.remove(); to.classList.remove('arriving') }
}

export function rollText(el: HTMLElement, text: string): void {
  if (el.textContent === text) return
  el.textContent = text
  if (still() || !onScreen(el)) return
  el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], timing)
}
