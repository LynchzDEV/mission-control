import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SPIKE_DIR, '..', '..', '..')
const FIXTURE_PATH = join(SPIKE_DIR, 'fixture-plugin.ts')
const DATA_DIR = await mkdtemp(join(tmpdir(), 'mc-spike-data-'))
const DATA_TMP_DIR = join(DATA_DIR, 'tmp')
await mkdir(DATA_TMP_DIR)
const RPC_TIMEOUT_MS = 30000
const STARTUP_BUDGET_MS = 10000
const SECRETS_PATH = join(homedir(), '.config', 'mission-control', 'secrets.json')
const SSH_CONFIG_PATH = join(homedir(), '.ssh', 'config')

const config: SandboxRuntimeConfig = {
  network: { allowedDomains: ['example.com'], deniedDomains: [] },
  filesystem: {
    denyRead: [homedir()],
    allowRead: [
      REPO_ROOT,
      join(REPO_ROOT, 'node_modules'),
      dirname(process.execPath),
      join(homedir(), '.bun'),
    ],
    allowWrite: [DATA_DIR],
    denyWrite: [],
  },
}

type ProbeOutcome = { result: unknown; error: unknown }

type PluginClient = {
  probe(method: string, params: Record<string, string>, timeoutMs?: number): Promise<ProbeOutcome>
  shutdown(): void
}

const results: Array<{ name: string; pass: boolean }> = []

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 200)
  return JSON.stringify(value)
}

function describeOutcome(outcome: ProbeOutcome): string {
  if (outcome.error !== undefined) {
    return outcome.error instanceof Error ? `threw: ${outcome.error.message}` : `threw: ${String(outcome.error)}`
  }
  return describeValue(outcome.result)
}

function isDeniedBySandbox(result: unknown): boolean {
  return result === 'DENIED EPERM' || result === 'DENIED EACCES'
}

function isDeniedByNetworkPolicy(result: unknown): boolean {
  if (result === 'STATUS 403' || result === 'STATUS 407') return true
  if (typeof result !== 'string' || !result.startsWith('ERROR ')) return false
  const message = result.slice('ERROR '.length)
  if (/econnrefused|refused/i.test(message)) return true
  return /proxy/i.test(message) && /reject|denied|forbidden|unauthori[sz]ed|403|407/i.test(message)
}

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parse(actual), parse(minimum)]
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

function reportEnvironment(): void {
  const pkg = readFileSync(join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'package.json'), 'utf8')
  const srtVersion = (JSON.parse(pkg) as { version: string }).version
  console.log(`spike bun=${Bun.version} sandbox-runtime=${srtVersion} darwin`)
  if (!isVersionAtLeast(Bun.version, '1.2.23')) {
    console.log(
      `note: bun ${Bun.version} cannot parse HTTP CONNECT inside node:http (fixed by bun 1.2.23); net-allowed/net-denied are expected to FAIL with STATUS 400 under this host`,
    )
  }
}

