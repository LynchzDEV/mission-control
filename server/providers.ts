import type { AgentConnection } from './agent-connections'
import { ENGINE_NAMES, type EngineName } from './engines'
import type { ModelLists } from './models'

export type Provider = { id: string; name: string; builtin: boolean; models: string[]; resumable: boolean; family: string | null }

const BUILTIN_NAMES: Record<EngineName, string> = { claude: 'Claude', glm: 'GLM', codex: 'Codex' }

function connectionResumable(connection: AgentConnection): boolean {
  if (connection.adapter === 'cli') return connection.args.some(arg => arg.includes('{{session}}'))
  return true
}

export async function listProviders(deps: { models: () => Promise<ModelLists>; connections: () => Promise<AgentConnection[]> }): Promise<Provider[]> {
  const [models, connections] = await Promise.all([deps.models(), deps.connections()])
  const builtins = ENGINE_NAMES.map(id => ({ id, name: BUILTIN_NAMES[id], builtin: true, models: models[id] ?? [], resumable: true, family: id }))
  const custom = connections
    .map(connection => ({ id: connection.id, name: connection.name, builtin: false, models: connection.models, resumable: connectionResumable(connection), family: connection.family ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...builtins, ...custom]
}
