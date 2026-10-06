import type { Terminal } from '@xterm/xterm'
import { dragLines, scrollAction } from './terminal-state'

const DOM_DELTA_LINE = 1

export function mouseTracking(terminal: Terminal): boolean {
  return terminal.modes.mouseTrackingMode !== 'none'
}

export function scrollTerminal(terminal: Terminal, direction: 'up' | 'down', lines: number): void {
  const action = scrollAction(mouseTracking(terminal), direction, lines)
  if (action.kind === 'lines') { terminal.scrollLines(action.amount); return }
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || action.deltaY === 0) return
  const box = screen.getBoundingClientRect()
  screen.dispatchEvent(new WheelEvent('wheel', { deltaY: action.deltaY, deltaMode: DOM_DELTA_LINE, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true }))
}

function cellHeight(terminal: Terminal): number {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  return screen && terminal.rows > 0 ? screen.clientHeight / terminal.rows : 0
}

export function attachTouchScroll(terminal: Terminal, target: HTMLElement): void {
  let lastY: number | null = null
  let pending = 0
  target.addEventListener('touchstart', (event) => {
    lastY = event.touches.length === 1 ? event.touches[0].clientY : null
    pending = 0
  }, { passive: true })
  target.addEventListener('touchmove', (event) => {
    if (lastY === null || event.touches.length !== 1) return
    event.preventDefault()
    const y = event.touches[0].clientY
    const step = dragLines(pending + lastY - y, cellHeight(terminal))
    lastY = y
    pending = step.rest
    if (step.lines !== 0) scrollTerminal(terminal, step.lines < 0 ? 'up' : 'down', Math.abs(step.lines))
  }, { passive: false })
  const end = (): void => { lastY = null; pending = 0 }
  target.addEventListener('touchend', end, { passive: true })
  target.addEventListener('touchcancel', end, { passive: true })
}
