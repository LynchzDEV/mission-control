import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { getSetting, setServerSetting } from '../server/plugins/settings'
import { createRuntimes } from '../server/plugins/runtimes'
import { pluginsRoutes } from '../server/routes/plugins'
import { commitFixture, createPluginRepo, fileUrl, fixtureSha, isolatedManifest, TRIVIAL_SCREEN, trustedManifest } from './support/plugin-fixtures'

let configDir: string
let fixtureRoot: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-plugin-trusted-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  fixtureRoot = await mkdtemp(join(tmpdir(), 'mc-plugin-trusted-repos-'))
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(fixtureRoot, { recursive: true, force: true })
})

const app = (): Elysia => new Elysia().use(pluginsRoutes())
const local = (init: RequestInit = {}) => ({ headers: { host: '127.0.0.1:7777', ...(init.headers ?? {}) }, ...init })
const request = (factory: () => Elysia, method: string, path: string, body?: unknown): Promise<Response> =>
  factory().handle(new Request(`http://127.0.0.1:7777${path}`, local({
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })))
const json = (method: string, path: string, body?: unknown): Promise<Response> => request(app, method, path, body)
const call = (method: string, params: unknown = {}): Promise<Response> =>
  json('POST', '/api/plugins/fixture-plugin/call', { method, params })

function serverModule(version: string): string {
  return `export default {
  methods: {
    echo: params => params,
    secret: async (_params, ctx) => ctx.settings.get('token'),
    boom: () => {
      throw new Error('boom')
    },
    never: () => new Promise(() => {}),
    version: () => ${JSON.stringify(version)},
    saveSetting: async (params, ctx) => {
      await ctx.settings.set(params.key, params.value)
      return 'saved'
    },
    dataPath: (_params, ctx) => ctx.data,
  },
}
`
}

async function installTrusted(name: string, manifest: Record<string, unknown> = trustedManifest({ server: 'src/server.ts' }), version = 'v1'): Promise<string> {
  const source = await createPluginRepo(join(fixtureRoot, name), manifest, {
    files: { 'src/server.ts': serverModule(version), 'src/screen.ts': TRIVIAL_SCREEN },
    tag: 'v1.0.0',
  })
  const response = await json('POST', '/api/plugins/install', { repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source), trust: true })
  if (response.status !== 200) throw new Error(`install failed: ${await response.text()}`)
  return source
}

describe('call route', () => {
  test('echo returns the params it was given', async () => {
    await installTrusted('echo')
    const response = await call('echo', { hello: 'world', n: 3 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: { hello: 'world', n: 3 } })
  })

  test('a method can read a stored secret', async () => {
    await installTrusted('secret')
    await json('PUT', '/api/plugins/fixture-plugin/settings', { key: 'token', value: 'pk-trusted-secret' })
    const response = await call('secret')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: 'pk-trusted-secret' })
  })

  test('an unknown method is a 404 naming the method', async () => {
    await installTrusted('unknown')
    const response = await call('nope')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'No method nope' })
  })

  test('an inherited name like toString is not a method', async () => {
    await installTrusted('inherited')
    const response = await call('toString')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'No method toString' })
  })

  test('a method that never resolves times out', async () => {
    await installTrusted('never')
    const runtimes = await createRuntimes({ rpcTimeoutMs: 50 })
    const slowApp = (): Elysia => new Elysia().use(pluginsRoutes({ runtimes }))
    const response = await request(slowApp, 'POST', '/api/plugins/fixture-plugin/call', { method: 'never', params: {} })
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'The plugin did not answer' })
  })

  test('a throwing method is a 500 with its message', async () => {
    await installTrusted('boom')
    const response = await call('boom')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'boom' })
  })

  test('an isolated plugin answers 501 until its runtime lands', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'isolated'), isolatedManifest(), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
    await json('POST', '/api/plugins/install', { repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    const response = await call('echo')
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: 'Isolated runtime not available yet' })
  })

  test('a disabled plugin stops answering on every route', async () => {
    await installTrusted('disabled')
    await json('PATCH', '/api/plugins/fixture-plugin', { enabled: false })

    const refused = await call('echo')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'This plugin is turned off' })
    expect((await json('POST', '/api/plugins/fixture-plugin/context', { name: 'x', markdown: '# x' })).status).toBe(409)
    expect((await request(app, 'GET', '/plugin-module/fixture-plugin/screen.js')).status).toBe(404)
  })

  test('an uninstalled plugin is a 404', async () => {
    await installTrusted('uninstalled')
    await json('DELETE', '/api/plugins/fixture-plugin')
    const response = await call('echo')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'That plugin is not installed' })
  })
})

