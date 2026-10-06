import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'

import { DIR_MODE, configDir } from '../secrets'
import { errorMessage } from './errors'
import type { CallOutcome } from './runtime-trusted'
import { getSetting, setServerSetting } from './settings'
import { pluginFolder, type InstalledPlugin } from './store'

export const IDLE_STOP_MS = 600000
export const KILL_GRACE_MS = 2000
export const CRASH_LIMIT = 3
export const CRASH_WINDOW_MS = 300000
export const UPGRADE_BUN_MESSAGE = 'Isolated plugins need Bun 1.2.23 or newer. Run: bun upgrade'

const MIN_BUN_FOR_NETWORK = '1.2.23'
const STDERR_TAIL_LINES = 5

export type SupervisorSpawnOptions = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  plugin: { serverBundle: string; dataDir: string; env: Record<string, string> }
}

export type SupervisorProcess = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  pid: number | undefined
  exited: Promise<number | null>
  kill(signal?: NodeJS.Signals): void
}

export type IsolatedRuntimeDeps = {
  rpcTimeoutMs?: number
  idleStopMs?: number
  killGraceMs?: number
  crashWindowMs?: number
  bunVersion?: string
  spawnSupervisor?: (options: SupervisorSpawnOptions) => SupervisorProcess
}

export type IsolatedRuntime = {
  call(method: string, params: unknown): Promise<CallOutcome>
  dispose(): Promise<void>
  isStopped(): boolean
}

export function needsBunUpgrade(installed: InstalledPlugin, version: string): boolean {
  return installed.runtime === 'isolated'
    && (installed.permissions.network ?? []).length > 0
    && !Bun.semver.satisfies(version, `>=${MIN_BUN_FOR_NETWORK}`)
}

export function spawnChildProcess(argv: string[], cwd: string, env: NodeJS.ProcessEnv): SupervisorProcess {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  const exited = new Promise<number | null>(resolve => {
    child.on('exit', code => resolve(code))
  })
  const silent = (): void => {}
  child.stdin?.on('error', silent)
  child.stdout?.on('error', silent)
  child.stderr?.on('error', silent)
  return {
    stdin: child.stdin ?? new Writable({ write(_chunk, _encoding, callback) { callback() } }),
    stdout: child.stdout ?? new Readable({ read() {} }),
    stderr: child.stderr ?? new Readable({ read() {} }),
    pid: child.pid,
    exited,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      child.kill(signal)
    },
  }
}

