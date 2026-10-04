import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-shell-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  app = await createApp()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('quiet shell', () => {
  test('/ renders the composer, toolbar controls and the usage card mount', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    for (const marker of ['id="composer"', 'id="new-chat"', 'id="chip-group"', 'id="project-chip"', 'id="model-chip"', 'id="edit-chip"', 'id="project-menu"', 'id="model-menu"', 'id="open-agents"', 'id="toggle-flow"', 'id="usage-track"', 'id="live-launch" class="access-dialog flat"', 'id="live-stage"', 'list="live-cwd-recents"', 'id="live-cwd-recents"','id="drop-stage"', 'id="term-park"', 'id="drop-over"', 'id="toast"', 'id="term-bar"', 'id="find-input"', 'id="backdrop"', 'id="motion"', 'id="messages"', 'id="queued"', 'id="chat-home"', 'id="team-card"', '/js/chat.js', '/js/sidebar.js', 'id="history-list"', 'id="agents-count"', 'id="agent-reply"', 'id="studio"', 'id="studio-root"', '/js/studio.js', 'href="/quiet.css"', 'id="open-studio"', 'id="session-icon"', 'window.MC_WORKSPACE_DIR=', 'id="flow-stage"', 'id="flow-banner"', 'id="flow-quick"', '/js/flow-drawer.js']) expect(markup).toContain(marker)
    for (const gone of ['id="show-history"', 'data-dialog="session"', 'id="session"', 'id="live-recents"', 'id="new-conversation"', 'id="rail', 'with-rail', 'Design preview', 'id="live-flow']) expect(markup).not.toContain(gone)
    expect(markup).not.toContain('id="tabs"')
    expect(markup).not.toContain('Design preview')
    expect(markup).not.toContain('./vendor/')
    for (const cdn of ['cdn.jsdelivr.net', 'fonts.googleapis.com']) expect(markup).not.toContain(cdn)
  })

  test('/ puts New chat, search and New terminal in the sidebar instead of the toolbar', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    for (const marker of ['id="sidebar"', 'id="new-chat"', 'id="search"', 'data-live', 'id="sidebar-list"', 'id="all-history"']) expect(markup).toContain(marker)
    expect(markup).not.toContain('aria-label="Chats"')
    expect(markup).not.toContain('id="new-chat-menu"')
    expect(markup.indexOf('id="sidebar"')).toBeLessThan(markup.indexOf('<main class="canvas">'))
    expect(markup).toContain('class="sb-shell collapsed"')
  })

  test('on a narrow screen the flow header Studio pill reads Studio and its actions wrap under the title', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).toContain('<button id="flow-studio" class="pill flow-sm" type="button" aria-label="Open in Studio" hidden><span class="flow-wide">Open in</span>Studio</button>')
    const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
    const narrow = [...quiet.matchAll(/@media \(max-width: 600px\) \{([^@]*)\n\}/g)].map(match => match[1]).join('\n')
    expect(narrow).toContain('.flow-wide { display: none; }')
    expect(narrow).toContain('.flow-actions { flex: 1 1 100%; flex-wrap: wrap; justify-content: flex-end; }')
  })

  test('neumo-ui loads once, layered beneath quiet.css', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).not.toContain('href="/vendor/neumo-ui.css"')
    const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
    expect(quiet.startsWith("@import url('/vendor/neumo-ui.css') layer(neumo);")).toBe(true)
  })

  test('the settings dialog states only true facts', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).toContain('<dialog id="settings" class="access-dialog" aria-labelledby="settings-title">')
    expect(markup).toContain('aria-label="Close settings"')
    expect(markup).not.toContain('<dialog id="access"')
    expect(markup).toContain('id="access-host"')
    for (const id of ['access-token', 'access-reveal', 'access-rotate', 'access-home', 'access-flow-approval']) expect(markup).toContain(`id="${id}"`)
    expect(markup).not.toContain('href="/settings"')
    for (const placeholder of ['127.0.0.1:3000', 'Not loaded in this preview', 'Rotate token']) expect(markup).not.toContain(placeholder)
  })

  test('the toolbar reads Studio, Flow, Agents and no longer holds motion or access', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const toolbar = markup.slice(markup.indexOf('<header class="toolbar">'), markup.indexOf('</header>', markup.indexOf('<header class="toolbar">')))
    const order = ['id="open-studio"', 'id="toggle-flow"', 'id="open-agents"'].map(marker => toolbar.indexOf(marker))
    expect(order.every(index => index > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const gone of ['id="motion"', 'data-dialog=', 'lock-icon']) expect(toolbar).not.toContain(gone)
  })

  test('History sits above Settings at the bottom of the open and collapsed sidebar', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const foot = markup.slice(markup.indexOf('class="sb-foot"'), markup.indexOf('</div>', markup.indexOf('class="sb-foot"')))
    expect(foot.indexOf('id="all-history"')).toBeGreaterThan(0)
    expect(foot.indexOf('id="open-settings"')).toBeGreaterThan(foot.indexOf('id="all-history"'))
    const strip = markup.slice(markup.indexOf('class="sb-strip"'), markup.indexOf('</aside>'))
    expect(strip.indexOf('data-dialog="settings"')).toBeGreaterThan(strip.indexOf('data-click="all-history"'))
    expect(strip.indexOf('data-click="all-history"')).toBeGreaterThan(0)
    expect(markup.match(/data-dialog="settings"/g)).toHaveLength(2)
  })

  test('Settings holds the dark theme and background motion switches, and the theme applies before first paint', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    const settings = markup.slice(markup.indexOf('<dialog id="settings"'), markup.indexOf('</dialog>', markup.indexOf('<dialog id="settings"')))
    expect(settings).toContain('<input id="theme-dark" type="checkbox" role="switch">Dark theme')
    expect(settings).toContain('<input id="motion" type="checkbox" role="switch">Background motion')
    const head = markup.slice(0, markup.indexOf('</head>'))
    expect(head.indexOf("localStorage.getItem('mc.theme')")).toBeGreaterThan(0)
    expect(head.indexOf("localStorage.getItem('mc.theme')")).toBeLessThan(head.indexOf('href="/quiet.css"'))
  })

  test('dark theme overrides the palette tokens on the root', async () => {
    const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
    const dark = quiet.slice(quiet.indexOf(':root[data-theme="dark"] {'), quiet.indexOf('}', quiet.indexOf(':root[data-theme="dark"] {')))
    for (const token of ['color-scheme: dark', '--paper:', '--line:', '--muted:', '--text:', '--field:', '--hi:', '--nui-lights:', '--nui-shadows:', '--studio-dots:']) expect(dark).toContain(token)
  })

  test('the shell islands transpile', async () => {
    for (const island of ['shell', 'shell-composer', 'terminals', 'shell-activity', 'flow-drawer', 'usage-card', 'backdrop', 'chat', 'studio', 'access', 'plugins']) {
      const response = await app.handle(new Request(`http://localhost/js/${island}.js`))
      expect(response.status).toBe(200)
      expect((await response.text()).length).toBeGreaterThan(100)
    }
  })

  test('the old tab pages redirect home to the shell and never to a gate', async () => {
    const response = await app.handle(new Request('http://localhost/settings'))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
  })
})