describe('server context', () => {
  test('the server part may store an undeclared key while the settings route may not', async () => {
    await installTrusted('server-settings')

    const refused = await json('PUT', '/api/plugins/fixture-plugin/settings', { key: 'boards', value: '[]' })
    expect(refused.status).toBe(400)

    const saved = await call('saveSetting', { key: 'boards', value: '[]' })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ result: 'saved' })
  })

  test('an invalid key from the server part is a 500', async () => {
    await installTrusted('bad-key')
    const response = await call('saveSetting', { key: 'not allowed!', value: 'x' })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Invalid setting key: not allowed!' })
  })

  test('ctx.data is a private folder under plugin-data', async () => {
    await installTrusted('data')
    const response = await call('dataPath')
    const { result } = await response.json()
    expect(result).toBe(join(configDir, 'plugin-data', 'fixture-plugin', 'files'))
    const info = await stat(result)
    expect(info.isDirectory()).toBe(true)
    expect(info.mode & 0o777).toBe(0o700)
  })

  test('a reserved server-setting key round trips and clears', async () => {
    await installTrusted('reserved-key')

    await setServerSetting('fixture-plugin', '__proto__', 'stored-value')
    await setServerSetting('fixture-plugin', 'ordinary', 'kept')
    expect(await getSetting('fixture-plugin', '__proto__')).toBe('stored-value')
    expect(await getSetting('fixture-plugin', 'ordinary')).toBe('kept')

    const stored = JSON.parse(await readFile(join(configDir, 'plugin-data', 'fixture-plugin', 'settings.json'), 'utf8'))
    expect(Object.getOwnPropertyDescriptor(stored, '__proto__')?.value).toBe('stored-value')

    await setServerSetting('fixture-plugin', '__proto__', null)
    expect(await getSetting('fixture-plugin', '__proto__')).toBeNull()
  })

  test('a declared reserved key round trips through the settings route', async () => {
    await installTrusted('declared-reserved', trustedManifest({
      server: 'src/server.ts',
      settings: [
        { key: 'token', label: 'Token', type: 'secret' },
        { key: '__proto__', label: 'Reserved', type: 'text' },
      ],
    }))

    const saved = await json('PUT', '/api/plugins/fixture-plugin/settings', { key: '__proto__', value: 'declared-value' })
    expect(saved.status).toBe(200)

    const view = await (await json('GET', '/api/plugins/fixture-plugin/settings')).json()
    expect(view.values['__proto__']).toBe('declared-value')
    expect(view.configured['__proto__']).toBe(true)
  })
})