export function spawnSupervisorProcess(options: SupervisorSpawnOptions): SupervisorProcess {
  return spawnChildProcess(options.argv, options.cwd, options.env)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const METHOD_NOT_FOUND = -32601

export function pluginErrorText(error: unknown): string {
  return errorMessage(error).replace(/^Request [\w.]+ failed with message: /, '')
}

export function pluginDataDir(installed: InstalledPlugin): string {
  return join(configDir(), 'plugin-data', installed.id, 'files')
}

function serverBundlePath(installed: InstalledPlugin): string {
  return join(pluginFolder(installed.id), '.mc-build', 'server.js')
}

async function realPathOf(path: string): Promise<string> {
  return realpath(path)
}

type FilesystemReadRules = { denyRead: string[]; allowRead: string[] }

const SHARED_TEMP_PATHS = ['/tmp/claude', '/private/tmp/claude']

function sandboxRuntimeSeccompDir(): string {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'))))
  return join(packageRoot, 'vendor', 'seccomp')
}

// bun 1.2.17 wipes the child's env when its startup walk-up from the data-folder cwd hits an unreadable ancestor, so plugin-data and the plugin's own folder stay readable while the plugin-data/* glob re-seals every sibling; /tmp/claude is sandbox-runtime's always-writable shared temp and gets both denies.
async function seatbeltReadRules(dataDir: string, sharedReads: string[]): Promise<FilesystemReadRules> {
  const pluginDataRoot = await realPathOf(join(configDir(), 'plugin-data'))
  return {
    denyRead: [await realPathOf(homedir()), await realPathOf(configDir()), `${pluginDataRoot}/*`, ...SHARED_TEMP_PATHS],
    allowRead: [...sharedReads, await realPathOf(dirname(dataDir)), pluginDataRoot],
  }
}

// bwrap denies a directory by mounting a tmpfs over it and re-binds each allowRead path on top, so an allowRead ancestor of the writable data folder would re-mount it read-only.
async function bubblewrapReadRules(sharedReads: string[]): Promise<FilesystemReadRules> {
  return {
    denyRead: [await realPathOf(homedir()), await realPathOf(configDir()), ...SHARED_TEMP_PATHS],
    allowRead: [...sharedReads, await realPathOf(sandboxRuntimeSeccompDir())],
  }
}

export async function sandboxConfigFor(installed: InstalledPlugin, platform: NodeJS.Platform = process.platform): Promise<SandboxRuntimeConfig> {
  const dataDir = pluginDataDir(installed)
  const bunInstallDir = join(homedir(), '.bun')
  const sharedReads = [
    await realPathOf(join(pluginFolder(installed.id), '.mc-build')),
    await realPathOf(dataDir),
    dirname(await realPathOf(process.execPath)),
    ...(existsSync(bunInstallDir) ? [await realPathOf(bunInstallDir)] : []),
  ]
  const readRules = platform === 'linux' ? await bubblewrapReadRules(sharedReads) : await seatbeltReadRules(dataDir, sharedReads)
  return {
    network: { allowedDomains: installed.permissions.network ?? [], deniedDomains: [] },
    filesystem: {
      ...readRules,
      allowWrite: [await realPathOf(dataDir)],
      denyWrite: [...SHARED_TEMP_PATHS],
    },
  }
}

type Generation = {
  proc: SupervisorProcess
  connection: MessageConnection
  stopping: boolean
  dead: boolean
  gone: Promise<never>
  rejectGone: (error: Error) => void
}

function settledWithin(exited: Promise<number | null>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  timer?.unref()
  return Promise.race([exited.then(() => true), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export function createIsolatedRuntime(installed: InstalledPlugin, deps: IsolatedRuntimeDeps = {}): IsolatedRuntime {
  const rpcTimeoutMs = deps.rpcTimeoutMs ?? 30000
  const idleStopMs = deps.idleStopMs ?? IDLE_STOP_MS
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS
  const crashWindowMs = deps.crashWindowMs ?? CRASH_WINDOW_MS
  const bunVersion = deps.bunVersion ?? Bun.version
  const spawner = deps.spawnSupervisor ?? spawnSupervisorProcess

  let generation: Generation | undefined
  let starting: Promise<Generation> | undefined
  let stopped = false
  let disposed = false
  let inFlight = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const crashTimes: number[] = []
  const stderrTail: string[] = []

  function stoppedMessage(): string {
    return stderrTail.length === 0 ? 'The plugin stopped' : `The plugin stopped: ${stderrTail.join('\n')}`
  }

  function recordStderr(chunk: Buffer | string): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line !== '') stderrTail.push(line.trimEnd())
    }
    while (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
  }

  function recordCrash(): void {
    const now = Date.now()
    crashTimes.push(now)
    while (crashTimes.length > 0 && now - (crashTimes[0] as number) > crashWindowMs) crashTimes.shift()
    if (crashTimes.length >= CRASH_LIMIT) stopped = true
  }

  function onGenerationExit(gen: Generation): void {
    gen.dead = true
    if (generation === gen) generation = undefined
    try {
      gen.connection.dispose()
    } catch {
      // the connection may already be gone with the process
    }
    gen.rejectGone(new Error(stoppedMessage()))
    if (!gen.stopping) recordCrash()
  }

  function wireConnection(gen: Generation): MessageConnection {
    const connection = createMessageConnection(
      new StreamMessageReader(gen.proc.stdout),
      new StreamMessageWriter(gen.proc.stdin),
    )
    connection.onRequest('settings.get', async params => {
      if (installed.permissions.settings !== true) throw new Error('This plugin did not ask to keep settings')
      const key = typeof params === 'object' && params !== null && typeof (params as { key?: unknown }).key === 'string'
        ? (params as { key: string }).key
        : ''
      return getSetting(installed.id, key)
    })
    connection.onRequest('settings.set', async params => {
      if (installed.permissions.settings !== true) throw new Error('This plugin did not ask to keep settings')
      const record = typeof params === 'object' && params !== null ? (params as { key?: unknown; value?: unknown }) : {}
      if (typeof record.key !== 'string' || record.key === '') throw new Error('settings.set requires a key')
      if (record.value !== null && typeof record.value !== 'string') throw new Error('settings.set requires a string value or null')
      await setServerSetting(installed.id, record.key, record.value)
      return null
    })
    connection.onNotification('log', params => {
      const message = typeof params === 'object' && params !== null && 'message' in params
        ? String((params as { message: unknown }).message)
        : String(params)
      console.log(`[plugin ${installed.id}]`, message)
    })
    connection.listen()
    return connection
  }

  async function startGeneration(): Promise<Generation> {
    const dataDir = pluginDataDir(installed)
    const tmpDir = join(dataDir, 'tmp')
    await mkdir(tmpDir, { recursive: true, mode: DIR_MODE })
    const config = await sandboxConfigFor(installed)
    const serverBundle = serverBundlePath(installed)
    const command = `${shellQuote(process.execPath)} ${shellQuote(serverBundle)}`
    const env: Record<string, string> = {}
    if (typeof process.env.PATH === 'string' && process.env.PATH !== '') env.PATH = process.env.PATH
    Object.assign(env, {
      MC_PLUGIN_SANDBOX_CONFIG: JSON.stringify(config),
      MC_PLUGIN_COMMAND: command,
      MC_PLUGIN_CWD: dataDir,
      MC_PLUGIN_ID: installed.id,
      MC_PLUGIN_DATA: dataDir,
      MC_PLUGIN_KILL_GRACE_MS: String(killGraceMs),
      CLAUDE_CODE_TMPDIR: tmpDir,
      BUN_TMPDIR: tmpDir,
    })
    const proc = spawner({
      argv: [process.execPath, join(import.meta.dir, 'isolated-supervisor.ts')],
      cwd: dataDir,
      env,
      plugin: {
        serverBundle,
        dataDir,
        env: { MC_PLUGIN_RUNTIME: 'isolated', MC_PLUGIN_ID: installed.id, MC_PLUGIN_DATA: dataDir },
      },
    })
    const gen: Generation = {
      proc,
      connection: undefined as unknown as MessageConnection,
      stopping: false,
      dead: false,
      gone: undefined as unknown as Promise<never>,
      rejectGone: () => {},
    }
    gen.gone = new Promise<never>((_resolve, reject) => {
      gen.rejectGone = reject
    })
    // a spontaneous exit with no call waiting must not surface as an unhandled rejection
    gen.gone.catch(() => {})
    gen.connection = wireConnection(gen)
    proc.stderr.on('data', recordStderr)
    void proc.exited.then(() => onGenerationExit(gen))
    return gen
  }

  function ensureGeneration(): Promise<Generation> {
    if (generation !== undefined) return Promise.resolve(generation)
    if (starting === undefined) {
      starting = startGeneration().then(
        gen => {
          starting = undefined
          if (!gen.dead) generation = gen
          return gen
        },
        error => {
          starting = undefined
          throw error
        },
      )
    }
    return starting
  }

  function touchIdle(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    if (inFlight > 0 || stopped) return
    const timer = setTimeout(() => {
      idleTimer = undefined
      void idleStop()
    }, idleStopMs)
    timer.unref()
    idleTimer = timer
  }

  async function shutdownGeneration(gen: Generation): Promise<void> {
    gen.stopping = true
    if (!gen.dead) {
      try {
        gen.connection.sendNotification('plugin.shutdown')
      } catch {
        // the plugin may already be gone
      }
      if (!await settledWithin(gen.proc.exited, killGraceMs)) {
        gen.proc.kill('SIGTERM')
        // the supervisor SIGTERMs the child, waits its own grace, then SIGKILLs it — give it both windows before orphaning it under a host SIGKILL
        if (!await settledWithin(gen.proc.exited, killGraceMs * 2)) gen.proc.kill('SIGKILL')
      }
    }
  }

  async function idleStop(): Promise<void> {
    const gen = generation
    if (gen === undefined) return
    await shutdownGeneration(gen)
  }

  async function raceCall(gen: Generation, method: string, params: unknown): Promise<CallOutcome> {
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('deadline'))
      }, rpcTimeoutMs)
    })
    try {
      const result = await Promise.race([
        gen.connection.sendRequest('plugin.call', { method, params }),
        gen.gone,
        deadline,
      ])
      return { ok: true, result }
    } catch (error) {
      if (timedOut) return { ok: false, status: 504, error: 'The plugin did not answer' }
      if (gen.dead) return { ok: false, status: 500, error: stoppedMessage() }
      return { ok: false, status: (error as { code?: unknown }).code === METHOD_NOT_FOUND ? 404 : 500, error: pluginErrorText(error) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function call(method: string, params: unknown): Promise<CallOutcome> {
    if (stopped) return { ok: false, status: 409, error: 'Stopped after repeated crashes' }
    if (disposed) return { ok: false, status: 500, error: 'This plugin runtime was disposed' }
    if (needsBunUpgrade(installed, bunVersion)) return { ok: false, status: 503, error: UPGRADE_BUN_MESSAGE }
    if (installed.server === undefined) return { ok: false, status: 500, error: 'The plugin has no server part' }
    let gen: Generation
    try {
      gen = await ensureGeneration()
    } catch (error) {
      return { ok: false, status: 500, error: errorMessage(error) }
    }
    inFlight += 1
    touchIdle()
    try {
      return await raceCall(gen, method, params)
    } finally {
      inFlight -= 1
      touchIdle()
    }
  }

  async function dispose(): Promise<void> {
    disposed = true
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    if (starting !== undefined) {
      try {
        await starting
      } catch {
        // the spawn failed; there is no process to stop
      }
    }
    const gen = generation
    if (gen !== undefined) await shutdownGeneration(gen)
  }

  return { call, dispose, isStopped: () => stopped }
}
