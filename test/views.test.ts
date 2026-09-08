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
  const response = await app.handle(new Request(`http://localhost${path}?embed=1`, { headers: { cookie } }))
  return { status: response.status, html: await response.text() }
}

const PAGES: [string, string[]][] = [
  ['/lanes', ['id="work-view"', 'id="work-list"', 'id="work-selected"', 'id="work-filter"', 'id="usage-view"']],
  ['/settings', ['Connections', 'Work defaults', 'Access', 'id="bind"']],
  ['/dispatch', ['id="dispatch-form"', 'id="prompt"', 'Isolated worktree', 'id="work-list"']],
  ['/terminals', ['id="term-pane"', 'id="term-strip"', 'id="term-form"', 'id="agent-sidebar"', 'id="ascii-horizon"']],
  ['/review', ['id="work-view"', 'data-mode="review"']],
]

const ISLAND_MARKERS: [string, string[]][] = [
  [
    'agents.js',
    ['mc-drawer', '/thread', '/reply', 'Reply to this agent'],
  ],
  ['awareness.js', ['"mini"', 'waiting for response', '/thread', 'mc:agent-open']],
  ['dispatch.js', ['work-selected', '/thread', '/reply', '/land', 'worktree']],
  ['flow.js', ['/thread', 'activity-feed', 'mcd-tx']],
]

describe('transcript islands', () => {
  for (const [file, markers] of ISLAND_MARKERS) {
    test(`/js/${file} ships the shared transcript renderer`, async () => {
      const response = await app.handle(new Request(`http://localhost/js/${file}`, { headers: { cookie } }))
      expect(response.status).toBe(200)
      const code = await response.text()
      for (const marker of markers) {
        expect(code).toContain(marker)
      }
    })
  }

  test('the lanes mount carries no reply box and no drawer chrome', async () => {
    const lanes = await (
      await app.handle(new Request('http://localhost/js/flow.js', { headers: { cookie } }))
    ).text()
    expect(lanes).not.toContain('Reply to this agent')
    expect(lanes).not.toContain('/reply')
    expect(lanes).not.toContain('mc-drawer')
  })

  test('the agents island carries only the drawer, never the retired activity panel', async () => {
    const agents = await (
      await app.handle(new Request('http://localhost/js/agents.js', { headers: { cookie } }))
    ).text()
    expect(agents).toContain('\u21e7\u21b5 newline')
    expect(agents).not.toContain('"mini"')
    expect(agents).not.toContain('agents-panel')
  })
})

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
      if (path === '/terminals') {
        expect(html).toContain('data-key="1"')
        expect(html).toContain('href="/settings"')
      } else {
        expect(html).not.toContain('id="tabs"')
        expect(html).toContain('class="embedded-view"')
      }
      expect(html).toContain('/js/nav.js')
    }
  })

  test('lanes ships no hard-coded station rows or invented counters', async () => {
    const { html } = await render('/lanes')
    expect(html).not.toContain('class="task"')
    expect(html).not.toContain('orders-export')
    expect(html).not.toContain('moni-audio')
    expect(html).toContain('id="work-status"')
  })

  test('overview serves local motion assets without mascot or CDN scripts', async () => {
    const { html } = await render('/lanes')
    expect(html).not.toContain('/vendor/textmode.umd.js')
    expect(html).not.toContain('/vendor/textmode.filters.umd.js')
    expect(html).toContain('/js/work.js')
    expect(html).not.toContain('cdn.jsdelivr.net')
    expect(html).not.toContain('fonts.googleapis.com')
  })

  test('settings renders the role selects with stored engines preselected', async () => {
    await app.handle(
      new Request('http://localhost/api/roles', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'codex', execute: 'claude', review: 'glm' }),
      }),
    )
    const { html } = await render('/settings')
    expect(html).toContain('Work defaults')
    expect(html).toContain('data-post="/api/roles"')
    expect(html).toMatch(/<select id="plan"[^>]*>(?:(?!<\/select>).)*<option value="codex" selected/s)
    expect(html).toMatch(/<select id="execute"[^>]*>(?:(?!<\/select>).)*<option value="claude" selected/s)
    expect(html).toMatch(/<select id="review"[^>]*>(?:(?!<\/select>).)*<option value="glm" selected/s)

    const terminals = await render('/terminals')
    expect(terminals.html).toMatch(/<option value="codex" selected/)
    const dispatch = await render('/dispatch')
    expect(dispatch.html).toMatch(/<option value="claude" selected/)
  })

  test('settings renders per-role model pickers with stored values, the lists script, and the extended save fields', async () => {
    await app.handle(
      new Request('http://localhost/api/roles', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          plan: { engine: 'claude', model: 'opus' },
          execute: 'glm',
          review: { engine: 'codex', model: 'gpt-z-custom' },
        }),
      }),
    )
    const { html } = await render('/settings')
    expect(html).toContain('<select class="model-pick" id="plan_model_pick"')
    expect(html).toContain('<option value="opus" selected')
    expect(html).toContain('>custom…</option>')
    expect(html).toContain('<script type="application/json" id="model-lists">')
    expect(html).toMatch(/<input id="plan_model" name="plan_model"[^>]*value="opus"[^>]*hidden\/>/)
    expect(html).toMatch(/<input id="review_model" name="review_model"[^>]*value="gpt-z-custom"/)
    expect(html).not.toMatch(/<input id="review_model" name="review_model"[^>]*hidden/)
    expect(html).toContain('data-fields="plan,execute,review,plan_model,execute_model,review_model,autoReview"')
    expect(html).toContain('blank model uses the engine default')
  })

  test('settings renders the auto-review opt-in with config-selected state', async () => {
    const before = await render('/settings')
    expect(before.html).toContain('Automatic review')
    expect(before.html).toContain('id="autoReview"')
    expect(before.html).toContain('Work defaults')
    expect(before.html).toMatch(/<option value="off" selected/)
    expect(before.html).not.toMatch(/<option value="on" selected/)

    const post = await app.handle(
      new Request('http://localhost/api/roles', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'claude', execute: 'glm', review: 'codex', autoReview: 'on' }),
      }),
    )
    expect(post.status).toBe(200)

    const after = await render('/settings')
    expect(after.html).toMatch(/<option value="on" selected/)
    expect(after.html).not.toMatch(/<option value="off" selected/)
  })

  test('dispatch and terminals render the model input preloaded with the role default', async () => {
    await app.handle(
      new Request('http://localhost/api/roles', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          plan: { engine: 'claude', model: 'haiku' },
          execute: { engine: 'glm', model: 'glm-5.3-flash' },
          review: 'codex',
        }),
      }),
    )
    const dispatch = await render('/dispatch')
    expect(dispatch.html).toMatch(/<input id="model" name="model" [^>]*value="glm-5.3-flash"/)
    expect(dispatch.html).toContain('<select class="model-pick" id="model_pick"')
    expect(dispatch.html).toContain('id="model-lists"')

    const terminals = await render('/terminals')
    expect(terminals.html).toMatch(/<input id="term-model" name="term-model"[^>]*value="haiku"/)
    expect(terminals.html).toContain('id="model-lists"')
  })

  test('terminals serves the vendored xterm assets and its island', async () => {
    const { html } = await render('/terminals')
    expect(html).toContain('/vendor/xterm.js')
    expect(html).toContain('/vendor/addon-fit.js')
    expect(html).toContain('href="/vendor/xterm.css"')
    expect(html).toContain('/js/terminal.js')
    expect(html).toContain('/js/agents.js')
    expect(html).not.toContain('cdn.jsdelivr.net')
  })

  test('the terminals page ships the composer with its resume tab and recent directories', async () => {
    const { html } = await render('/terminals')
    expect(html).toContain('id="term-tab-resume"')
    expect(html).toContain('id="term-sessions-list"')
    expect(html).toContain('id="term-directories"')
    expect(html).not.toContain('id="term-resume"')
    expect(html).not.toContain('Directories and sessions')
  })

  test('the agents panel ships empty and only on the terminals tab', async () => {
    const { html } = await render('/terminals')
    expect(html).not.toContain('class="agent"')
    expect(html).not.toContain('class="arec"')

    for (const [path] of PAGES.filter(([entry]) => entry !== '/terminals')) {
      expect((await render(path)).html).not.toContain('id="agent-sidebar"')
    }
  })

  test('direct routes have one accessible navigation while embedded views omit duplicate chrome', async () => {
    for (const [path] of PAGES) {
      const response = await app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }))
      const html = await response.text()
      expect(html.match(/aria-current="page"/g)?.length).toBe(1)
      expect(html).toContain('aria-label="Workspace"')
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

