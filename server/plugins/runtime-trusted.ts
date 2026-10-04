import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DIR_MODE, configDir } from '../secrets'
import { errorMessage } from './errors'
import { getSetting, setServerSetting } from './settings'
import { pluginFolder, type InstalledPlugin } from './store'

export const RPC_TIMEOUT_MS = 30000

export type ServerContext = {
  settings: {
    get(key: string): Promise<string | null>
    set(key: string, value: string | null): Promise<void>
  }
  data: string
  log(message: string): void
}

export type CallOutcome = { ok: true; result: unknown } | { ok: false; status: number; error: string }

export type TrustedRuntime = {
  call(method: string, params: unknown): Promise<CallOutcome>
  dispose(): Promise<void>
}

export type TrustedRuntimeDeps = { rpcTimeoutMs?: number }

export function createServerContext(installed: InstalledPlugin): ServerContext {
  return {
    settings: {
      get: key => getSetting(installed.id, key),
      set: (key, value) => setServerSetting(installed.id, key, value),
    },
    data: join(configDir(), 'plugin-data', installed.id, 'files'),
    log: message => console.log(`[plugin ${installed.id}]`, message),
  }
}

type PluginMethod = (params: unknown, ctx: ServerContext) => unknown

// Never cleared: a trusted module is loaded once per process; updates take effect only after a restart.
const retainedMethods = new Map<string, Record<string, PluginMethod>>()

async function methodsFor(installed: InstalledPlugin): Promise<Record<string, PluginMethod>> {
  const retained = retainedMethods.get(installed.id)
  if (retained !== undefined) return retained
  if (installed.server === undefined) throw new Error('The plugin has no server part')
  const mod = await import(pathToFileURL(join(pluginFolder(installed.id), installed.server)).href)
  const methods = (mod as { default?: { methods?: unknown } }).default?.methods
  if (typeof methods !== 'object' || methods === null) throw new Error('The plugin server part exports no methods')
  const handlers = methods as Record<string, PluginMethod>
  retainedMethods.set(installed.id, handlers)
  return handlers
}

type SettledCall = { kind: 'value'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'timeout' }

const TIMED_OUT: SettledCall = { kind: 'timeout' }

async function raceCall(invoke: () => unknown, timeoutMs: number): Promise<SettledCall> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<SettledCall>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })
  const outcome = await Promise.race([
    Promise.resolve()
      .then(invoke)
      .then(
        value => ({ kind: 'value', value }) as SettledCall,
        error => ({ kind: 'error', error }) as SettledCall,
      ),
    deadline,
  ])
  if (timer !== undefined) clearTimeout(timer)
  return outcome
}

export async function createTrustedRuntime(
  installed: InstalledPlugin,
  ctxFactory: (installed: InstalledPlugin) => ServerContext = createServerContext,
  deps: TrustedRuntimeDeps = {},
): Promise<TrustedRuntime> {
  const handlers = await methodsFor(installed)
  const timeoutMs = deps.rpcTimeoutMs ?? RPC_TIMEOUT_MS

  async function call(method: string, params: unknown): Promise<CallOutcome> {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (typeof handler !== 'function') return { ok: false, status: 404, error: `No method ${method}` }
    const ctx = ctxFactory(installed)
    await mkdir(ctx.data, { recursive: true, mode: DIR_MODE })
    const outcome = await raceCall(() => handler(params, ctx), timeoutMs)
    if (outcome.kind === 'timeout') return { ok: false, status: 504, error: 'The plugin did not answer' }
    if (outcome.kind === 'error') return { ok: false, status: 500, error: errorMessage(outcome.error) }
    return { ok: true, result: outcome.value }
  }

  return { call, dispose: async () => {} }
}
