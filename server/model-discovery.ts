import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentConnection } from './agent-connections'
import { configDir } from './secrets'
import { atomicJson, identifier } from './workflows'

export type DiscoveryState = { models: string[]; current: string | null; checkedAt: number; error: string | null }
export type BridgeEvent = Record<string, unknown>
export type BridgeRunner = (input: unknown, timeoutMs: number) => Promise<BridgeEvent[]>
type DiscoveryDeps = {
  base?: string
  fetchImpl?: typeof fetch
  now?: () => number
  bridge?: BridgeRunner
  env?: Record<string, string | undefined>
  background?: boolean
  onUpdate?: () => void
}

export const FRESH_MS = 24 * 60 * 60_000
export const RETRY_AFTER_FAILURE_MS = 15 * 60_000
export const DISCOVERY_TIMEOUT_MS = 45_000
export const ENDPOINT_TIMEOUT_MS = 10_000

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const unique = (values: string[]) => [...new Set(values)]

function selectValues(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  return options.flatMap(option => {
    if (!isRecord(option)) return []
    if (Array.isArray(option.options)) return selectValues(option.options)
    return typeof option.value === 'string' ? [option.value] : []
  })
}

export function modelsFromSession(response: unknown): { models: string[]; current: string | null } {
  if (!isRecord(response)) return { models: [], current: null }
  const configOptions = Array.isArray(response.configOptions) ? response.configOptions.filter(isRecord) : []
  const option = configOptions.find(item => item.type === 'select' && (item.category === 'model' || item.id === 'model'))
  const fromOption = option ? unique(selectValues(option.options)) : []
  if (fromOption.length) return { models: fromOption, current: typeof option?.currentValue === 'string' ? option.currentValue : null }
  const legacy = isRecord(response.models) ? response.models : null
  const available = legacy && Array.isArray(legacy.availableModels) ? legacy.availableModels : []
  const models = unique(available.flatMap(model => isRecord(model) && typeof model.modelId === 'string' ? [model.modelId] : []))
  if (!models.length) return { models: [], current: null }
  return { models, current: typeof legacy?.currentModelId === 'string' ? legacy.currentModelId : null }
}

export async function endpointModels(baseUrl: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const scrub = (text: string) => apiKey ? text.split(apiKey).join('[REDACTED]') : text
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(scrub(error instanceof Error ? error.message : 'Network request failed'))
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => null)
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('The endpoint did not return a model list')
  return unique(body.data.flatMap(entry => isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : []))
}

export async function spawnBridge(input: unknown, timeoutMs: number): Promise<BridgeEvent[]> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'agent-bridge.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs)
  try {
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
    const [log, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const events = log.split('\n').filter(Boolean).map(line => JSON.parse(line) as BridgeEvent)
    if (code !== 0) {
      const last = events.at(-1)?.result
      throw new Error(typeof last === 'string' && last ? last : 'Agent bridge failed')
    }
    return events
  } finally { clearTimeout(timer) }
}

export function mergeModels(discovered: string[], manual: string[]): string[] {
  return unique([...discovered, ...manual])
}

export function createModelDiscovery({ base = configDir(), fetchImpl = fetch, now = Date.now, bridge = spawnBridge, env = process.env, background = true, onUpdate }: DiscoveryDeps = {}) {
  const root = join(base, 'connection-models')
  const pathFor = (id: string) => join(root, `${identifier.parse(id)}.json`)
  const running = new Map<string, Promise<DiscoveryState | null>>()

  async function read(id: string): Promise<DiscoveryState | null> {
    try { return JSON.parse(await readFile(pathFor(id), 'utf8')) as DiscoveryState }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  async function write(id: string, state: DiscoveryState): Promise<DiscoveryState> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await atomicJson(pathFor(id), state)
    onUpdate?.()
    return state
  }

  async function endpoint(connection: AgentConnection): Promise<string[]> {
    if (!connection.baseUrl) throw new Error('This connection has no endpoint')
    return endpointModels(connection.baseUrl, connection.apiKeyEnv ? env[connection.apiKeyEnv] : undefined, fetchImpl)
  }

  function record(id: string, models: string[], current: string | null = null): Promise<DiscoveryState> {
    return write(id, { models, current, checkedAt: now(), error: null })
  }

  async function ask(connection: AgentConnection): Promise<{ models: string[]; current: string | null }> {
    if (connection.adapter === 'opencode' && connection.baseUrl) return { models: await endpoint(connection), current: null }
    const events = await bridge({ connection, prompt: '', discoverModels: true }, DISCOVERY_TIMEOUT_MS)
    const reported = events.find(event => event.type === 'mc_models')
    if (!reported) throw new Error('The agent did not report its models')
    return { models: Array.isArray(reported.models) ? reported.models.filter((model): model is string => typeof model === 'string') : [], current: typeof reported.current === 'string' ? reported.current : null }
  }

  async function run(connection: AgentConnection): Promise<DiscoveryState> {
    const previous = await read(connection.id).catch(() => null)
    try {
      const found = await ask(connection)
      if (!found.models.length) throw new Error('The agent reported no models')
      return await record(connection.id, found.models, found.current)
    } catch (error) {
      return await write(connection.id, { models: previous?.models ?? [], current: previous?.current ?? null, checkedAt: now(), error: error instanceof Error ? error.message : 'Model discovery failed' })
    }
  }

  function refresh(connection: AgentConnection): Promise<DiscoveryState | null> {
    if (connection.adapter === 'cli') return Promise.resolve(null)
    const pending = running.get(connection.id)
    if (pending) return pending
    const started = run(connection).finally(() => running.delete(connection.id))
    running.set(connection.id, started)
    return started
  }

  function refreshLater(connection: AgentConnection): void {
    if (background) refresh(connection).catch(() => {})
  }

  async function ensureFresh(connection: AgentConnection): Promise<DiscoveryState | null> {
    if (connection.adapter === 'cli') return null
    const state = await read(connection.id).catch(() => null)
    const age = state ? now() - state.checkedAt : Infinity
    if (age >= (state?.error ? RETRY_AFTER_FAILURE_MS : FRESH_MS)) refreshLater(connection)
    return state
  }

  async function effective(connection: AgentConnection): Promise<AgentConnection> {
    const state = await read(connection.id).catch(() => null)
    return { ...connection, models: mergeModels(state?.models ?? [], connection.models) }
  }

  async function forget(id: string): Promise<void> {
    await rm(pathFor(id), { force: true })
    onUpdate?.()
  }

  return { read, refresh, refreshLater, ensureFresh, effective, forget, write, record, endpoint }
}
export type ModelDiscovery = ReturnType<typeof createModelDiscovery>

const updateListeners = new Set<() => void>()
const shared = new Map<string, ModelDiscovery>()

export function onDiscoveryUpdate(listener: () => void): void {
  updateListeners.add(listener)
}

export function modelDiscovery(base = configDir()): ModelDiscovery {
  const existing = shared.get(base)
  if (existing) return existing
  const created = createModelDiscovery({ base, background: process.env.MC_MODEL_DISCOVERY !== 'off', onUpdate: () => { for (const listener of updateListeners) listener() } })
  shared.set(base, created)
  return created
}