describe('attention delivery', () => {
  test('/ links the Mission Control favicon and the attention island', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    expect(markup).not.toContain('href="data:,"')
    expect(markup).toContain('<script src="/js/attention.js" type="module" defer></script>')
  })

  test('/ puts the bell after Agents and the Waiting-on-you panel in the canvas', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    for (const marker of ['id="bell-icon"', 'id="open-attention"', 'aria-controls="attention"', 'id="attention-count"', '<section id="attention" class="nt-panel"', 'id="attention-list"', 'id="attention-empty"', 'id="attention-off"', 'id="attention-on"', 'id="attention-foot"', 'id="attention-mute"']) expect(markup).toContain(marker)
    expect(markup.indexOf('id="open-attention"')).toBeGreaterThan(markup.indexOf('id="open-agents"'))
    expect(markup.indexOf('id="open-attention"')).toBeLessThan(markup.indexOf('</header>'))
  })

  test('/sw.js serves the service worker with its click handler, and /favicon.svg serves the icon', async () => {
    const worker = await app.handle(new Request('http://localhost/sw.js'))
    expect(worker.status).toBe(200)
    expect(worker.headers.get('content-type')).toContain('javascript')
    const code = await worker.text()
    expect(code).toContain('notificationclick')
    expect(code).toContain('mc:open')
    const icon = await app.handle(new Request('http://localhost/favicon.svg'))
    expect(icon.status).toBe(200)
    expect(await icon.text()).toContain('<svg')
  })
})
