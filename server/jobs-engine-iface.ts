export type EngineSpawn = {
  cmd: string
  args: string[]
  env: Record<string, string>
  stdin?: string
}

export type EngineResolverParams = {
  engine: string
  prompt: string
  resumeSessionId?: string
  model?: string
  connection?: import('./agent-connections').AgentConnection
  coreRules?: string
  readOnly?: boolean
  mcpServers?: import('./workflows').WorkflowNode['mcpServers']
  purpose?: 'workflow-design' | 'chat'
  edit?: boolean
}

export type EngineResolver = (params: EngineResolverParams) => EngineSpawn | Promise<EngineSpawn>


export const fakeEchoResolver: EngineResolver = ({ engine, prompt }) => ({
  cmd: 'echo',
  args: [`[fake:${engine}] ${prompt}`],
  env: {},
})

import { buildEnv, modelArgs, resolveBinary, resolveEngine, type EngineName, ENGINE_NAMES } from './engines'
import { createConnectionStore } from './agent-connections'
import { chatEnv, ensureChatProfile } from './chat-profile'
import { ensureWorkerProfiles } from './worker-profile'
import { join } from 'node:path'

export function engineArgs(engine: EngineName, prompt: string, resumeSessionId?: string, model?: string): string[] {
  if (engine === 'codex') {
    return resumeSessionId === undefined
      ? ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', ...modelArgs('codex', model), prompt]
      : ['exec', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--json', ...modelArgs('codex', model), resumeSessionId, prompt]
  }
  const resume = resumeSessionId === undefined ? [] : ['--resume', resumeSessionId]
  return [...resume, '-p', prompt, '--output-format', 'stream-json', '--verbose', ...modelArgs(engine, model)]
}

export function engineSupportsResume(engine: string): boolean {
  return ENGINE_NAMES.includes(engine as EngineName)
}

export const realEngineResolver: EngineResolver = async ({ engine, prompt, resumeSessionId, model, connection, coreRules, mcpServers, readOnly, purpose, edit }) => {
  if (!ENGINE_NAMES.includes(engine as EngineName)) {
    const selected = connection ?? await createConnectionStore().get(engine)
    if (selected.id !== engine) throw new Error('Connection does not match the selected engine')
    return { cmd: process.execPath, args: [join(import.meta.dir, 'agent-bridge.ts')], env: {}, stdin: JSON.stringify({ connection: selected, prompt, resumeSessionId, model, mcpServers, readOnly, purpose, edit }) }
  }
  if (mcpServers?.length) throw new Error('Attached MCP tools require an ACP connection; configure a native ACP adapter for this agent')
  const name = engine as EngineName
  const args = readOnly ? name === 'codex'
    ? ['exec', '--sandbox', 'read-only', '--ignore-user-config', '-c', 'approval_policy="never"', '--json', ...modelArgs(name, model), prompt]
    : ['-p', prompt, '--tools', '', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', ...modelArgs(name, model)]
    : engineArgs(name, prompt, resumeSessionId, model)
  if (coreRules) args.unshift(...(name === 'codex' ? ['-c', `developer_instructions=${JSON.stringify(coreRules)}`] : ['--append-system-prompt', coreRules]))
  if (purpose === 'chat' && edit === false && name !== 'codex') args.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit')
  const env = purpose === 'chat'
    ? { ...(await buildEnv(name, { worker: false })), ...chatEnv(name, { claude: (await ensureChatProfile()).claude, codex: (await ensureWorkerProfiles()).codex }) }
    : await buildEnv(name, { worker: !readOnly })
  return { cmd: resolveBinary(resolveEngine(name).cmd), args, env }
}
