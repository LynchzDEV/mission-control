import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { SESSION_COOKIE, completeSetup, resetLoginLimiter } from '../server/auth'
import { createApp } from '../server/index'
import {
  CLOSE_TERMINAL_ENDED,
  CLOSE_TERMINAL_NOT_FOUND,
  readSocketMessage,
  terminalsRoutes,
} from '../server/routes/terminals'
import { createTerminalRegistry, type TerminalRegistry } from '../server/terminals'
import { initScratchGitRepo } from './support/scratch-git-repo'

const PASSWORD = 'correct-horse-battery'

let configDir: string
let repo: string
let registry: TerminalRegistry

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-terminals-routes-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  process.env.MC_FAKE_ENGINES = '1'
  resetLoginLimiter()

  repo = await mkdtemp(join(homedir(), 'mc-terminals-routes-scratch-'))
  await initScratchGitRepo(repo)
  registry = createTerminalRegistry()
})

afterEach(async () => {
  registry.shutdown()
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  delete process.env.MC_FAKE_ENGINES
  resetLoginLimiter()
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

async function authCookie(): Promise<string> {
  const result = await completeSetup(PASSWORD)
  if (!result.ok) throw new Error('test harness setup failed')
  return `${SESSION_COOKIE}=${result.token}`
}

function buildApp(): Elysia {
  return new Elysia().use(terminalsRoutes(registry))
}

function request(path: string, method: string, cookie?: string, body?: unknown): Request {
  const headers: Record<string, string> = {}
  if (cookie !== undefined) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type SocketProbe = {
  socket: WebSocket
  received: string[]
  text(): string
  closes: Array<{ code: number; reason: string }>
  opened: Promise<void>
  send(data: string): void
  control(payload: unknown): void
  close(): Promise<void>
}

function openSocket(url: string, cookie?: string): SocketProbe {
  const socket = new WebSocket(url, {
    headers: cookie === undefined ? {} : { cookie },
  } as unknown as string[])
  const received: string[] = []
  const closes: Array<{ code: number; reason: string }> = []

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('socket errored before open')))
    socket.addEventListener('close', (event) => {
      closes.push({ code: event.code, reason: event.reason })
      reject(new Error(`socket closed before open (${event.code})`))
    })
  })

  socket.addEventListener('message', (event) => {
    received.push(typeof event.data === 'string' ? event.data : '')
  })
  socket.addEventListener('close', (event) => {
    if (closes.length === 0) closes.push({ code: event.code, reason: event.reason })
  })

  return {
    socket,
    received,
    closes,
    opened,
    text: () => received.join(''),
    send: (data) => socket.send(new TextEncoder().encode(data)),
    control: (payload) => socket.send(JSON.stringify(payload)),
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve()
        socket.addEventListener('close', () => resolve())
        socket.close()
      }),
  }
}

describe('PATCH /api/terminals/:id', () => {
  test('renames a session and echoes the record', async () => {
    const cookie = await authCookie()
    const app = buildApp()
    const created = await app.handle(request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo }))
    const { id } = (await created.json()) as { id: string }

    const renamed = await app.handle(request(`/api/terminals/${id}`, 'PATCH', cookie, { title: ' deploy box ' }))
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as { title: string }).title).toBe('deploy box')
    expect(registry.get(id)?.title).toBe('deploy box')
  })

  test('rejects unauthenticated, blank-title, and unknown-id requests', async () => {
    const cookie = await authCookie()
    const app = buildApp()
    const created = await app.handle(request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo }))
    const { id } = (await created.json()) as { id: string }

    expect((await app.handle(request(`/api/terminals/${id}`, 'PATCH', undefined, { title: 'x' }))).status).toBe(401)
    expect((await app.handle(request(`/api/terminals/${id}`, 'PATCH', cookie, { title: '  ' }))).status).toBe(400)
    expect((await app.handle(request(`/api/terminals/${id}`, 'PATCH', cookie, {}))).status).toBe(400)
    expect((await app.handle(request('/api/terminals/nope', 'PATCH', cookie, { title: 'x' }))).status).toBe(404)
  })
})

describe('POST /api/terminals', () => {
  test('rejects an unauthenticated request', async () => {
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', undefined, { engine: 'claude', cwd: repo }),
    )
    expect(response.status).toBe(401)
  })

  test('rejects an incomplete payload', async () => {
    const cookie = await authCookie()
    const response = await buildApp().handle(request('/api/terminals', 'POST', cookie, { engine: 'claude' }))
    expect(response.status).toBe(400)
  })

  test('rejects a cwd outside HOME', async () => {
    const cookie = await authCookie()
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: '/tmp' }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('cwd must be under $HOME')
  })

  test('rejects glm while the z.ai token is unconfigured', async () => {
    const cookie = await authCookie()
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', cookie, { engine: 'glm', cwd: repo }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe(
      'engine environment is not configured',
    )
  })

  test('creates a session that then appears in the list', async () => {
    const cookie = await authCookie()
    const app = buildApp()
    const created = await app.handle(
      request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo, cols: 100, rows: 40 }),
    )
    expect(created.status).toBe(200)
    const terminal = (await created.json()) as { id: string; engine: string; pid: number }
    expect(terminal.engine).toBe('claude')
    expect(terminal.pid).toBeGreaterThan(0)

    const listed = await app.handle(request('/api/terminals', 'GET', cookie))
    const { sessions } = (await listed.json()) as { sessions: Array<{ id: string }> }
    expect(sessions.map((entry) => entry.id)).toEqual([terminal.id])
  })

  test('accepts an optional model and rejects one longer than 100 characters', async () => {
    const cookie = await authCookie()
    const app = buildApp()

    const created = await app.handle(
      request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo, model: 'opus' }),
    )
    expect(created.status).toBe(200)
    const terminal = (await created.json()) as { id: string }

    expect(
      (await app.handle(request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo, model: '' })))
        .status,
    ).toBe(200)

    const tooLong = await app.handle(
      request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo, model: 'x'.repeat(101) }),
    )
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toEqual({ error: 'model too long' })

    registry.kill(terminal.id)
  })
})

