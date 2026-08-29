import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { SESSION_COOKIE, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import {
  DEFAULT_LAYOUT,
  MIN_FLOW_H,
  MIN_PANEL_H,
  MIN_RACK_PX,
  clamp,
  clampFlowH,
  clampPanelH,
  normalizePair,
  normalizeTriple,
  parseLayout,
  recomputePairFr,
  recomputeTripleFr,
  serializeLayout,
} from '../client/resize-layout'

describe('clamp', () => {
  test('passes values already inside the range through unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  test('floors and ceils out-of-range values', () => {
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(30, 0, 10)).toBe(10)
  })
})

describe('clampFlowH / clampPanelH', () => {
  test('never returns below the documented minimum', () => {
    expect(clampFlowH(10, 800)).toBe(MIN_FLOW_H)
    expect(clampPanelH(10, 800)).toBe(MIN_PANEL_H)
  })

  test('never exceeds the given max, even when max is below the minimum', () => {
    expect(clampFlowH(9999, 400)).toBe(400)
    expect(clampFlowH(9999, 50)).toBe(MIN_FLOW_H)
  })
})

describe('serializeLayout / parseLayout', () => {
  test('round-trips a full layout', () => {
    const state = { flowH: 240, panelH: 120, rackFr: [1, 2, 1] as [number, number, number], planFr: [1, 1] as [number, number] }
    expect(parseLayout(serializeLayout(state))).toEqual(state)
  })

  test('returns the default layout for null input', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT)
  })

  test('returns the default layout for corrupt/garbage JSON', () => {
    expect(parseLayout('not json at all {{{')).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout('"just a string"')).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout('null')).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout('[1,2,3]')).toEqual(DEFAULT_LAYOUT)
  })

  test('drops fields with the wrong shape but keeps the rest', () => {
    const raw = JSON.stringify({ flowH: 200, rackFr: ['a', 'b', 'c'], planFr: [1, 2, 3] })
    expect(parseLayout(raw)).toEqual({ flowH: 200, panelH: null, rackFr: null, planFr: null })
  })
})

describe('recomputeTripleFr', () => {
  test('keeps the total fr constant across the divider move', () => {
    const fr: [number, number, number] = [1, 1, 1]
    const next = recomputeTripleFr(fr, 900, 0, 60, MIN_RACK_PX)
    expect(next[0] + next[1] + next[2]).toBeCloseTo(fr[0] + fr[1] + fr[2], 6)
  })

  test('moving the first divider right grows rack 1 and shrinks rack 2, leaving rack 3 untouched', () => {
    const fr: [number, number, number] = [1, 1, 1]
    const next = recomputeTripleFr(fr, 900, 0, 90, MIN_RACK_PX)
    expect(next[0]).toBeGreaterThan(fr[0])
    expect(next[1]).toBeLessThan(fr[1])
    expect(next[2]).toBe(fr[2])
  })

  test('clamps so neither side crosses the minimum pixel width', () => {
    const fr: [number, number, number] = [1, 1, 1]
    const next = recomputeTripleFr(fr, 900, 0, 100_000, MIN_RACK_PX)
    const pxPerFr = 900 / 3
    expect(next[1] * pxPerFr).toBeGreaterThanOrEqual(MIN_RACK_PX - 0.01)
  })

  test('is a no-op when the container has no usable width', () => {
    const fr: [number, number, number] = [1, 1, 1]
    expect(recomputeTripleFr(fr, 0, 0, 50, MIN_RACK_PX)).toEqual(fr)
  })
})

describe('recomputePairFr', () => {
  test('keeps the total fr constant', () => {
    const fr: [number, number] = [1, 1]
    const next = recomputePairFr(fr, 600, 40, MIN_PANEL_H)
    expect(next[0] + next[1]).toBeCloseTo(fr[0] + fr[1], 6)
  })

  test('clamps against the minimum pixel width on both sides', () => {
    const fr: [number, number] = [1, 1]
    const grown = recomputePairFr(fr, 600, 100_000, MIN_PANEL_H)
    const shrunk = recomputePairFr(fr, 600, -100_000, MIN_PANEL_H)
    const pxPerFr = 600 / 2
    expect(grown[1] * pxPerFr).toBeGreaterThanOrEqual(MIN_PANEL_H - 0.01)
    expect(shrunk[0] * pxPerFr).toBeGreaterThanOrEqual(MIN_PANEL_H - 0.01)
  })
})

describe('normalizeTriple / normalizePair', () => {
  test('normalizes so the average is 1, preserving ratios', () => {
    const [a, b, c] = normalizeTriple([2, 4, 6])
    expect(a + b + c).toBeCloseTo(3, 6)
    expect(b / a).toBeCloseTo(2, 6)
    expect(c / a).toBeCloseTo(3, 6)
  })

  test('falls back to equal shares for a zero/negative sum', () => {
    expect(normalizeTriple([0, 0, 0])).toEqual([1, 1, 1])
    expect(normalizePair([0, 0])).toEqual([1, 1])
  })

  test('normalizePair keeps the ratio between the two panes', () => {
    const [a, b] = normalizePair([1, 3])
    expect(a + b).toBeCloseTo(2, 6)
    expect(b / a).toBeCloseTo(3, 6)
  })
})

const PASSWORD = 'correct-horse-battery'

describe('lanes view: dividers + resize island', () => {
  let dir: string
  let app: Elysia
  let cookie: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mc-resize-'))
    process.env.MISSION_CONTROL_CONFIG_DIR = dir
    resetLoginLimiter()
    app = await createApp()

    const setup = await app.handle(
      new Request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    )
    const jar = setup.headers.getSetCookie()
    cookie = (jar.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) as string).split(';')[0] as string
  })

  afterEach(async () => {
    delete process.env.MISSION_CONTROL_CONFIG_DIR
    resetLoginLimiter()
    await rm(dir, { recursive: true, force: true })
  })

  test('/lanes serves all five divider elements and the resize island script', async () => {
    const response = await app.handle(new Request('http://localhost/lanes', { headers: { cookie } }))
    const html = await response.text()

    for (const kind of ['flow', 'panel', 'rack-1', 'rack-2', 'plan']) {
      expect(html).toContain(`data-resize="${kind}"`)
    }
    expect(html).toContain('mc-divider-h')
    expect(html).toContain('mc-divider-v')
    expect(html).toContain('role="separator"')
    expect(html).toContain('/js/resize.js')
  })

  test('/js/resize.js transpiles to browser javascript with no leftover TS syntax', async () => {
    const response = await app.handle(new Request('http://localhost/js/resize.js', { headers: { cookie } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const code = await response.text()
    expect(code).toContain('mc.lanes.layout')
    expect(code).toContain('pointerdown')
    expect(code).not.toContain('./resize-layout')
    expect(code).not.toContain(': LayoutState')
  })

  test('/js/lanes.js still transpiles cleanly alongside the new island', async () => {
    const response = await app.handle(new Request('http://localhost/js/lanes.js', { headers: { cookie } }))
    expect(response.status).toBe(200)
    const code = await response.text()
    expect(code).toContain('installLanes')
  })
})
