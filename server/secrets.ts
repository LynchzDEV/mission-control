import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/anthropic'
export const DEFAULT_BIND = '127.0.0.1:7777'

export const SECRETS_FILE = 'secrets.json'
export const AUTH_FILE = 'auth.json'
export const CONFIG_FILE = 'config.json'

export const API_TOKEN_PREFIX = 'mct_'

export type Secrets = {
  zaiAuthToken: string | null
  zaiBaseUrl: string
  apiToken: string | null
}

export type AuthRecord = {
  passwordHash: string | null
  cookieSecret: string | null
}

export type EngineRoles = {
  plan: string
  execute: string
  review: string
}

export const DEFAULT_ROLES: EngineRoles = { plan: 'claude', execute: 'glm', review: 'codex' }

export type AppConfig = {
  bind: string
  roles: EngineRoles
}

export type PublicSecretsView = {
  zaiBaseUrl: string
  zaiAuthTokenConfigured: boolean
  apiTokenConfigured: boolean
}

export type BindTarget = {
  hostname: string
  port: number
}

export function configDir(): string {
  const override = process.env.MISSION_CONTROL_CONFIG_DIR
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.config', 'mission-control')
}

export function configPath(file: string): string {
  return join(configDir(), file)
}

export async function ensureConfigDir(): Promise<string> {
  const dir = configDir()
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)
  return dir
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath(file), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await ensureConfigDir()
  const path = configPath(file)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export async function readSecrets(): Promise<Secrets> {
  const raw = await readJsonFile(SECRETS_FILE)
  return {
    zaiAuthToken: asString(raw.zaiAuthToken),
    zaiBaseUrl: asString(raw.zaiBaseUrl) ?? DEFAULT_ZAI_BASE_URL,
    apiToken: asString(raw.apiToken),
  }
}

export async function writeSecrets(patch: Partial<Secrets>): Promise<Secrets> {
  const merged: Secrets = { ...(await readSecrets()), ...patch }
  await writeJsonFile(SECRETS_FILE, merged)
  return merged
}

function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`
}

export async function readApiToken(): Promise<string> {
  const existing = (await readSecrets()).apiToken
  if (existing !== null) return existing
  const generated = generateApiToken()
  await writeSecrets({ apiToken: generated })
  return generated
}

export async function rotateApiToken(): Promise<string> {
  const generated = generateApiToken()
  await writeSecrets({ apiToken: generated })
  return generated
}

export async function readAuthRecord(): Promise<AuthRecord> {
  const raw = await readJsonFile(AUTH_FILE)
  return {
    passwordHash: asString(raw.passwordHash),
    cookieSecret: asString(raw.cookieSecret),
  }
}

export async function writeAuthRecord(patch: Partial<AuthRecord>): Promise<AuthRecord> {
  const merged: AuthRecord = { ...(await readAuthRecord()), ...patch }
  await writeJsonFile(AUTH_FILE, merged)
  return merged
}

function readRoles(raw: unknown): EngineRoles {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    plan: asString(record.plan) ?? DEFAULT_ROLES.plan,
    execute: asString(record.execute) ?? DEFAULT_ROLES.execute,
    review: asString(record.review) ?? DEFAULT_ROLES.review,
  }
}

export async function readConfig(): Promise<AppConfig> {
  const raw = await readJsonFile(CONFIG_FILE)
  return { bind: asString(raw.bind) ?? DEFAULT_BIND, roles: readRoles(raw.roles) }
}

export async function writeConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const merged: AppConfig = { ...(await readConfig()), ...patch }
  await writeJsonFile(CONFIG_FILE, merged)
  return merged
}

export function parseBind(bind: string): BindTarget {
  const separator = bind.lastIndexOf(':')
  if (separator <= 0) return parseBind(DEFAULT_BIND)
  const hostname = bind.slice(0, separator)
  const port = Number.parseInt(bind.slice(separator + 1), 10)
  if (hostname === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return parseBind(DEFAULT_BIND)
  }
  return { hostname, port }
}

export function publicView(secrets: Secrets): PublicSecretsView {
  return {
    zaiBaseUrl: secrets.zaiBaseUrl,
    zaiAuthTokenConfigured: typeof secrets.zaiAuthToken === 'string' && secrets.zaiAuthToken !== '',
    apiTokenConfigured: typeof secrets.apiToken === 'string' && secrets.apiToken !== '',
  }
}
