import { afterAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const { window } = new JSDOM('')
Object.assign(globalThis, { window, document: window.document, requestAnimationFrame: (cb: FrameRequestCallback): number => { cb(0); return 0 } })
const { collectRowStates, rowScrollOf, setRowScroll, trackRowScroll } = await import('../client/tool-row-scroll')
afterAll(() => { window.close(); Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'document') })

function toolReply(rowOpen: boolean, stepsOpen = true): { reply: HTMLElement; steps: HTMLDetailsElement; row: HTMLDetailsElement; out: HTMLElement } {
  const reply = document.createElement('div')
  const steps = document.createElement('details')
  steps.className = 'turn-steps'
  steps.open = stepsOpen
  const row = document.createElement('details')
  row.className = 'tool-row'
  row.dataset.key = '0'
  row.open = rowOpen
  const detail = document.createElement('div')
  detail.className = 'tool-detail'
  const out = document.createElement('pre')
  out.className = 'term-out'
  const card = document.createElement('div')
  card.className = 'tool-card'
  detail.append(out)
  row.append(document.createElement('summary'), detail)
  card.append(row)
  steps.append(card)
  reply.append(steps)
  trackRowScroll(row)
  return { reply, steps, row, out }
}

const scrollTo = (out: HTMLElement, top: number): void => {
  out.scrollTop = top
  out.dispatchEvent(new window.Event('scroll'))
}

describe('tool row scroll state across rebuilds', () => {
  test('a scrolled row keeps its position through a rebuild while collapsed', () => {
    const old = toolReply(true)
    scrollTo(old.out, 150)
    expect(old.row.dataset.scroll).toBe('150')
    old.row.open = false
    const state = collectRowStates(old.reply).get('0')!
    expect(state).toEqual({ open: false, scrollTop: 150 })

    const fresh = toolReply(false)
    fresh.row.open = state.open
    setRowScroll(fresh.row, state.scrollTop)
    fresh.row.open = true
    fresh.row.dispatchEvent(new window.Event('toggle'))
    expect(fresh.out.scrollTop).toBe(150)
  })

  test('a row left open under a collapsed steps list restores when the list opens', () => {
    const old = toolReply(true)
    scrollTo(old.out, 90)
    old.steps.open = false
    expect(collectRowStates(old.reply).get('0')).toEqual({ open: true, scrollTop: 90 })

    const fresh = toolReply(true, false)
    setRowScroll(fresh.row, 90)
    fresh.steps.open = true
    fresh.steps.dispatchEvent(new window.Event('toggle'))
    expect(fresh.out.scrollTop).toBe(90)
  })

  test('scrolling again replaces the saved position', () => {
    const old = toolReply(true)
    scrollTo(old.out, 40)
    scrollTo(old.out, 260)
    old.row.open = false
    expect(rowScrollOf(old.row)).toBe(260)
  })

  test('a row nobody scrolled reports zero', () => {
    expect(collectRowStates(toolReply(true).reply).get('0')).toEqual({ open: true, scrollTop: 0 })
  })
})