describe('context route', () => {
  test('writes the task context and returns its path', async () => {
    await installTrusted('context')
    const session = await mkdtemp(join(homedir(), '.mc-context-route-'))
    try {
      Bun.spawnSync(['git', 'init', '-q', session])
      const response = await json('POST', '/api/plugins/fixture-plugin/context', { name: 'Task plan', markdown: '# Do it\n', cwd: session })
      expect(response.status).toBe(200)
      const { path } = await response.json()
      expect(path).toContain(join(await realpath(session), '.mission-control', 'context', 'fixture-plugin'))
      expect(path).toMatch(/task-plan\.md$/)
      expect(await readFile(path, 'utf8')).toBe('# Do it\n')
      expect(await readFile(join(session, '.git', 'info', 'exclude'), 'utf8')).toContain('/.mission-control/')
      expect(Bun.spawnSync(['git', '-C', session, 'status', '--porcelain']).stdout.toString()).toBe('')
    } finally {
      await rm(session, { recursive: true, force: true })
    }
  })

  test('the context route needs a folder under home', async () => {
    await installTrusted('context-cwd')
    expect((await json('POST', '/api/plugins/fixture-plugin/context', { name: 'x', markdown: 'y' })).status).toBe(400)
    expect((await json('POST', '/api/plugins/fixture-plugin/context', { name: 'x', markdown: 'y', cwd: '/definitely/not/here' })).status).toBe(400)
  })

  test('a plugin without the sessions permission is a 403', async () => {
    await installTrusted('no-sessions', trustedManifest({ server: 'src/server.ts', permissions: { settings: true } }))
    const response = await json('POST', '/api/plugins/fixture-plugin/context', { name: 'Task plan', markdown: '# Do it', cwd: homedir() })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'This plugin did not ask to start sessions' })
  })
})

describe('plugin module route', () => {
  test('serves the built screen of an enabled trusted plugin', async () => {
    await installTrusted('screen')
    const response = await request(app, 'GET', '/plugin-module/fixture-plugin/screen.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(await response.text()).toContain('mount')
  })

  test('an isolated plugin has no plugin module', async () => {
    const source = await createPluginRepo(join(fixtureRoot, 'isolated-screen'), isolatedManifest(), { files: { 'src/screen.ts': TRIVIAL_SCREEN }, tag: 'v1.0.0' })
    await json('POST', '/api/plugins/install', { repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
    expect((await request(app, 'GET', '/plugin-module/fixture-plugin/screen.js')).status).toBe(404)
  })
})

describe('trusted update needs a restart', () => {
  test('keeps the old module until Mission Control restarts', async () => {
    const source = await installTrusted('restart')
    expect(await (await call('version')).json()).toEqual({ result: 'v1' })

    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(trustedManifest({ version: '2.0.0', server: 'src/server.ts' }), null, 2)}\n`,
      'src/server.ts': serverModule('v2'),
    }, { tag: 'v2.0.0' })
    const updated = await json('POST', '/api/plugins/fixture-plugin/update', { ref: 'v2.0.0', commit: await fixtureSha(source) })
    expect(updated.status).toBe(200)

    expect(await (await call('version')).json()).toEqual({ result: 'v1' })
    const listed = await (await json('GET', '/api/plugins')).json()
    expect(listed.plugins[0].restartRequired).toBe(true)

    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'support', 'plugin-call.ts'), 'fixture-plugin', 'version'], {
      env: { ...process.env, MISSION_CONTROL_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('"v2"')

    const registry = JSON.parse(await readFile(join(configDir, 'plugins.json'), 'utf8'))
    expect(registry.plugins[0].restartRequired).toBeUndefined()
  }, 10000)

  test('keeps the old module when the update renames the server entry', async () => {
    const source = await installTrusted('restart-renamed')
    expect(await (await call('version')).json()).toEqual({ result: 'v1' })

    await commitFixture(source, {
      'mc-plugin.json': `${JSON.stringify(trustedManifest({ version: '2.0.0', server: 'src/new-server.ts' }), null, 2)}\n`,
      'src/new-server.ts': serverModule('v2'),
    }, { tag: 'v2.0.0' })
    const updated = await json('POST', '/api/plugins/fixture-plugin/update', { ref: 'v2.0.0', commit: await fixtureSha(source) })
    expect(updated.status).toBe(200)

    expect(await (await call('version')).json()).toEqual({ result: 'v1' })
    const listed = await (await json('GET', '/api/plugins')).json()
    expect(listed.plugins[0].restartRequired).toBe(true)

    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'support', 'plugin-call.ts'), 'fixture-plugin', 'version'], {
      env: { ...process.env, MISSION_CONTROL_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('"v2"')

    const registry = JSON.parse(await readFile(join(configDir, 'plugins.json'), 'utf8'))
    expect(registry.plugins[0].restartRequired).toBeUndefined()
  }, 10000)
})
