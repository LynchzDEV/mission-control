import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicJson, identifier } from './workflows'
import { configDir } from './secrets'

export const BUILTIN_AGENTS = ['claude', 'glm', 'codex'] as const
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const targetEnvName = envName.refine(name => !['MC_JOB_ID', 'MC_TERMINAL_ID', 'MISSION_CONTROL_CONFIG_DIR'].includes(name), 'Mission Control identity cannot be overridden')
export const connectionSchema = z.object({
  id: identifier, name: z.string().trim().min(1).max(100),
  adapter: z.enum(['acp', 'opencode', 'cli']), command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(16000)).max(100).default([]),
  env: z.record(targetEnvName, envName).default({}),
  models: z.array(z.string().min(1).max(200)).max(500).default([]),
  family: identifier.optional(),
  autoApprove: z.boolean().default(false),
  authMethod: z.string().max(200).optional(),
  output: z.enum(['text', 'claude', 'codex']).default('text'),
  terminalArgs: z.array(z.string().max(4096)).max(100).optional(),
  baseUrl: z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }, 'HTTP or HTTPS URL without embedded credentials required').optional(),
  apiKeyEnv: envName.optional(),
  provider: identifier.default('custom'),
}).superRefine((value, ctx) => {
  if (BUILTIN_AGENTS.includes(value.id as typeof BUILTIN_AGENTS[number])) ctx.addIssue({ code: 'custom', message: 'Cannot replace a built-in connection' })
  if (value.adapter === 'cli' && !value.args.some(arg => arg.includes('{{prompt}}'))) ctx.addIssue({ code: 'custom', message: 'CLI arguments need a {{prompt}} slot' })
  if (value.adapter !== 'opencode' && (value.baseUrl || value.apiKeyEnv)) ctx.addIssue({ code: 'custom', message: 'Custom API settings require the OpenCode adapter' })
  if (value.adapter === 'opencode' && value.baseUrl && value.models.length === 0) ctx.addIssue({ code: 'custom', message: 'A custom endpoint needs at least one model ID' })
})
export type AgentConnection = z.infer<typeof connectionSchema>

export const CONNECTION_PRESETS = [
  { id: 'grok', name: 'Grok Build', adapter: 'acp', command: 'grok', args: ['agent', 'stdio'], family: 'grok', terminalArgs: [] },
  { id: 'qwen', name: 'Qwen Code', adapter: 'acp', command: 'qwen', args: ['--acp'], family: 'qwen', terminalArgs: [] },
  { id: 'opencode', name: 'OpenCode · API or local', adapter: 'opencode', command: 'opencode', args: ['acp'], terminalArgs: [] },
  { id: 'custom-agent', name: 'Custom ACP agent', adapter: 'acp', command: '', args: [] },
  { id: 'custom-cli', name: 'Custom headless CLI', adapter: 'cli', command: '', args: ['-p', '{{prompt}}'] },
] as const

export function modelFamily(model?: string | null): string | null {
  const normalized = model?.toLowerCase() ?? ''
  for (const [pattern, family] of [[/(claude|anthropic)/, 'claude'], [/(^|[/_-])(gpt|o[134])([/_.-]|\d)/, 'gpt'], [/glm/, 'glm'], [/grok/, 'grok'], [/qwen/, 'qwen'], [/gemini/, 'gemini'], [/kimi/, 'kimi'], [/deepseek/, 'deepseek'], [/minimax/, 'minimax'], [/llama/, 'llama']] as const) {
    if (pattern.test(normalized)) return family
  }
  return null
}

export function connectionEnvironment(connection: AgentConnection, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, reference] of Object.entries(connection.env)) {
    const value = source[reference]
    if (!value) throw new Error(`Missing environment variable: ${reference}`)
    result[key] = value
  }
  if (connection.adapter === 'opencode' && connection.baseUrl) {
    const apiKey = connection.apiKeyEnv ? source[connection.apiKeyEnv] : undefined
    if (connection.apiKeyEnv && !apiKey) throw new Error(`Missing environment variable: ${connection.apiKeyEnv}`)
    result.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { [connection.provider]: {
      npm: '@ai-sdk/openai-compatible', name: connection.name,
      options: { baseURL: connection.baseUrl, ...(apiKey ? { apiKey } : {}) },
      models: Object.fromEntries(connection.models.map(id => [id, { name: id }])),
    } } })
  }
  return result
}

export function connectionCommand(connection: AgentConnection, prompt: string, model?: string, session?: string): { command: string; args: string[] } {
  if (connection.adapter !== 'cli') return { command: connection.command, args: connection.args }
  if (model && !connection.args.some(arg => arg.includes('{{model}}'))) throw new Error('This CLI connection has no {{model}} argument')
  if (session && !connection.args.some(arg => arg.includes('{{session}}'))) throw new Error('This CLI connection does not support resume')
  const slots: Record<string, string> = { prompt, model: model ?? '', session: session ?? '' }
  return { command: connection.command, args: connection.args.map(arg => arg.replace(/\{\{(prompt|model|session)\}\}/g, (_, key: string) => slots[key]!)) }
}

export function createConnectionStore(base = configDir()) {
  const root = join(base, 'connections')
  async function get(id: string): Promise<AgentConnection> {
    return connectionSchema.parse(JSON.parse(await readFile(join(root, `${identifier.parse(id)}.json`), 'utf8')))
  }
  async function list(): Promise<AgentConnection[]> {
    const files = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    return Promise.all(files.filter(file => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(file)).map(file => get(file.slice(0, -5))))
  }
  async function save(input: unknown): Promise<AgentConnection> {
    const connection = connectionSchema.parse(input)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await atomicJson(join(root, `${connection.id}.json`), connection)
    return connection
  }
  async function remove(id: string): Promise<void> {
    if (BUILTIN_AGENTS.includes(id as typeof BUILTIN_AGENTS[number])) throw new Error('Cannot remove a built-in connection')
    await rm(join(root, `${identifier.parse(id)}.json`), { force: true })
  }
  return { get, list, save, remove }
}
