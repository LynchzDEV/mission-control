import { describe, expect, test } from 'bun:test'

import type { AgentConnection } from '../server/agent-connections'
import { listProviders } from '../server/providers'

const acp: AgentConnection = { id: 'qwen', name: 'Qwen Code', adapter: 'acp', command: 'qwen', args: ['--acp'], env: {}, models: ['qwen3-coder'], autoApprove: false, output: 'text', provider: 'custom', family: 'qwen' }
const cli: AgentConnection = { ...acp, id: 'mycli', name: 'My CLI', adapter: 'cli', args: ['-p', '{{prompt}}'], models: [], family: undefined }
const resumableCli: AgentConnection = { ...cli, id: 'rcli', name: 'Resumable CLI', args: ['-p', '{{prompt}}', '--resume', '{{session}}'] }

describe('listProviders', () => {
  test('built-ins come first with their live model lists and are resumable', async () => {
    const providers = await listProviders({ models: async () => ({ claude: ['opus', 'sonnet'], glm: ['glm-5.3'], codex: ['gpt-5.5'] }), connections: async () => [] })
    expect(providers.map(p => p.id)).toEqual(['claude', 'glm', 'codex'])
    expect(providers[0]).toEqual({ id: 'claude', name: 'Claude', builtin: true, models: ['opus', 'sonnet'], resumable: true, family: 'claude' })
  })

  test('custom connections follow, sorted by name, with resumable derived from the connection', async () => {
    const providers = await listProviders({ models: async () => ({ claude: [], glm: [], codex: [] }), connections: async () => [cli, acp, resumableCli] })
    expect(providers.slice(3).map(p => [p.id, p.resumable, p.family])).toEqual([['mycli', false, null], ['qwen', true, 'qwen'], ['rcli', true, null]])
  })

  test('a built-in missing from the model lists reports no models', async () => {
    const providers = await listProviders({ models: async () => ({}), connections: async () => [] })
    expect(providers.map(p => p.models)).toEqual([[], [], []])
  })
})
