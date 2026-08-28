import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { SESSION_COOKIE, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'

const PASSWORD = 'correct-horse-battery'

let dir: string
let app: Elysia
let cookie: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-views-'))
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

async function render(path: string): Promise<{ status: number; html: string }> {
  const response = await app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }))
  return { status: response.status, html: await response.text() }
}

const PAGES: [string, string[]][] = [
  [
    '/lanes',
    [
      'id="nd-spec"',
      'id="nd-impl"',
      'id="nd-codex"',
      'id="nd-verify"',
      'id="nd-merged"',
      'AT THIS STATION',
      'TECH LEAD',
      'JUNIOR FLEET',
      'OUTSIDE CRITIC',
      'id="m1"',
      'id="m2"',
      'id="m3"',
      'id="fsvg"',
      'id="chips"',
    ],
  ],
  [
    '/settings',
    ['API TOKEN', 'BASE URL', 'MODEL MAP', 'CONNECTION', 'class="applab"', 'GLM PEAK', 'id="bind"'],
  ],
  ['/dispatch', ['id="dispatch-form"', 'id="jobs-body"', 'id="log-drawer"', 'id="prompt"']],
  ['/terminals', ['id="term-strip"', 'id="term-pane"', 'id="term-form"', 'id="term-engine"', 'id="term-cwd"']],
  ['/review', ['id="review-body"', 'REVIEW QUEUE']],
]

describe('tab views', () => {
  for (const [path, markers] of PAGES) {
    test(`${path} renders with its markers`, async () => {
      const { status, html } = await render(path)
      expect(status).toBe(200)
      expect(html.startsWith('<!doctype html>')).toBe(true)
      for (const marker of markers) expect(html).toContain(marker)
    })
  }

  test('every tab links the theme and carries the tab nav', async () => {
    for (const [path] of PAGES) {
      const { html } = await render(path)
      expect(html).toContain('href="/theme-tokens.css"')
      expect(html).toContain('href="/theme.css"')
      expect(html).toContain('data-key="1"')
      expect(html).toContain('data-key="5"')
      expect(html).toContain('/js/nav.js')
    }
  })

  test('lanes serves the mascot vendor scripts and no CDN url', async () => {
    const { html } = await render('/lanes')
    expect(html).toContain('/vendor/textmode.umd.js')
    expect(html).toContain('/vendor/textmode.filters.umd.js')
    expect(html).toContain('/vendor/anime.umd.min.js')
    expect(html).not.toContain('cdn.jsdelivr.net')
    expect(html).not.toContain('fonts.googleapis.com')
  })

  test('terminals serves the vendored xterm assets and its island', async () => {
    const { html } = await render('/terminals')
    expect(html).toContain('/vendor/xterm.js')
    expect(html).toContain('/vendor/addon-fit.js')
    expect(html).toContain('href="/vendor/xterm.css"')
    expect(html).toContain('/js/terminal.js')
    expect(html).not.toContain('cdn.jsdelivr.net')
  })

  test('every tab marks its own tab active exactly once', async () => {
    for (const [path] of PAGES) {
      const { html } = await render(path)
      expect(html.match(/class="on" data-key=/g)?.length).toBe(1)
      expect(html).toContain(`<a href="${path}" class="on" data-key=`)
    }
  })

  test('unauthenticated tab requests are redirected to the gate', async () => {
    for (const [path] of PAGES) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/')
    }
  })
})

describe('gate views', () => {
  test('setup and login render through the shell without tab chrome', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'mc-gate-'))
    process.env.MISSION_CONTROL_CONFIG_DIR = fresh
    const gateApp = await createApp()

    const setup = await (await gateApp.handle(new Request('http://localhost/'))).text()
    expect(setup).toContain('data-page="setup"')
    expect(setup).toContain('data-action="/api/setup"')
    expect(setup).not.toContain('class="tabs"')

    await gateApp.handle(
      new Request('http://localhost/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    )

    const login = await (await gateApp.handle(new Request('http://localhost/'))).text()
    expect(login).toContain('data-page="login"')
    expect(login).toContain('data-action="/api/login"')

    await rm(fresh, { recursive: true, force: true })
  })
})

describe('client islands', () => {
  const ISLANDS = ['nav', 'forms', 'sprites', 'flow', 'lanes', 'dispatch']

  for (const island of ISLANDS) {
    test(`/js/${island}.js transpiles to browser javascript`, async () => {
      const response = await app.handle(new Request(`http://localhost/js/${island}.js`))
      expect(response.status).toBe(200)
      const code = await response.text()
      expect(code.length).toBeGreaterThan(200)
      expect(code).not.toContain('import {')
      expect(code).not.toContain(': string')
    })
  }
})

describe('flow route', () => {
  test('serves the placeholder session map behind the session guard', async () => {
    expect((await app.handle(new Request('http://localhost/api/flow'))).status).toBe(401)

    const response = await app.handle(
      new Request('http://localhost/api/flow', { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      source: string
      current: string
      sessions: Record<string, Record<string, [string, string]>>
    }
    expect(body.source).toBe('placeholder')
    expect(Object.keys(body.sessions)).toContain('moni-audio-v2')
    expect(body.sessions[body.current]).toBeDefined()
    expect(body.sessions['hermez-fb-retry']?.spec?.[0]).toBe('active')
  })
})
