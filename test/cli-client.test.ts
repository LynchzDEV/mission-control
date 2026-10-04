import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, type MainDeps } from '../cli/mctl'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-cli-client-config-'))
})

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true })
})

type Recorded = { url: string; authorization: string | null }

function harness(env: Record<string, string | undefined>, respond: (request: Request) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: Recorded[] = []
  let out = ''
  let err = ''
  const deps: MainDeps = {
    fetch: async (request) => {
      calls.push({ url: request.url, authorization: request.headers.get('authorization') })
      return respond(request)
    },
    stdout: (text) => { out += text },
    stderr: (text) => { err += text },
    env: { MISSION_CONTROL_CONFIG_DIR: configDir, ...env },
    cwd: configDir,
  }
  return { deps, calls, out: () => out, err: () => err }
}

describe('token resolution', () => {
  test('MC_TOKEN wins over secrets.json', async () => {
    await writeFile(join(configDir, 'secrets.json'), JSON.stringify({ apiToken: 'mct_from_file' }))
    const h = harness({ MC_TOKEN: 'mct_from_env' })
    expect(await main(['models', '--json'], h.deps)).toBe(0)
    expect(h.calls[0]!.authorization).toBe('Bearer mct_from_env')
  })

  test('falls back to apiToken in secrets.json under the config dir', async () => {
    await writeFile(join(configDir, 'secrets.json'), JSON.stringify({ apiToken: 'mct_from_file' }))
    const h = harness({})
    expect(await main(['models', '--json'], h.deps)).toBe(0)
    expect(h.calls[0]!.authorization).toBe('Bearer mct_from_file')
  })

  test('sends no Authorization header when there is no token anywhere', async () => {
    const h = harness({})
    expect(await main(['models', '--json'], h.deps)).toBe(0)
    expect(h.calls[0]!.authorization).toBeNull()
  })

  test('a secrets.json without apiToken means no header', async () => {
    await writeFile(join(configDir, 'secrets.json'), JSON.stringify({ zaiBaseUrl: 'x' }))
    const h = harness({})
    await main(['models', '--json'], h.deps)
    expect(h.calls[0]!.authorization).toBeNull()
  })
})

describe('url resolution', () => {
  test('defaults to the local cockpit', async () => {
    const h = harness({})
    await main(['models'], h.deps)
    expect(h.calls[0]!.url).toBe('http://127.0.0.1:7777/api/models')
  })

  test('MC_URL overrides the default', async () => {
    const h = harness({ MC_URL: 'http://localhost:9000' })
    await main(['models'], h.deps)
    expect(h.calls[0]!.url).toBe('http://localhost:9000/api/models')
  })

  test('--url overrides MC_URL, with or without a trailing slash', async () => {
    const h = harness({ MC_URL: 'http://localhost:9000' })
    await main(['--url', 'http://example.test:1234/', 'models'], h.deps)
    expect(h.calls[0]!.url).toBe('http://example.test:1234/api/models')
  })
})

describe('exit codes', () => {
  test('an API error exits 1 and prints the server message', async () => {
    const h = harness({}, () => Response.json({ error: 'job not found' }, { status: 404 }))
    expect(await main(['job', 'log', 'nope'], h.deps)).toBe(1)
    expect(h.err()).toContain('job not found')
    expect(h.out()).toBe('')
  })

  test('an API error without a JSON body still exits 1 with the status', async () => {
    const h = harness({}, () => new Response('boom', { status: 500 }))
    expect(await main(['models'], h.deps)).toBe(1)
    expect(h.err()).toContain('500')
  })

  test('an API error under --json still exits 1 and prints the error on stderr', async () => {
    const h = harness({}, () => Response.json({ error: 'local access only' }, { status: 403 }))
    expect(await main(['models', '--json'], h.deps)).toBe(1)
    expect(h.err()).toContain('local access only')
  })

  test('connection refused exits 3 with the start hint', async () => {
    const h = harness({ MC_URL: 'http://127.0.0.1:1' }, () => { throw new TypeError('Unable to connect. Is the computer able to access the url?') })
    expect(await main(['status'], h.deps)).toBe(3)
    expect(h.err()).toContain("Mission Control isn't running at http://127.0.0.1:1. Start it with: bun run start")
  })

  test('a real refused connection exits 3', async () => {
    const h = harness({})
    h.deps.fetch = (request) => fetch(request)
    expect(await main(['--url', 'http://127.0.0.1:1', 'status'], h.deps)).toBe(3)
    expect(h.err()).toContain("Mission Control isn't running at http://127.0.0.1:1")
  })
})