describe('persistent workspace routes', () => {
  test('home and every direct secondary route carry the persistent terminal shell', async () => {
    for (const path of ['/', '/terminals', '/lanes', '/dispatch', '/review', '/settings']) {
      const response = await app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }))
      const html = await response.text()
      expect(response.status).toBe(200)
      expect(html).toContain('id="termgrid"')
      expect(html).toContain('id="ascii-horizon"')
      expect(html).toContain('/js/workspace.js')
      expect(html).toContain('id="term-directories"')
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
  const ISLANDS = ['work', 'nav', 'forms', 'sprites', 'flow', 'lanes', 'resize', 'dispatch', 'terminal', 'agents']

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
  test('serves the live session map behind the session guard', async () => {
    expect((await app.handle(new Request('http://localhost/api/flow'))).status).toBe(401)

    const response = await app.handle(
      new Request('http://localhost/api/flow', { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      source: string
      current: string
      sessions: Record<string, Record<string, [string, string]>>
      reviewCount: number
      mergedToday: number
    }
    expect(body.source).toBe('live')
    expect(body.sessions).toEqual({})
    expect(body.current).toBe('')
    expect(body.reviewCount).toBe(0)
    expect(body.mergedToday).toBe(0)
  })
})

test('work views replace inherited racks and tables', async () => {
  for (const path of ['/lanes', '/dispatch', '/review']) {
    const { html } = await render(path)
    expect(html).not.toContain('<table')
    expect(html).not.toContain('class="racks"')
    expect(html).not.toContain('id="fsvg"')
    expect(html).toContain('id="work-status"')
  }
})
