import { readSecrets, type Secrets } from './secrets'

export type EngineName = 'claude' | 'glm' | 'codex'

export const ENGINE_NAMES: readonly EngineName[] = ['claude', 'glm', 'codex']

export type EngineDefinition = {
  cmd: string
  envFor(secrets: Secrets): Record<string, string>
}

export const GLM_MODEL = 'glm-5.3-flash[1m]'
const GLM_CONTEXT_TOKENS = '1000000'

function glmEnvFor(secrets: Secrets): Record<string, string> {
  if (secrets.zaiAuthToken === null || secrets.zaiAuthToken === '') {
    throw new Error('glm engine requested but zaiAuthToken is not configured')
  }
  return {
    ANTHROPIC_BASE_URL: secrets.zaiBaseUrl,
    ANTHROPIC_AUTH_TOKEN: secrets.zaiAuthToken,
    ANTHROPIC_DEFAULT_OPUS_MODEL: GLM_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: GLM_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: GLM_MODEL,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: GLM_CONTEXT_TOKENS,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: GLM_CONTEXT_TOKENS,
  }
}

export const ENGINES: Record<EngineName, EngineDefinition> = {
  claude: { cmd: 'claude', envFor: () => ({}) },
  glm: { cmd: 'claude', envFor: glmEnvFor },
  codex: { cmd: 'codex', envFor: () => ({}) },
}

// MC_FAKE_ENGINES=1 swaps real CLIs for /bin/echo stubs so tests/dev run without the real binaries.
export const FAKE_ENGINES: Record<EngineName, EngineDefinition> = {
  claude: { cmd: '/bin/echo', envFor: () => ({}) },
  glm: { cmd: '/bin/echo', envFor: glmEnvFor },
  codex: { cmd: '/bin/echo', envFor: () => ({}) },
}

export function fakeEnginesEnabled(): boolean {
  return process.env.MC_FAKE_ENGINES === '1'
}

export function resolveEngine(name: EngineName): EngineDefinition {
  return (fakeEnginesEnabled() ? FAKE_ENGINES : ENGINES)[name]
}

function processEnvRecord(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

export async function buildEnv(engine: EngineName): Promise<Record<string, string>> {
  const secrets = await readSecrets()
  const overlay = resolveEngine(engine).envFor(secrets)
  return { ...processEnvRecord(), ...overlay }
}
