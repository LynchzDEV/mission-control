import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { createApp } from '../server/index'
import { CLOSE_TERMINAL_NOT_FOUND, terminalsRoutes } from '../server/routes/terminals'
import { createTerminalRegistry, type TerminalRegistry } from '../server/terminals'

const HOST = 'lynchzpc-wsl.tail1234.ts.net'
const ORIGIN = `https://${HOST}`
const USER = 'lynchz@example.com'

type Listening = { port: number; stop(): void }

let dir: string
let registry: TerminalRegistry
let savedHosts: string | undefined
let savedUsers: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-remote-access-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  process.env.MC_FAKE_ENGINES = '1'
  savedHosts = process.env.MISSION_CONTROL_ALLOWED_HOSTS
  savedUsers = process.env.MISSION_CONTROL_ALLOWED_USERS
  process.env.MISSION_CONTROL_ALLOWED_HOSTS = HOST
  process.env.MISSION_CONTROL_ALLOWED_USERS = USER
  registry = createTerminalRegistry()
})

afterEach(async () => {
  registry.shutdown()
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  delete process.env.MC_FAKE_ENGINES
  if (savedHosts === undefined) delete process.env.MISSION_CONTROL_ALLOWED_HOSTS
  else process.env.MISSION_CONTROL_ALLOWED_HOSTS = savedHosts
  if (savedUsers === undefined) delete process.env.MISSION_CONTROL_ALLOWED_USERS
  else process.env.MISSION_CONTROL_ALLOWED_USERS = savedUsers
  await rm(dir, { recursive: true, force: true })
})

function listen(app: Elysia): Listening {
  const listening = app.listen({ hostname: '127.0.0.1', port: 0 })
  const port = listening.server?.port
  if (port === undefined) throw new Error('server did not start')
  return { port, stop: () => { void listening.stop(true) } }
}

function viaProxy(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers: { host: HOST, 'tailscale-user-login': USER, ...init.headers },
    body: init.body,
  })
}

const navigation = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

describe('Tailscale access through the real app', () => {
  test('an allowed user gets the page, API reads and same-origin writes', async () => {
    const server = listen(await createApp())
    try {
      const page = await viaProxy(server.port, '/', { headers: navigation })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('This app answers on this machine and to the Tailscale users you allow.')

      const roles = await viaProxy(server.port, '/api/roles', { headers: { 'sec-fetch-site': 'same-origin' } })
      expect(roles.status).toBe(200)
      const current = await roles.json()

      const saved = await viaProxy(server.port, '/api/roles', {
        method: 'POST',
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify(current),
      })
      expect(saved.status).toBe(200)
    } finally {
      server.stop()
    }
  })

  test('refuses a wrong user, a missing user, an unset user list, another host and a foreign Origin', async () => {
    const server = listen(await createApp())
    try {
      const wrongUser = await viaProxy(server.port, '/api/roles', { headers: { 'tailscale-user-login': 'someone@example.com' } })
      expect(wrongUser.status).toBe(403)
      expect(await wrongUser.json()).toEqual({ error: 'local access only' })

      const missingUser = await fetch(`http://127.0.0.1:${server.port}/api/roles`, { headers: { host: HOST } })
      expect(missingUser.status).toBe(403)

      const otherHost = await viaProxy(server.port, '/api/roles', { headers: { host: 'otherpc.tail1234.ts.net' } })
      expect(otherHost.status).toBe(403)

      const foreign = await viaProxy(server.port, '/api/roles', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      })
      expect(foreign.status).toBe(403)

      const wrongUserPage = await viaProxy(server.port, '/', { headers: { ...navigation, 'tailscale-user-login': 'someone@example.com' } })
      expect(wrongUserPage.status).toBe(403)

      delete process.env.MISSION_CONTROL_ALLOWED_USERS
      expect((await viaProxy(server.port, '/api/roles')).status).toBe(403)
      expect((await viaProxy(server.port, '/', { headers: navigation })).status).toBe(403)
    } finally {
      server.stop()
    }
  })

  test('refuses an allowed host when the request did not come over a socket', async () => {
    const app = await createApp()
    const request = new Request(`http://${HOST}/api/roles`, { headers: { host: HOST, 'tailscale-user-login': USER } })
    expect((await app.handle(request)).status).toBe(403)
  })

  test('localhost keeps working and keeps the local-only note when no host is allowed', async () => {
    delete process.env.MISSION_CONTROL_ALLOWED_HOSTS
    const app = await createApp()
    const page = await app.handle(new Request('http://localhost/'))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('This app answers only on this machine.')
    expect((await app.handle(new Request('http://localhost/api/roles'))).status).toBe(200)
  })
})

describe('terminal socket over Tailscale', () => {
  function openSocket(port: number, headers: Record<string, string>): { opened: Promise<void>; closed: Promise<number>; close(): void } {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/missing`, { headers } as unknown as string[])
    let resolveClosed: (code: number) => void = () => {}
    const closed = new Promise<number>(resolve => { resolveClosed = resolve })
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('socket errored before open')))
    })
    socket.addEventListener('close', event => resolveClosed(event.code))
    return { opened, closed, close: () => socket.close() }
  }

  test('lets an allowed user through the guard', async () => {
    const server = listen(new Elysia().use(terminalsRoutes(registry)))
    try {
      const probe = openSocket(server.port, { host: HOST, origin: ORIGIN, 'tailscale-user-login': USER })
      await probe.opened
      expect(await probe.closed).toBe(CLOSE_TERMINAL_NOT_FOUND)
    } finally {
      server.stop()
    }
  })

  test('refuses a wrong user and a foreign Origin', async () => {
    const server = listen(new Elysia().use(terminalsRoutes(registry)))
    try {
      const wrongUser = openSocket(server.port, { host: HOST, origin: ORIGIN, 'tailscale-user-login': 'someone@example.com' })
      await expect(wrongUser.opened).rejects.toBeDefined()
      const foreign = openSocket(server.port, { host: HOST, origin: 'https://evil.example', 'tailscale-user-login': USER })
      await expect(foreign.opened).rejects.toBeDefined()
    } finally {
      server.stop()
    }
  })
})
