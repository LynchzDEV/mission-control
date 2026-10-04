import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Elysia } from 'elysia'

import {
  pluginDataDir,
  spawnChildProcess,
  spawnSupervisorProcess,
  type SupervisorProcess,
  type SupervisorSpawnOptions,
} from '../server/plugins/runtime-isolated'
import { createRuntimes, type RuntimeDeps } from '../server/plugins/runtimes'
import { getInstalled, pluginFolder, type InstalledPlugin } from '../server/plugins/store'
import { pluginsRoutes } from '../server/routes/plugins'
import { createPluginRepo, fileUrl, fixtureSha, isolatedFixtureServer, isolatedManifest, TRIVIAL_SCREEN } from './support/plugin-fixtures'

const networkCapableBun = Bun.semver.satisfies(Bun.version, '>=1.2.23')

let configDir: string
let fixtureRoot: string
let spawned: SupervisorProcess[] = []

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-plugin-isolated-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  fixtureRoot = await mkdtemp(join(tmpdir(), 'mc-plugin-isolated-repos-'))
})

afterEach(async () => {
  for (const proc of spawned) proc.kill('SIGKILL')
  spawned = []
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(fixtureRoot, { recursive: true, force: true })
})

const plainApp = (): Elysia => new Elysia().use(pluginsRoutes())
const local = (init: RequestInit = {}): RequestInit => ({ headers: { host: '127.0.0.1:7777', ...(init.headers ?? {}) }, ...init })

function request(factory: () => Elysia, method: string, path: string, body?: unknown): Promise<Response> {
  return factory().handle(new Request(`http://127.0.0.1:7777${path}`, local({
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })))
}

async function installedPlugin(id: string): Promise<InstalledPlugin> {
  const installed = await getInstalled(id)
  if (installed === null) throw new Error(`plugin ${id} is not installed`)
  return installed
}

const callBody = (method: string, params: unknown = {}): unknown => ({ method, params })

// Spike pass criteria: only STATUS 403|407 or an explicit refusal message proves denial — timeouts, closed/reset connections and bare connect/tunnel errors never do.
function refusalProven(result: unknown): boolean {
  const text = String(result ?? '')
  if (/^STATUS (403|407)$/.test(text)) return true
  if (!text.startsWith('ERROR ')) return false
  const message = text.slice('ERROR '.length)
  if (/econnrefused|refused/i.test(message)) return true
  return /proxy/i.test(message) && /(rejected|denied|forbidden|unauthorized|403|407)/i.test(message)
}

const bareSpawner = (options: SupervisorSpawnOptions): SupervisorProcess =>
  spawnChildProcess([process.execPath, options.plugin.serverBundle], options.plugin.dataDir, { ...process.env, ...options.plugin.env })

const sandboxSpawner = (options: SupervisorSpawnOptions): SupervisorProcess => {
  const proc = spawnSupervisorProcess(options)
  spawned.push(proc)
  return proc
}

const offlineManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  isolatedManifest({ server: 'src/server.ts', permissions: { sessions: ['chat'], settings: true }, ...overrides })

async function installFixture(name: string, manifest: Record<string, unknown>, serverSource: string): Promise<void> {
  const source = await createPluginRepo(join(fixtureRoot, name), manifest, {
    files: { 'src/server.ts': serverSource, 'src/screen.ts': TRIVIAL_SCREEN },
    tag: 'v1.0.0',
  })
  const response = await request(plainApp, 'POST', '/api/plugins/install', { repo: fileUrl(source), ref: 'v1.0.0', commit: await fixtureSha(source) })
  if (response.status !== 200) throw new Error(`install failed: ${await response.text()}`)
}

async function runtimeApp(deps: RuntimeDeps = {}): Promise<{ app: () => Elysia }> {
  const runtimes = await createRuntimes(deps)
  return { app: () => new Elysia().use(pluginsRoutes({ runtimes })) }
}

