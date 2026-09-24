import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { exists, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { createApp } from '../server/index'
import {
  CLOSE_TERMINAL_ENDED,
  CLOSE_TERMINAL_NOT_FOUND,
  readSocketMessage,
  terminalsRoutes,
} from '../server/routes/terminals'
import { createTerminalRegistry, type TerminalRegistry } from '../server/terminals'
import { initScratchGitRepo } from './support/scratch-git-repo'

let configDir: string
let repo: string
let registry: TerminalRegistry

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-terminals-routes-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  process.env.MC_FAKE_ENGINES = '1'

  repo = await mkdtemp(join(homedir(), 'mc-terminals-routes-scratch-'))
  await initScratchGitRepo(repo)
  registry = createTerminalRegistry()
})

afterEach(async () => {
  registry.shutdown()
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  delete process.env.MC_FAKE_ENGINES
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function buildApp(): Elysia {
  return new Elysia().use(terminalsRoutes(registry))
}

const LOCAL = 'http://localhost'
const REBIND = 'http://rebind.example'

function request(path: string, method: string, origin = LOCAL, body?: unknown): Request {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function formRequest(path: string, origin: string, form: FormData): Request {
  return new Request(`${origin}${path}`, { method: 'POST', headers: { origin }, body: form })
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

function openSocket(url: string, origin: string | null = 'http://127.0.0.1'): SocketProbe {
  const socket = new WebSocket(url, {
    headers: origin === null ? {} : { origin },
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
    const app = buildApp()
    const created = await app.handle(request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo }))
    const { id } = (await created.json()) as { id: string }

    const renamed = await app.handle(request(`/api/terminals/${id}`, 'PATCH', LOCAL, { title: ' deploy box ' }))
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as { title: string }).title).toBe('deploy box')
    expect(registry.get(id)?.title).toBe('deploy box')
  })

  test('rejects rebinding-host, blank-title, and unknown-id requests', async () => {
    const app = buildApp()
    const created = await app.handle(request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo }))
    const { id } = (await created.json()) as { id: string }

    expect((await app.handle(request(`/api/terminals/${id}`, 'PATCH', REBIND, { title: 'x' }))).status).toBe(403)
    expect((await app.handle(request(`/api/terminals/${id}`, 'PATCH', LOCAL, { title: '  ' }))).status).toBe(400)
    expect((await app.handle(request(`/api/terminals/${id}`, 'PATCH', LOCAL, {}))).status).toBe(400)
    expect((await app.handle(request('/api/terminals/nope', 'PATCH', LOCAL, { title: 'x' }))).status).toBe(404)
  })
})

describe('POST /api/terminals', () => {
  test('rejects a rebinding host', async () => {
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', REBIND, { engine: 'claude', cwd: repo }),
    )
    expect(response.status).toBe(403)
  })

  test('rejects an incomplete payload', async () => {
    const response = await buildApp().handle(request('/api/terminals', 'POST', LOCAL, { engine: 'claude' }))
    expect(response.status).toBe(400)
  })

  test('rejects a cwd outside HOME', async () => {
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: '/tmp' }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('cwd must be under $HOME')
  })

  test('rejects glm while the z.ai token is unconfigured', async () => {
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', LOCAL, { engine: 'glm', cwd: repo }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe(
      'engine environment is not configured',
    )
  })

  test('creates a session that then appears in the list', async () => {
    const app = buildApp()
    const created = await app.handle(
      request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo, cols: 100, rows: 40 }),
    )
    expect(created.status).toBe(200)
    const terminal = (await created.json()) as { id: string; engine: string; pid: number }
    expect(terminal.engine).toBe('claude')
    expect(terminal.pid).toBeGreaterThan(0)

    const listed = await app.handle(request('/api/terminals', 'GET'))
    const { sessions } = (await listed.json()) as { sessions: Array<{ id: string }> }
    expect(sessions.map((entry) => entry.id)).toEqual([terminal.id])
  })

  test('accepts an optional model and rejects one longer than 100 characters', async () => {
    const app = buildApp()

    const created = await app.handle(
      request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo, model: 'opus' }),
    )
    expect(created.status).toBe(200)
    const terminal = (await created.json()) as { id: string }

    expect(
      (await app.handle(request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo, model: '' })))
        .status,
    ).toBe(200)

    const tooLong = await app.handle(
      request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo, model: 'x'.repeat(101) }),
    )
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toEqual({ error: 'model too long' })

    registry.kill(terminal.id)
  })
})

