import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type MainDeps } from '../cli/mctl'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-cli-queue-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
type Reply = (call: Call) => Response | undefined

function harness(reply: Reply = () => undefined, cwd = '/work/here') {
  const calls: Call[] = []
  let out = ''
  let err = ''
  const deps: MainDeps = {
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      const call = { method: request.method, path: url.pathname, body: text === '' ? undefined : JSON.parse(text) as Record<string, unknown> }
      calls.push(call)
      return reply(call) ?? Response.json({ ok: true })
    },
    stdout: (chunk) => { out += chunk },
    stderr: (chunk) => { err += chunk },
    env: { MISSION_CONTROL_CONFIG_DIR: configDir },
    stdin: async () => '',
    cwd,
  }
  return { deps, calls, out: () => out, err: () => err }
}

const routesOf = (calls: Call[]) => calls.map((call) => `${call.method} ${call.path}`)

describe('mctl queue', () => {
  test('list prints one row per item with its state and questions', async () => {
    const h = harness((call) => (call.method === 'GET' && call.path === '/api/queue'
      ? Response.json({ items: [{ id: 'a1', state: 'waiting-info', source: 'clickup-board', title: 'Login copy', questions: ['Which page?'], error: null }] })
      : undefined))
    expect(await main(['queue', 'list'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['GET /api/queue'])
    for (const text of ['a1', 'waiting-info', 'clickup-board', 'Login copy', 'Which page?']) expect(h.out()).toContain(text)
  })

  test('list shows the error instead of questions for a failed item', async () => {
    const h = harness(() => Response.json({ items: [{ id: 'b2', state: 'failed', source: 'clickup-board', title: 'Export', questions: ['ignored?'], error: 'Plan step failed' }] }))
    expect(await main(['queue', 'list'], h.deps)).toBe(0)
    expect(h.out()).toContain('Plan step failed')
    expect(h.out()).not.toContain('ignored?')
  })

  test('list says how to add when the queue is empty', async () => {
    const h = harness(() => Response.json({ items: [] }))
    expect(await main(['queue', 'list'], h.deps)).toBe(0)
    expect(h.out()).toBe('The queue is empty. Add an item with: mctl queue add <source> <id> --repo <dir>\n')
  })

  test('add posts source, id, repo, flow and position next', async () => {
    const h = harness((call) => (call.path === '/api/queue' ? Response.json({ item: { id: 'a1', title: 'Login copy' } }) : undefined))
    expect(await main(['queue', 'add', 'clickup-board', '86d3j4f8q', '--repo', '/repo', '--flow', 'wf-1', '--next'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['POST /api/queue'])
    expect(h.calls[0]?.body).toEqual({ source: 'clickup-board', externalId: '86d3j4f8q', repo: '/repo', flowId: 'wf-1', position: 'next' })
    expect(h.out()).toContain('Login copy')
  })

  test('add uses the current directory when --repo is missing', async () => {
    const h = harness(() => Response.json({ item: { id: 'a1', title: 'Login copy' } }), '/work/api')
    expect(await main(['queue', 'add', 'clickup-board', '86d3j4f8q'], h.deps)).toBe(0)
    const body = h.calls[0]?.body
    expect(body?.repo).toBe('/work/api')
    expect(body?.position).toBe('end')
    expect(body !== undefined && 'flowId' in body).toBe(false)
  })

  test('add sends --repo as an absolute path from the current directory or home', async () => {
    for (const [given, sent] of [['../x', '/work/x'], ['~/x', join(homedir(), 'x')], ['~', homedir()]] as const) {
      const h = harness(() => Response.json({ item: { id: 'a1', title: 'Login copy' } }), '/work/here')
      expect(await main(['queue', 'add', 'clickup-board', '86d3j4f8q', '--repo', given], h.deps)).toBe(0)
      expect(h.calls[0]?.body?.repo).toBe(sent)
    }
  })

  test('move sends a whole number and rejects anything else', async () => {
    const ok = harness(() => Response.json({ items: [] }))
    expect(await main(['queue', 'move', 'a1', '2'], ok.deps)).toBe(0)
    expect(routesOf(ok.calls)).toEqual(['POST /api/queue/a1/move'])
    expect(ok.calls[0]?.body).toEqual({ to: 2 })

    for (const bad of ['x', '1.5']) {
      const rejected = harness()
      expect(await main(['queue', 'move', 'a1', bad], rejected.deps)).toBe(2)
      expect(rejected.err()).toContain('mctl: to must be a whole number from 0')
      expect(rejected.err()).toContain("mctl queue --help")
      expect(rejected.calls).toEqual([])
    }
  })

  test('requeue, remove and check hit their routes', async () => {
    const requeue = harness(() => Response.json({ item: { id: 'a1' } }))
    expect(await main(['queue', 'requeue', 'a1'], requeue.deps)).toBe(0)
    expect(routesOf(requeue.calls)).toEqual(['POST /api/queue/a1/requeue'])

    const remove = harness()
    expect(await main(['queue', 'remove', 'a1'], remove.deps)).toBe(0)
    expect(routesOf(remove.calls)).toEqual(['DELETE /api/queue/a1'])

    const check = harness(() => Response.json({ checked: 2, resumed: 1 }))
    expect(await main(['queue', 'check'], check.deps)).toBe(0)
    expect(routesOf(check.calls)).toEqual(['POST /api/queue/check'])
    expect(check.out()).toBe('Checked 2, resumed 1\n')
  })

  test('an id with a slash stays one path segment', async () => {
    const h = harness()
    expect(await main(['queue', 'remove', 'a/b'], h.deps)).toBe(0)
    expect(routesOf(h.calls)).toEqual(['DELETE /api/queue/a%2Fb'])
  })

  test('a refused requeue prints the server message and exits 1', async () => {
    const h = harness(() => Response.json({ error: 'It is building now' }, { status: 409 }))
    expect(await main(['queue', 'requeue', 'a1'], h.deps)).toBe(1)
    expect(h.err()).toContain('It is building now')
  })

  test('--json prints the server answer unchanged', async () => {
    const h = harness(() => Response.json({ checked: 0, resumed: 0 }))
    expect(await main(['queue', 'check', '--json'], h.deps)).toBe(0)
    expect(JSON.parse(h.out())).toEqual({ checked: 0, resumed: 0 })
  })

  test('mctl help lists the queue group', async () => {
    const h = harness()
    expect(await main(['--help'], h.deps)).toBe(0)
    expect(h.out()).toContain('mctl queue requeue <id>')
    expect(h.out()).toContain('Put a failed, ready or waiting item back in line')
  })
})
