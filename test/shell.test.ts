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
    for (const marker of ['id="composer"', 'id="new-chat"', 'id="new-chat-more"', 'class="split"', 'id="chip-group"', 'id="project-chip"', 'id="model-chip"', 'id="edit-chip"', 'id="project-menu"', 'id="model-menu"', 'id="open-agents"', 'id="toggle-flow"', 'id="usage-track"', 'id="live-launch" class="access-dialog flat"', 'id="rail-cards"', 'id="rail-new"', 'id="live-stage"', 'id="drop-stage"', 'id="term-park"', 'id="end-session"', 'id="end-session-confirm"', 'id="drop-over"', 'id="toast"', 'id="find-open"', 'id="find-input"', 'id="backdrop"', 'id="motion"', 'id="messages"', 'id="chat-home"', 'id="team-card"', '/js/chat.js', 'id="history-list"', 'id="agents-count"', 'id="agent-reply"', 'id="studio"', 'id="studio-root"', '/js/studio.js', 'href="/quiet.css"', 'id="open-studio"', 'window.MC_WORKSPACE_DIR=']) expect(markup).toContain(marker)
    for (const gone of ['id="show-history"', 'data-dialog="session"', 'id="session"', 'id="live-recents"', 'id="new-conversation"', 'Design preview']) expect(markup).not.toContain(gone)
    expect(markup).not.toContain('id="tabs"')
    expect(markup).not.toContain('Design preview')
    expect(markup).not.toContain('./vendor/')
    for (const cdn of ['cdn.jsdelivr.net', 'fonts.googleapis.com']) expect(markup).not.toContain(cdn)
  })

  test('neumo-ui loads once, layered beneath quiet.css', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).not.toContain('href="/vendor/neumo-ui.css"')
    const quiet = await Bun.file(join(import.meta.dir, '../public/quiet.css')).text()
    expect(quiet.startsWith("@import url('/vendor/neumo-ui.css') layer(neumo);")).toBe(true)
  })

  test('the access dialog states only true facts', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    expect(markup).toContain('id="access-host"')
    for (const id of ['access-token', 'access-reveal', 'access-rotate', 'access-home']) expect(markup).toContain(`id="${id}"`)
    expect(markup).not.toContain('href="/settings"')
    for (const placeholder of ['127.0.0.1:3000', 'Not loaded in this preview', 'Rotate token']) expect(markup).not.toContain(placeholder)
  })

  test('the shell islands transpile', async () => {
    for (const island of ['shell', 'shell-composer', 'terminals', 'shell-activity', 'usage-card', 'backdrop', 'chat', 'studio', 'access']) {
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
