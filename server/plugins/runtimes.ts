import { errorMessage } from './errors'
import { createTrustedRuntime, type TrustedRuntime, type TrustedRuntimeDeps } from './runtime-trusted'
import { clearRestartFlags, type InstalledPlugin } from './store'

export type RuntimeHandle = TrustedRuntime

export type RuntimeResult = { ok: true; runtime: RuntimeHandle } | { ok: false; status: number; error: string }

export type Runtimes = { getRuntime(installed: InstalledPlugin): Promise<RuntimeResult> }

type CacheEntry = { commit: string; runtime: RuntimeHandle }

const caches = new Set<Map<string, CacheEntry>>()

async function dropRuntime(cache: Map<string, CacheEntry>, id: string): Promise<void> {
  const entry = cache.get(id)
  if (entry === undefined) return
  cache.delete(id)
  await entry.runtime.dispose()
}

async function runtimeFor(cache: Map<string, CacheEntry>, deps: TrustedRuntimeDeps, installed: InstalledPlugin): Promise<RuntimeResult> {
  if (installed.runtime === 'isolated') return { ok: false, status: 501, error: 'Isolated runtime not available yet' }
  const cached = cache.get(installed.id)
  if (cached !== undefined && cached.commit === installed.commit) return { ok: true, runtime: cached.runtime }
  if (cached !== undefined) await dropRuntime(cache, installed.id)
  try {
    const runtime = await createTrustedRuntime(installed, undefined, deps)
    cache.set(installed.id, { commit: installed.commit, runtime })
    return { ok: true, runtime }
  } catch (error) {
    return { ok: false, status: 500, error: errorMessage(error) }
  }
}

export async function createRuntimes(deps: TrustedRuntimeDeps = {}): Promise<Runtimes> {
  await clearRestartFlags()
  const cache = new Map<string, CacheEntry>()
  caches.add(cache)
  return { getRuntime: installed => runtimeFor(cache, deps, installed) }
}

export async function invalidateRuntime(id: string): Promise<void> {
  await Promise.all([...caches].map(cache => dropRuntime(cache, id)))
}

let shared: Promise<Runtimes> | undefined

export function defaultRuntimes(): Promise<Runtimes> {
  shared ??= createRuntimes()
  return shared
}
