export type LaunchProvider = { id: string; name: string; models: string[] }
export type LaunchChoice = { engine: string; model: string }

export function launchChoice(providers: LaunchProvider[], lastEngine: string | null, lastModel: string | null): LaunchChoice {
  const remembered = providers.find(provider => provider.id === lastEngine)
  const engine = remembered?.id ?? providers[0]?.id ?? ''
  return { engine, model: remembered ? lastModel ?? '' : '' }
}

export function restoreRequested(location: { hash: string; search: string }): boolean {
  return location.hash === '#terminal' || new URLSearchParams(location.search).has('terminal')
}
