import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

// The server may be launched without the user's shell PATH (launchd, cron); mise/homebrew
// installed CLIs then vanish. Resolve to an absolute path via known install dirs.
const BIN_FALLBACK_DIRS = [
  join(process.env.HOME ?? '', '.local/share/mise/shims'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(process.env.HOME ?? '', '.bun/bin'),
  join(process.env.HOME ?? '', '.local/bin'),
]

const binaryCache = new Map<string, string>()

export function resolveBinary(cmd: string): string {
  if (cmd.includes('/')) return cmd
  const cached = binaryCache.get(cmd)
  if (cached !== undefined) return cached
  const found =
    Bun.which(cmd) ?? BIN_FALLBACK_DIRS.map((dir) => join(dir, cmd)).find((path) => existsSync(path)) ?? cmd
  binaryCache.set(cmd, found)
  return found
}

export function pathWithFallbackDirs(current: string | undefined): string {
  const parts = (current ?? '').split(':').filter((entry) => entry !== '')
  for (const dir of BIN_FALLBACK_DIRS) {
    if (!parts.includes(dir) && existsSync(dir)) parts.push(dir)
  }
  return parts.join(':')
}

// A cockpit started from inside a Claude session must not hand that session's identity to the engines it spawns.
export const PARENT_CLAUDE_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
] as const

function processEnvRecord(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(PARENT_CLAUDE_SESSION_VARS as readonly string[]).includes(key)) result[key] = value
  }
  return { ...result, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' }
}

export async function buildEnv(engine: EngineName): Promise<Record<string, string>> {
  const secrets = await readSecrets()
  const overlay = resolveEngine(engine).envFor(secrets)
  const env = { ...processEnvRecord(), ...overlay }
  env.PATH = pathWithFallbackDirs(env.PATH)
  return env
}
