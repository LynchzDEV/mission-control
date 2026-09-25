import { resolve, sep } from 'node:path'

export type ChatHomeStatus =
  | { ok: true; path: string; source: 'config' | 'derived' }
  | { ok: false; reason: 'home' | 'none'; candidates: string[] }

export function sharedRoot(paths: readonly string[]): string | null {
  const absolute = paths.filter(path => path.startsWith('/')).map(path => resolve(path).split(sep).filter(Boolean))
  if (absolute.length === 0) return null
  const shared: string[] = []
  for (let index = 0; index < absolute[0]!.length; index += 1) {
    const part = absolute[0]![index]
    if (!absolute.every(parts => parts[index] === part)) break
    shared.push(part!)
  }
  return `/${shared.join('/')}`
}

function underHome(path: string, home: string): boolean {
  const normalized = resolve(path)
  return normalized !== resolve(home) && normalized.startsWith(`${resolve(home)}/`)
}

export function chatHome(config: { chatHome: string | null }, known: readonly string[], home: string): ChatHomeStatus {
  if (config.chatHome !== null && underHome(config.chatHome, home)) return { ok: true, path: resolve(config.chatHome), source: 'config' }
  const candidates = [...new Set(known.filter(path => underHome(path, home)))]
  if (candidates.length === 0) return { ok: false, reason: 'none', candidates: [] }
  const derived = sharedRoot(candidates)
  if (derived === null || !underHome(derived, home)) return { ok: false, reason: 'home', candidates }
  return { ok: true, path: derived, source: 'derived' }
}