async function callResult(app: () => Elysia, id: string, method: string, params: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request(app, 'POST', `/api/plugins/${id}/call`, callBody(method, params))
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

describe('bun version gate', () => {
  test('a network plugin on bun 1.2.17 answers 503 and is listed as needs-bun-upgrade', async () => {
    await installFixture('gate', isolatedManifest({ server: 'src/server.ts' }), isolatedFixtureServer({ echo: 'params => params' }))
    const { app } = await runtimeApp({ bunVersion: '1.2.17' })

    const listed = await (await request(app, 'GET', '/api/plugins')).json() as { plugins: Array<{ state: string }> }
    expect(listed.plugins[0]?.state).toBe('needs-bun-upgrade')

    const outcome = await callResult(app, 'fixture-plugin', 'echo')
    expect(outcome.status).toBe(503)
    expect(outcome.body).toEqual({ error: 'Isolated plugins need Bun 1.2.23 or newer. Run: bun upgrade' })
  })

  test('a network plugin on bun 1.4.2 spawns (injected spawner, no sandbox)', async () => {
    await installFixture('gate-new', isolatedManifest({ server: 'src/server.ts' }), isolatedFixtureServer({ echo: 'params => params' }))
    let spawns = 0
    const { app } = await runtimeApp({ bunVersion: '1.4.2', spawnSupervisor: options => { spawns += 1; return bareSpawner(options) } })

    const outcome = await callResult(app, 'fixture-plugin', 'echo', { hello: 'isolated' })
    expect(outcome.status).toBe(200)
    expect(outcome.body).toEqual({ result: { hello: 'isolated' } })
    expect(spawns).toBe(1)
  })

  test('a plugin without network permission spawns on any bun (injected spawner, no sandbox)', async () => {
    await installFixture('gate-none', offlineManifest(), isolatedFixtureServer({ echo: 'params => params' }))
    const { app } = await runtimeApp({ bunVersion: '1.2.17', spawnSupervisor: bareSpawner })

    const outcome = await callResult(app, 'fixture-plugin', 'echo', { ok: true })
    expect(outcome.status).toBe(200)
    expect(outcome.body).toEqual({ result: { ok: true } })
  })
})

describe('network refusal classification (spike criteria)', () => {
  test('accepts only explicit refusals and rejects infrastructure noise', () => {
    const proven = [
      'STATUS 403',
      'STATUS 407',
      'ERROR connect ECONNREFUSED 127.0.0.1:60004',
      'ERROR proxy rejected the request',
      'ERROR Proxy denied CONNECT to api.github.com:443',
      'ERROR tunnel unauthorized by proxy policy',
    ]
    const unproven = [
      'STATUS 200',
      'STATUS 400',
      'ERROR fetch failed',
      'ERROR connect timeout',
      'ERROR connection closed',
      'ERROR connection reset by peer',
      'ERROR proxy connect timeout',
      'ERROR tunnel establishment failed',
      'ERROR request timed out',
    ]
    for (const text of proven) expect(refusalProven(text), text).toBe(true)
    for (const text of unproven) expect(refusalProven(text), text).toBe(false)
  })
})

describe('plugin frame routes', () => {
  test('serves the exact frame html with a csp scoped to the request origin', async () => {
    await installFixture('frame', offlineManifest(), isolatedFixtureServer())
    const response = await request(plainApp, 'GET', '/plugin-frame/fixture-plugin/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src http://127.0.0.1:7777 'unsafe-inline'; style-src http://127.0.0.1:7777 'unsafe-inline'; img-src http://127.0.0.1:7777 data:; connect-src 'none'; frame-ancestors http://127.0.0.1:7777",
    )
    expect(await response.text()).toBe(
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/plugin-frame/fixture-plugin/ui.css"></head><body><div id="root"></div><script>window.__MC_PLUGIN__={id:"fixture-plugin",runtime:"isolated"}</script><script src="/plugin-frame/fixture-plugin/screen.js"></script></body></html>',
    )
  })

  test('serves the iife screen bundle of an enabled isolated plugin', async () => {
    await installFixture('frame-screen', offlineManifest(), isolatedFixtureServer())
    const response = await request(plainApp, 'GET', '/plugin-frame/fixture-plugin/screen.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(await response.text()).toContain('mount')
  })

  test('serves the shared plugin stylesheet to the frame', async () => {
    await installFixture('frame-css', offlineManifest(), isolatedFixtureServer())
    const response = await request(plainApp, 'GET', '/plugin-frame/fixture-plugin/ui.css')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/css')
    expect(await response.text()).toContain('.mk-card')
  })

  test('a plugin without a screen or not installed has no frame assets', async () => {
    await installFixture('frame-none', offlineManifest({ screen: undefined }), isolatedFixtureServer())
    expect((await request(plainApp, 'GET', '/plugin-frame/fixture-plugin/')).status).toBe(200)
    expect((await request(plainApp, 'GET', '/plugin-frame/fixture-plugin/screen.js')).status).toBe(404)
    expect((await request(plainApp, 'GET', '/plugin-frame/unknown-plugin/')).status).toBe(404)
  })

  test('frame assets load from the opaque-origin sandboxed frame, not just same-origin browsers', async () => {
    await installFixture('frame-cross', offlineManifest(), isolatedFixtureServer())
    const crossSite = (path: string, dest: string): Promise<Response> =>
      plainApp().handle(new Request(`http://127.0.0.1:7777${path}`, local({
        headers: { origin: 'null', 'sec-fetch-site': 'cross-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': dest },
      })))

    const html = await crossSite('/plugin-frame/fixture-plugin/', 'iframe')
    expect(html.status).toBe(200)
    const script = await crossSite('/plugin-frame/fixture-plugin/screen.js', 'script')
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript')
    const css = await crossSite('/plugin-frame/fixture-plugin/ui.css', 'style')
    expect(css.status).toBe(200)
  })

  test('frame assets stay local-only and the api stays protected from cross-site requests', async () => {
    await installFixture('frame-guard', offlineManifest(), isolatedFixtureServer())
    const away = await plainApp().handle(new Request('http://127.0.0.1:7777/plugin-frame/fixture-plugin/screen.js', {
      headers: { host: 'cockpit.example', origin: 'null', 'sec-fetch-site': 'cross-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' },
    }))
    expect(away.status).toBe(403)

    const crossSiteApi = await plainApp().handle(new Request('http://127.0.0.1:7777/api/plugins', {
      headers: { host: '127.0.0.1:7777', origin: 'null', 'sec-fetch-site': 'cross-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    }))
    expect(crossSiteApi.status).toBe(403)
  })
})

describe('isolated runtime lifecycle (no sandbox)', () => {
  test('dispose waits for a pending startup, shuts the process down and stays terminal', async () => {
    await installFixture('dispose-race', offlineManifest(), isolatedFixtureServer({ echo: 'params => params' }))
    const procs: SupervisorProcess[] = []
    const runtimes = await createRuntimes({ spawnSupervisor: options => { const proc = bareSpawner(options); procs.push(proc); return proc } })
    const installed = await installedPlugin('fixture-plugin')
    const handle = await runtimes.getRuntime(installed)
    if (!handle.ok) throw new Error(handle.error)

    const calling = handle.runtime.call('echo', { race: true })
    const disposing = handle.runtime.dispose()
    await Promise.allSettled([calling, disposing])

    expect(procs.length).toBe(1)
    expect(await procs[0]?.exited).toBeDefined()
    const after = await handle.runtime.call('echo', {})
    expect(after.ok).toBe(false)
    expect(procs.length).toBe(1)
  }, 10000)
})

describe('isolated runtime under the real sandbox (macOS only)', () => {
  test.skipIf(process.platform !== 'darwin')('a call reaches the sandboxed plugin and its allowed folders (macOS only)', async () => {
    await installFixture('alive', offlineManifest(), isolatedFixtureServer({ echo: 'params => params' }))
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    const bundlePath = join(pluginFolder('fixture-plugin'), '.mc-build', 'server.js')
    const readOwn = await callResult(app, 'fixture-plugin', 'readFile', { path: bundlePath })
    expect(readOwn.status).toBe(200)
    expect(readOwn.body.result).toBe(await readFile(bundlePath, 'utf8'))

    const write = await callResult(app, 'fixture-plugin', 'writeData', { name: 'note.txt' })
    expect(write.body).toEqual({ result: 'ok' })
    const dataDir = pluginDataDir(await installedPlugin('fixture-plugin'))
    expect(await readFile(join(dataDir, 'note.txt'), 'utf8')).toBe('fixture-data')

    const readData = await callResult(app, 'fixture-plugin', 'readFile', { path: join(dataDir, 'note.txt') })
    expect(readData.status).toBe(200)
    expect(readData.body.result).toBe('fixture-data')
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('reading the config dir secrets is denied with EPERM (macOS only)', async () => {
    await installFixture('secrets', offlineManifest(), isolatedFixtureServer())
    await writeFile(join(configDir, 'secrets.json'), '{ "apiToken": "mct_live_should_not_leak" }\n')
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    const outcome = await callResult(app, 'fixture-plugin', 'readFile', { path: join(configDir, 'secrets.json') })
    expect(outcome.status).toBe(200)
    expect(outcome.body.result).toBe('DENIED EPERM')
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('the plugin cannot read its own stored settings file, only ask over rpc (macOS only)', async () => {
    await installFixture('settings-file', offlineManifest(), isolatedFixtureServer())
    await mkdir(join(configDir, 'plugin-settings'), { recursive: true })
    await writeFile(join(configDir, 'plugin-settings', 'fixture-plugin.json'), '{ "token": "pk_should_not_leak" }\n')
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    const outcome = await callResult(app, 'fixture-plugin', 'readFile', { path: join(configDir, 'plugin-settings', 'fixture-plugin.json') })
    expect(outcome.status).toBe(200)
    expect(outcome.body.result).toBe('DENIED EPERM')
    const neighbour = await callResult(app, 'fixture-plugin', 'readFile', { path: join(configDir, 'plugin-data', 'fixture-plugin', 'settings.json') })
    expect(String(neighbour.body.result)).not.toContain('pk_')
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('reading the checkout outside .mc-build is denied with EPERM (macOS only)', async () => {
    await installFixture('checkout', offlineManifest(), isolatedFixtureServer())
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    const outcome = await callResult(app, 'fixture-plugin', 'readFile', { path: join(pluginFolder('fixture-plugin'), 'mc-plugin.json') })
    expect(outcome.status).toBe(200)
    expect(outcome.body.result).toBe('DENIED EPERM')
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('writing outside the data folder is denied (macOS only)', async () => {
    await installFixture('writes', offlineManifest(), isolatedFixtureServer())
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    const escapePath = join(configDir, 'escape-proof.txt')
    const outcome = await callResult(app, 'fixture-plugin', 'writeAbs', { path: escapePath })
    expect(outcome.status).toBe(200)
    expect(outcome.body.result).toBe('DENIED EPERM')
    await expect(readFile(escapePath, 'utf8')).rejects.toThrow()
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('settings round-trip over the rpc connection (macOS only)', async () => {
    await installFixture('settings', offlineManifest(), isolatedFixtureServer())
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })
    const saved = await request(app, 'PUT', '/api/plugins/fixture-plugin/settings', { key: 'token', value: 'pk-isolated-secret' })
    expect(saved.status).toBe(200)

    const outcome = await callResult(app, 'fixture-plugin', 'askSetting', { key: 'token' })
    expect(outcome.status).toBe(200)
    expect(outcome.body.result).toBe('pk-isolated-secret')
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('a crash rejects the in-flight call with the plugin stopped (macOS only)', async () => {
    await installFixture('crash', offlineManifest(), isolatedFixtureServer())
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    const outcome = await callResult(app, 'fixture-plugin', 'crash')
    expect(outcome.status).toBe(500)
    expect(String(outcome.body.error)).toMatch(/^The plugin stopped/)
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('three crashes stop the plugin until it is re-enabled (macOS only)', async () => {
    await installFixture('crash-loop', offlineManifest(), isolatedFixtureServer({ echo: 'params => params' }))
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    for (let i = 0; i < 3; i += 1) {
      const crash = await callResult(app, 'fixture-plugin', 'crash')
      expect(crash.status).toBe(500)
    }

    const refused = await callResult(app, 'fixture-plugin', 'echo')
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: 'Stopped after repeated crashes' })

    const listed = await (await request(app, 'GET', '/api/plugins')).json() as { plugins: Array<{ state: string }> }
    expect(listed.plugins[0]?.state).toBe('stopped')

    await request(app, 'PATCH', '/api/plugins/fixture-plugin', { enabled: false })
    await request(app, 'PATCH', '/api/plugins/fixture-plugin', { enabled: true })
    const fresh = await callResult(app, 'fixture-plugin', 'echo', { back: true })
    expect(fresh.status).toBe(200)
    expect(fresh.body).toEqual({ result: { back: true } })
  }, 30000)

  test.skipIf(process.platform !== 'darwin')('idle stop exits the supervisor and the plugin process (macOS only)', async () => {
    await installFixture('idle', offlineManifest(), isolatedFixtureServer({ echo: 'params => params' }))
    const { app } = await runtimeApp({ idleStopMs: 100, spawnSupervisor: sandboxSpawner })

    const outcome = await callResult(app, 'fixture-plugin', 'echo')
    expect(outcome.status).toBe(200)

    const dataDir = pluginDataDir(await installedPlugin('fixture-plugin'))
    const pluginPid = Number.parseInt((await readFile(join(dataDir, 'server.pid'), 'utf8')).trim(), 10)
    const supervisor = spawned[spawned.length - 1]
    expect(supervisor?.pid).toBeDefined()
    const supervisorPid = supervisor?.pid as number

    const exitCode = await supervisor?.exited
    expect(exitCode).toBe(0)
    expect(() => process.kill(supervisorPid, 0)).toThrow(/ESRCH|no such process/)
    expect(() => process.kill(pluginPid, 0)).toThrow(/ESRCH|no such process/)
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('the sandboxed plugin inherits no host environment beyond its allowlist (macOS only)', async () => {
    process.env.MC_TEST_HOST_ONLY_MARKER = 'host-side-secret'
    try {
      await installFixture('env-wall', offlineManifest(), isolatedFixtureServer({ readEnv: 'params => process.env[params.key] ?? null' }))
      const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

      const marker = await callResult(app, 'fixture-plugin', 'readEnv', { key: 'MC_TEST_HOST_ONLY_MARKER' })
      expect(marker.body.result).toBeNull()
      const home = await callResult(app, 'fixture-plugin', 'readEnv', { key: 'HOME' })
      expect(home.body.result).toBeNull()
      const runtime = await callResult(app, 'fixture-plugin', 'readEnv', { key: 'MC_PLUGIN_RUNTIME' })
      expect(runtime.body.result).toBe('isolated')
      const data = await callResult(app, 'fixture-plugin', 'readEnv', { key: 'MC_PLUGIN_DATA' })
      expect(data.body.result).toBe(pluginDataDir(await installedPlugin('fixture-plugin')))
    } finally {
      delete process.env.MC_TEST_HOST_ONLY_MARKER
    }
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('disposing of a plugin that ignores shutdown and SIGTERM still kills it (macOS only)', async () => {
    await installFixture('stubborn', offlineManifest(), isolatedFixtureServer({ echo: 'params => params' }, { stubborn: true }))
    const runtimes = await createRuntimes({ killGraceMs: 100, spawnSupervisor: sandboxSpawner })
    const app = (): Elysia => new Elysia().use(pluginsRoutes({ runtimes }))

    const outcome = await callResult(app, 'fixture-plugin', 'echo', { alive: true })
    expect(outcome.status).toBe(200)
    expect(outcome.body.result).toEqual({ alive: true })

    const dataDir = pluginDataDir(await installedPlugin('fixture-plugin'))
    const pluginPid = Number.parseInt((await readFile(join(dataDir, 'server.pid'), 'utf8')).trim(), 10)
    const supervisor = spawned[spawned.length - 1]
    expect(supervisor?.pid).toBeDefined()
    const supervisorPid = supervisor?.pid as number

    const installed = await installedPlugin('fixture-plugin')
    const handle = await runtimes.getRuntime(installed)
    if (!handle.ok) throw new Error(handle.error)
    await handle.runtime.dispose()

    expect(await supervisor?.exited).toBeDefined()
    expect(() => process.kill(supervisorPid, 0)).toThrow(/ESRCH|no such process/)
    expect(() => process.kill(pluginPid, 0)).toThrow(/ESRCH|no such process/)
  }, 15000)

  test.skipIf(process.platform !== 'darwin')('two plugins keep separate filesystems: cwd is the data folder and no shared path is reachable (macOS only)', async () => {
    const offline = (id: string): Record<string, unknown> => isolatedManifest({ id, server: 'src/server.ts', permissions: { sessions: ['chat'], settings: true } })
    const writeCwd = 'params => { try { writeFileSync(params.name, "cwd-write"); return `WROTE ${process.cwd()}` } catch (error) { return classify(error) } }'
    await installFixture('fs-alpha', offline('fs-alpha'), isolatedFixtureServer())
    await installFixture('fs-beta', offline('fs-beta'), isolatedFixtureServer({ writeCwd }))
    const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

    const betaData = pluginDataDir(await installedPlugin('fs-beta'))
    const written = await callResult(app, 'fs-beta', 'writeCwd', { name: 'rel-note.txt' })
    expect(written.status).toBe(200)
    expect(written.body.result).toBe(`WROTE ${await realpath(betaData)}`)
    expect(await readFile(join(betaData, 'rel-note.txt'), 'utf8')).toBe('cwd-write')

    const escape = await callResult(app, 'fs-beta', 'writeCwd', { name: '../escape-proof.txt' })
    expect(escape.body.result).toBe('DENIED EPERM')

    const alphaRead = await callResult(app, 'fs-alpha', 'readFile', { path: join(betaData, 'rel-note.txt') })
    expect(alphaRead.body.result).toBe('DENIED EPERM')

    const alphaWrite = await callResult(app, 'fs-alpha', 'writeAbs', { path: join(betaData, 'alpha-marker.txt') })
    expect(alphaWrite.body.result).toBe('DENIED EPERM')

    const sharedMarker = join('/tmp', 'claude', 'mc-isolated-fs-test.txt')
    await mkdir(dirname(sharedMarker), { recursive: true })
    await writeFile(sharedMarker, 'shared-temp\n')
    try {
      const sharedRead = await callResult(app, 'fs-alpha', 'readFile', { path: sharedMarker })
      expect(sharedRead.body.result).toBe('DENIED EPERM')
    } finally {
      await rm(sharedMarker, { force: true })
    }
  }, 20000)

  test.skipIf(!networkCapableBun || process.platform !== 'darwin')(
    'two plugins keep separate network allowlists (needs bun 1.2.23; the host proxy cannot parse HTTP CONNECT below that)',
    async () => {
      await installFixture('net-alpha', isolatedManifest({ id: 'net-alpha', server: 'src/server.ts', permissions: { network: ['example.com'], settings: true } }), isolatedFixtureServer())
      await installFixture('net-beta', isolatedManifest({ id: 'net-beta', server: 'src/server.ts', permissions: { network: ['api.github.com'], settings: true } }), isolatedFixtureServer())
      const { app } = await runtimeApp({ spawnSupervisor: sandboxSpawner })

      const allowed = await callResult(app, 'net-alpha', 'fetchUrl', { url: 'https://example.com' })
      expect(allowed.body.result).toBe('STATUS 200')

      const refusedCross = await callResult(app, 'net-alpha', 'fetchUrl', { url: 'https://api.github.com' })
      expect(refusalProven(refusedCross.body.result), String(refusedCross.body.result)).toBe(true)

      const refusedOther = await callResult(app, 'net-beta', 'fetchUrl', { url: 'https://example.com' })
      expect(refusalProven(refusedOther.body.result), String(refusedOther.body.result)).toBe(true)

      const betaAllowed = await callResult(app, 'net-beta', 'fetchUrl', { url: 'https://api.github.com' })
      expect(betaAllowed.body.result).toBe('STATUS 200')
    }, 30000)
})