describe('GET /api/terminals', () => {
  test('rejects a rebinding host', async () => {
    const response = await buildApp().handle(request('/api/terminals', 'GET', REBIND))
    expect(response.status).toBe(403)
  })
})

describe('DELETE /api/terminals/:id', () => {
  test('rejects a rebinding host', async () => {
    const response = await buildApp().handle(request('/api/terminals/missing', 'DELETE', REBIND))
    expect(response.status).toBe(403)
  })

  test('404s for an unknown id', async () => {
    const response = await buildApp().handle(request('/api/terminals/missing', 'DELETE'))
    expect(response.status).toBe(404)
  })

  test('kills the pty process', async () => {
    const app = buildApp()
    const created = await app.handle(request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo }))
    const terminal = (await created.json()) as { id: string; pid: number }

    const deleted = await app.handle(request(`/api/terminals/${terminal.id}`, 'DELETE'))
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
  test('refuses the upgrade without an Origin', async () => {
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port
    try {
      const probe = openSocket(`ws://127.0.0.1:${port}/ws/terminal/anything`, null)
      await expect(probe.opened).rejects.toBeDefined()
    } finally {
      server.stop(true)
    }
  })

  test('refuses the upgrade from a foreign Origin', async () => {
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port
    try {
      const probe = openSocket(`ws://127.0.0.1:${port}/ws/terminal/anything`, 'https://evil.example')
      await expect(probe.opened).rejects.toBeDefined()
    } finally {
      server.stop(true)
    }
  })

  test('closes immediately for an unknown terminal id', async () => {
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port
    try {
      const probe = openSocket(`ws://127.0.0.1:${port}/ws/terminal/missing`)
      await probe.opened
      await waitFor(() => probe.closes.length > 0)
      expect(probe.closes[0]?.code).toBe(CLOSE_TERMINAL_NOT_FOUND)
    } finally {
      server.stop(true)
    }
  })

  test('bridges keystrokes to the pty, replays on reattach, and applies resize', async () => {
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port

    try {
      const created = await app.handle(
        request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo, cols: 80, rows: 24 }),
      )
      const terminal = (await created.json()) as { id: string; pid: number }
      const url = `ws://127.0.0.1:${port}/ws/terminal/${terminal.id}`

      const first = openSocket(url)
      await first.opened
      first.send('echo ws-bridge-hi\n')
      await waitFor(() => first.text().includes('ws-bridge-hi'))
      await first.close()

      const second = openSocket(url)
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
    const app = buildApp()
    const server = app.listen({ hostname: '127.0.0.1', port: 0 })
    const port = server.server?.port

    try {
      const created = await app.handle(
        request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo }),
      )
      const terminal = (await created.json()) as { id: string }
      const probe = openSocket(`ws://127.0.0.1:${port}/ws/terminal/${terminal.id}`)
      await probe.opened

      await app.handle(request(`/api/terminals/${terminal.id}`, 'DELETE'))
      await waitFor(() => probe.closes.length > 0)
      expect(probe.closes[0]?.code).toBe(CLOSE_TERMINAL_ENDED)
    } finally {
      server.stop(true)
    }
  })
})

describe('mounted in the real app', () => {
  test('createApp wires the terminals routes behind the local-access guard', async () => {
    const app = await createApp()

    const rebound = await app.handle(request('/api/terminals', 'GET', REBIND))
    expect(rebound.status).toBe(403)

    const listed = await app.handle(request('/api/terminals', 'GET'))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ sessions: [] })
  })
})

