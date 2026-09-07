import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { GLM_MODEL, type EngineName } from './engines'
import { zaiOrigin, type FetchLike } from './quota'
import { readSecrets, type Secrets } from './secrets'

export type ModelLists = Record<EngineName, string[]>

export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']

const CODEX_FALLBACK = [
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
]
const GLM_FALLBACK = [GLM_MODEL, 'glm-5.3-flash']
const GLM_TIMEOUT_MS = 5_000

export type ModelDeps = { codexCachePath?: string; fetchImpl?: FetchLike; secrets?: () => Promise<Secrets> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// The Codex CLI refreshes ~/.codex/models_cache.json itself; we only read it.
export async function codexModels(cachePath?: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(cachePath ?? join(homedir(), '.codex', 'models_cache.json'), 'utf8'),
    )
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) return CODEX_FALLBACK
    const entries: Array<{ slug: string; priority: number }> = []
    for (const item of parsed.models) {
      if (!isRecord(item) || item.visibility !== 'list' || typeof item.slug !== 'string') continue
      entries.push({ slug: item.slug, priority: typeof item.priority === 'number' ? item.priority : 0 })
    }
    return entries.sort((a, b) => a.priority - b.priority).map((entry) => entry.slug)
  } catch {
    return CODEX_FALLBACK
  }
}

export async function glmModels(secrets: Secrets, fetchImpl: FetchLike = fetch): Promise<string[]> {
  if (secrets.zaiAuthToken === null || secrets.zaiAuthToken === '') return GLM_FALLBACK
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GLM_TIMEOUT_MS)
    let json: unknown
    try {
      const response = await fetchImpl(`${zaiOrigin(secrets.zaiBaseUrl)}/api/anthropic/v1/models`, {
        headers: { Authorization: secrets.zaiAuthToken, 'Accept-Language': 'en-US,en' },
        signal: controller.signal,
      })
      if (!response.ok) return GLM_FALLBACK
      json = await response.json()
    } finally {
      clearTimeout(timer)
    }
    if (!isRecord(json) || !Array.isArray(json.data)) return GLM_FALLBACK
    const ids = json.data
      .map((entry) => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : null))
      .filter((id): id is string => id !== null)
      .reverse()
    const result: string[] = []
    for (const id of [GLM_MODEL, ...ids]) {
      if (!result.includes(id)) result.push(id)
    }
    return result
  } catch {
    return GLM_FALLBACK
  }
}

export async function listModels(deps: ModelDeps = {}): Promise<ModelLists> {
  const [glm, codex] = await Promise.all([
    (deps.secrets ?? readSecrets)().then((secrets) => glmModels(secrets, deps.fetchImpl)),
    codexModels(deps.codexCachePath),
  ])
  return { claude: [...CLAUDE_MODEL_ALIASES], glm, codex }
}
