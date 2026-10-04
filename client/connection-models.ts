import type { AgentConnection } from '../server/agent-connections'
import type { DiscoveryState } from '../server/model-discovery'
import { relativeTime } from './outcome-strip'

type Adapter = AgentConnection['adapter'] | undefined

export function discoveryLine(adapter: Adapter, state: DiscoveryState | null | undefined, now: number): { text: string; refresh: boolean } {
  if (adapter === 'cli') return { text: "This AI can't report its models. Add them in its settings.", refresh: false }
  if (!state) return { text: 'Looking for models…', refresh: true }
  if (state.error) return { text: `Couldn't list models: ${state.error}`, refresh: true }
  return { text: `Found automatically · checked ${relativeTime(state.checkedAt, now)}`, refresh: true }
}

export function modelsLabel(adapter: Adapter): string {
  return adapter === 'cli' ? 'Available model IDs · one per line' : 'Extra model IDs · one per line (optional)'
}