function report(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`)
  results.push({ name, pass })
}

function reportSecretRead(name: string, outcome: ProbeOutcome): void {
  if (isDeniedBySandbox(outcome.result)) {
    report(name, true, describeValue(outcome.result))
    return
  }
  if (outcome.error !== undefined || (typeof outcome.result === 'string' && outcome.result.startsWith('ERROR '))) {
    report(name, false, describeOutcome(outcome))
    return
  }
  report(name, false, 'readable')
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit()
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveExit()
    }, timeoutMs)
    child.on('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function startPlugin(): Promise<{ plugin: PluginClient; child: ChildProcess }> {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    `${shellQuote(process.execPath)} ${shellQuote(FIXTURE_PATH)}`,
  )

  const child = spawn(argv[0], argv.slice(1), {
    shell: false,
    cwd: DATA_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...env,
      MC_PLUGIN_RUNTIME: 'isolated',
      MC_PLUGIN_ID: 'sandbox-spike',
      MC_PLUGIN_DATA: DATA_DIR,
      BUN_TMPDIR: DATA_TMP_DIR,
    },
  })

  const childGone = new Promise<never>((_, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error(`plugin process exited (code=${child.exitCode} signal=${child.signalCode ?? 'none'})`))
    }
    child.on('exit', (code, signal) => reject(new Error(`plugin process exited (code=${code} signal=${signal})`)))
  })

  const connection: MessageConnection = createMessageConnection(
    new StreamMessageReader(child.stdout ?? undefined),
    new StreamMessageWriter(child.stdin ?? undefined),
  )
  connection.onRequest<string | null>('settings.get', () => 'spike-value')
  connection.onNotification('log', params => {
    const message =
      typeof params === 'object' && params !== null && 'message' in params
        ? String((params as { message: unknown }).message)
        : String(params)
    console.error(`[plugin-log] ${message}`)
  })
  connection.listen()

  const plugin: PluginClient = {
    async probe(method, params, timeoutMs = RPC_TIMEOUT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`plugin.call ${method} timed out after ${timeoutMs}ms`)), timeoutMs)
      })
      try {
        return {
          result: await Promise.race([connection.sendRequest('plugin.call', { method, params }), timeout, childGone]),
          error: undefined,
        }
      } catch (error) {
        return { result: undefined, error }
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    shutdown() {
      connection.sendNotification('plugin.shutdown')
    },
  }

  return { plugin, child }
}

async function probeStartupAndReadOwn(plugin: PluginClient): Promise<void> {
  const fixtureSource = readFileSync(FIXTURE_PATH, 'utf8')
  const beganAt = Date.now()
  const outcome = await plugin.probe('readFile', { path: FIXTURE_PATH }, STARTUP_BUDGET_MS)
  const elapsedMs = Date.now() - beganAt
  report('startup', outcome.error === undefined, `${elapsedMs}ms`)
  report(
    'read-own',
    outcome.error === undefined && outcome.result === fixtureSource,
    outcome.error === undefined
      ? outcome.result === fixtureSource
        ? 'content matches fixture-plugin.ts'
        : `unexpected result: ${describeValue(outcome.result).slice(0, 120)}`
      : 'no answer',
  )
}

async function probeNetwork(plugin: PluginClient): Promise<void> {
  const netAllowed = await plugin.probe('fetchUrl', { url: 'https://example.com' })
  const netAllowedPassed = netAllowed.error === undefined && netAllowed.result === 'STATUS 200'
  report('net-allowed', netAllowedPassed, describeOutcome(netAllowed))

  const netDenied = await plugin.probe('fetchUrl', { url: 'https://api.github.com' })
  report(
    'net-denied',
    netAllowedPassed && netDenied.error === undefined && isDeniedByNetworkPolicy(netDenied.result),
    describeOutcome(netDenied),
  )
}

async function probeWrites(plugin: PluginClient): Promise<void> {
  const writeData = await plugin.probe('writeData', { name: 'spike.txt' })
  const forbiddenPath = join(homedir(), `mc-spike-${randomBytes(8).toString('hex')}`)
  const writeAbs = await plugin.probe('writeAbs', { path: forbiddenPath })
  const dataFile = join(DATA_DIR, 'spike.txt')
  const writeDataOk = writeData.error === undefined && writeData.result === 'ok'
  const dataWritten = existsSync(dataFile) && readFileSync(dataFile, 'utf8') === 'spike-data'
  const writeAbsDenied = writeAbs.error === undefined && isDeniedBySandbox(writeAbs.result) && !existsSync(forbiddenPath)
  report(
    'write-data',
    writeDataOk && dataWritten && writeAbsDenied,
    `writeData=${describeOutcome(writeData)} data-file=${dataWritten ? 'ok' : 'missing'} writeAbs(${forbiddenPath})=${describeOutcome(writeAbs)}`,
  )
}

function reportVerdict(): number {
  const failures = results.filter(entry => !entry.pass)
  console.log(failures.length === 0 ? 'VERDICT: GO' : `VERDICT: NO-GO ${failures.map(entry => entry.name).join(', ')}`)
  return failures.length === 0 ? 0 : 1
}

async function main(): Promise<void> {
  reportEnvironment()
  process.env.CLAUDE_CODE_TMPDIR = DATA_TMP_DIR
  await SandboxManager.initialize(config)

  const { plugin, child } = await startPlugin()
  await probeStartupAndReadOwn(plugin)
  reportSecretRead('read-secret', await plugin.probe('readFile', { path: SECRETS_PATH }))
  reportSecretRead('read-ssh', await plugin.probe('readFile', { path: SSH_CONFIG_PATH }))
  await probeNetwork(plugin)
  await probeWrites(plugin)
  const setting = await plugin.probe('askSetting', { key: 'spike-key' })
  report('settings-roundtrip', setting.error === undefined && setting.result === 'spike-value', describeOutcome(setting))

  plugin.shutdown()
  await waitForExit(child, 5000)
  await SandboxManager.reset()
  await rm(DATA_DIR, { recursive: true, force: true })
  process.exit(reportVerdict())
}

await main()
