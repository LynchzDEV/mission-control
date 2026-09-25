export type LaunchProvider = { id: string; name: string; models: string[] }
export type LaunchChoice = { engine: string; model: string }

export function launchChoice(providers: LaunchProvider[], lastEngine: string | null, lastModel: string | null): LaunchChoice {
  const remembered = providers.find(provider => provider.id === lastEngine)
  const engine = remembered?.id ?? providers[0]?.id ?? ''
  return { engine, model: remembered ? lastModel ?? '' : '' }
}

export function customModelChoice(providers: LaunchProvider[], lastEngine: string | null, custom: string): LaunchChoice | null {
  const model = custom.trim()
  const engine = launchChoice(providers, lastEngine, null).engine
  return model && engine ? { engine, model } : null
}

export function readRecentDirectories(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item !== '') : []
  } catch { return [] }
}

export function restoreRequested(location: { hash: string; search: string }): boolean {
  return location.hash === '#terminal' || new URLSearchParams(location.search).has('terminal')
}
