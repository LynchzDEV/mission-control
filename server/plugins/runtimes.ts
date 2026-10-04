import { errorMessage } from './errors'
import { createIsolatedRuntime, needsBunUpgrade, UPGRADE_BUN_MESSAGE, type IsolatedRuntimeDeps } from './runtime-isolated'
import { createTrustedRuntime, type TrustedRuntime, type TrustedRuntimeDeps } from './runtime-trusted'
import { clearRestartFlags, type InstalledPlugin } from './store'

export type RuntimeHandle = TrustedRuntime & { isStopped?: () => boolean }

export type RuntimeResult = { ok: true; runtime: RuntimeHandle } | { ok: false; status: number; error: string }

export type PluginState = 'ok' | 'needs-bun-upgrade' | 'stopped'

export type RuntimeDeps = TrustedRuntimeDeps & IsolatedRuntimeDeps

export type Runtimes = {
  getRuntime(installed: InstalledPlugin): Promise<RuntimeResult>
  stateOf(installed: InstalledPlugin): PluginState
}

type CacheEntry = { commit: string; runtime: RuntimeHandle }

const caches = new Set<Map<string, CacheEntry>>()

async function dropRuntime(cache: Map<string, CacheEntry>, id: string): Promise<void> {
  const entry = cache.get(id)
  if (entry === undefined) return
  cache.delete(id)
  await entry.runtime.dispose()
}

async function runtimeFor(cache: Map<string, CacheEntry>, deps: RuntimeDeps, installed: InstalledPlugin): Promise<RuntimeResult> {
  if (needsBunUpgrade(installed, deps.bunVersion ?? Bun.version)) {
    return { ok: false, status: 503, error: UPGRADE_BUN_MESSAGE }
  }
  const cached = cache.get(installed.id)
  if (cached !== undefined && cached.commit === installed.commit) return { ok: true, runtime: cached.runtime }
  if (cached !== undefined) await dropRuntime(cache, installed.id)
  try {
    const runtime: RuntimeHandle = installed.runtime === 'isolated'
      ? createIsolatedRuntime(installed, deps)
      : await createTrustedRuntime(installed, undefined, deps)
    cache.set(installed.id, { commit: installed.commit, runtime })
    return { ok: true, runtime }
  } catch (error) {
    return { ok: false, status: 500, error: errorMessage(error) }
  }
}

function stateOf(cache: Map<string, CacheEntry>, deps: RuntimeDeps): Runtimes['stateOf'] {
  return installed => {
    const cached = cache.get(installed.id)
    if (cached !== undefined && cached.commit === installed.commit && cached.runtime.isStopped?.()) return 'stopped'
    if (needsBunUpgrade(installed, deps.bunVersion ?? Bun.version)) return 'needs-bun-upgrade'
    return 'ok'
  }
}

export async function createRuntimes(deps: RuntimeDeps = {}): Promise<Runtimes> {
  await clearRestartFlags()
  const cache = new Map<string, CacheEntry>()
  caches.add(cache)
  return { getRuntime: installed => runtimeFor(cache, deps, installed), stateOf: stateOf(cache, deps) }
}

export async function invalidateRuntime(id: string): Promise<void> {
  await Promise.all([...caches].map(cache => dropRuntime(cache, id)))
}

let shared: Promise<Runtimes> | undefined

export function defaultRuntimes(): Promise<Runtimes> {
  shared ??= createRuntimes()
  return shared
}