describe('GET /api/terminals', () => {
  test('rejects an unauthenticated request', async () => {
    const response = await buildApp().handle(request('/api/terminals', 'GET'))
    expect(response.status).toBe(401)
  })
})

describe('DELETE /api/terminals/:id', () => {
  test('rejects an unauthenticated request', async () => {
    const response = await buildApp().handle(request('/api/terminals/missing', 'DELETE'))
    expect(response.status).toBe(401)
  })

  test('404s for an unknown id', async () => {
    const cookie = await authCookie()
    const response = await buildApp().handle(request('/api/terminals/missing', 'DELETE', cookie))
    expect(response.status).toBe(404)
  })

  test('kills the pty process', async () => {
    const cookie = await authCookie()
    const app = buildApp()
    const created = await app.handle(request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo }))
    const terminal = (await created.json()) as { id: string; pid: number }

    const deleted = await app.handle(request(`/api/terminals/${terminal.id}`, 'DELETE', cookie))
    expect(deleted.status).toBe(200)
    await waitFor(() => !processAlive(terminal.pid))
    expect(processAlive(terminal.pid)).toBe(false)
  })
})

describe('readSocketMessage', () => {
  test('treats binary frames as raw pty input', () => {
    expect(readSocketMessage(new TextEncoder().encode('ls\n'))).toEqual({ kind: 'data', data: 'ls\n' })
    expect(readSocketMessage(new TextEncoder().encode('ls\n').buffer)).toEqual({
      kind: 'data',
      data: 'ls\n',
    })
  })

  test('reads resize and data control objects, ignoring anything else', () => {
    expect(readSocketMessage({ type: 'resize', cols: 100, rows: 40 })).toEqual({
      kind: 'resize',
      cols: 100,
      rows: 40,
    })
    expect(readSocketMessage({ type: 'data', data: 'hi' })).toEqual({ kind: 'data', data: 'hi' })
    expect(readSocketMessage({ type: 'nope' })).toEqual({ kind: 'ignore' })
    expect(readSocketMessage(42)).toEqual({ kind: 'ignore' })
    expect(readSocketMessage(null)).toEqual({ kind: 'ignore' })
  })
})

describe('WS /ws/terminal/:id', () => {
  test('refuses the upgrade without a session cookie', async () => {
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port
    try {
      const probe = openSocket(`ws://127.0.0.1:${port}/ws/terminal/anything`)
      await expect(probe.opened).rejects.toBeDefined()
    } finally {
      server.stop(true)
    }
  })

  test('closes immediately for an unknown terminal id', async () => {
    const cookie = await authCookie()
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port
    try {
      const probe = openSocket(`ws://127.0.0.1:${port}/ws/terminal/missing`, cookie)
      await probe.opened
      await waitFor(() => probe.closes.length > 0)
      expect(probe.closes[0]?.code).toBe(CLOSE_TERMINAL_NOT_FOUND)
    } finally {
      server.stop(true)
    }
  })

  test('bridges keystrokes to the pty, replays on reattach, and applies resize', async () => {
    const cookie = await authCookie()
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port

    try {
      const created = await app.handle(
        request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo, cols: 80, rows: 24 }),
      )
      const terminal = (await created.json()) as { id: string; pid: number }
      const url = `ws://127.0.0.1:${port}/ws/terminal/${terminal.id}`

      const first = openSocket(url, cookie)
      await first.opened
      first.send('echo ws-bridge-hi\n')
      await waitFor(() => first.text().includes('ws-bridge-hi'))
      await first.close()

      const second = openSocket(url, cookie)
      await second.opened
      await waitFor(() => second.text().includes('ws-bridge-hi'))
      expect(second.text()).toContain('ws-bridge-hi')

      second.control({ type: 'resize', cols: 123, rows: 45 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      second.send('stty size\n')
      await waitFor(() => second.text().includes('45 123'))
      expect(second.text()).toContain('45 123')

      await second.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(registry.get(terminal.id)).toBeDefined()
    } finally {
      server.stop(true)
    }
  })

  test('closes the attached socket when the session is deleted', async () => {
    const cookie = await authCookie()
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port

    try {
      const created = await app.handle(
        request('/api/terminals', 'POST', cookie, { engine: 'claude', cwd: repo }),
      )
      const terminal = (await created.json()) as { id: string }
      const probe = openSocket(`ws://127.0.0.1:${port}/ws/terminal/${terminal.id}`, cookie)
      await probe.opened

      await app.handle(request(`/api/terminals/${terminal.id}`, 'DELETE', cookie))
      await waitFor(() => probe.closes.length > 0)
      expect(probe.closes[0]?.code).toBe(CLOSE_TERMINAL_ENDED)
    } finally {
      server.stop(true)
    }
  })
})

describe('mounted in the real app', () => {
  test('createApp wires the terminals routes behind the session guard', async () => {
    const app = await createApp()

    const unauthed = await app.handle(request('/api/terminals', 'GET'))
    expect(unauthed.status).toBe(401)

    const setup = await app.handle(request('/api/setup', 'POST', undefined, { password: PASSWORD }))
    const cookie = setup.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0]
    expect(cookie).toBeDefined()

    const listed = await app.handle(request('/api/terminals', 'GET', cookie))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ sessions: [] })
  })
})