describe('POST /api/terminals/drops', () => {
  test('rejects a rebinding host', async () => {
    const form = new FormData()
    form.append('file', new File(['x'], 'a.txt'))
    const response = await buildApp().handle(formRequest('/api/terminals/drops', REBIND, form))
    expect(response.status).toBe(403)
  })

  test('rejects a request without a file', async () => {
    const form = new FormData()
    form.append('lastModified', '1')
    const response = await buildApp().handle(formRequest('/api/terminals/drops', LOCAL, form))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('file is required')
  })

  test('saves an unknown file under the config dir and returns the copy', async () => {
    const app = new Elysia().use(terminalsRoutes(registry, { find: async () => null }))
    const payload = 'drop me'
    const form = new FormData()
    form.append('file', new File([payload], 'note.txt'))
    form.append('lastModified', '1700000000000')
    const response = await app.handle(formRequest('/api/terminals/drops', LOCAL, form))
    expect(response.status).toBe(200)
    const data = (await response.json()) as { path: string; original: boolean }
    expect(data.original).toBe(false)
    expect(data.path.startsWith(join(configDir, 'drops') + '/')).toBe(true)
    expect(data.path.endsWith('/note.txt')).toBe(true)
    expect(await readFile(data.path, 'utf8')).toBe(payload)
  })

  test('returns the original path from the finder without saving', async () => {
    const app = new Elysia().use(terminalsRoutes(registry, { find: async () => '/tmp/x.png' }))
    const form = new FormData()
    form.append('file', new File(['x'], 'x.png'))
    const response = await app.handle(formRequest('/api/terminals/drops', LOCAL, form))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ path: '/tmp/x.png', original: true })
    expect(await exists(join(configDir, 'drops', 'x.png'))).toBe(false)
  })
})

describe('GET /api/terminals/sessions', () => {
  test('rejects a rebinding host', async () => {
    const response = await buildApp().handle(request('/api/terminals/sessions?cwd=/x', 'GET', REBIND))
    expect(response.status).toBe(403)
  })

  test('requires a cwd', async () => {
    const response = await buildApp().handle(request('/api/terminals/sessions', 'GET'))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('cwd is required')
  })

  test('rejects a cwd outside HOME', async () => {
    const response = await buildApp().handle(
      request('/api/terminals/sessions?cwd=%2Ftmp', 'GET'),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('cwd must be under $HOME')
  })

  test('lists sessions for the validated cwd via the injectable helper', async () => {
    const seen: string[] = []
    const fixed = [{ id: 's1', title: 'old chat', startedAt: null, updatedAt: 1, bytes: 2 }]
    const app = new Elysia().use(
      terminalsRoutes(registry, {
        listSessions: async (cwd) => {
          seen.push(cwd)
          return fixed
        },
      }),
    )
    const response = await app.handle(
      request(`/api/terminals/sessions?cwd=${encodeURIComponent(repo)}`, 'GET'),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessions: fixed })
    expect(seen).toEqual([realpathSync(repo)])
  })
})

describe('POST /api/terminals with resumeSessionId', () => {
  test('rejects a malformed session id', async () => {
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', LOCAL, { engine: 'claude', cwd: repo, resumeSessionId: 'nope' }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid session id')
  })

  test('rejects codex', async () => {
    const response = await buildApp().handle(
      request('/api/terminals', 'POST', LOCAL, {
        engine: 'codex',
        cwd: repo,
        resumeSessionId: 'a1b2c3d4-e5f6-a1b2-c3d4-e5f6a1b2c3d4',
      }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe(
      'resume is only supported for claude and glm',
    )
  })

  test('resumes a claude session with a custom title', async () => {
    const created = await buildApp().handle(
      request('/api/terminals', 'POST', LOCAL, {
        engine: 'claude',
        cwd: repo,
        resumeSessionId: 'a1b2c3d4-e5f6-a1b2-c3d4-e5f6a1b2c3d4',
        title: 'My Old Chat',
      }),
    )
    expect(created.status).toBe(200)
    const terminal = (await created.json()) as { id: string; title: string }
    expect(terminal.title).toBe('My Old Chat')
    expect(registry.get(terminal.id)?.title).toBe('My Old Chat')
    registry.kill(terminal.id)
  })
})
