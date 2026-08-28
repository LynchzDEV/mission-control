import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_TOKEN_PREFIX,
  AUTH_FILE,
  CONFIG_FILE,
  DEFAULT_BIND,
  DEFAULT_ZAI_BASE_URL,
  SECRETS_FILE,
  configPath,
  ensureConfigDir,
  parseBind,
  publicView,
  readApiToken,
  readAuthRecord,
  readConfig,
  readSecrets,
  rotateApiToken,
  writeAuthRecord,
  writeConfig,
  writeSecrets,
} from '../server/secrets'

const TOKEN = 'sk-zai-test-token-value-do-not-leak'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-secrets-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

describe('defaults', () => {
  test('missing files fall back to documented defaults', async () => {
    expect(await readSecrets()).toEqual({ zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: null })
    expect(await readAuthRecord()).toEqual({ passwordHash: null, cookieSecret: null })
    expect(await readConfig()).toEqual({ bind: DEFAULT_BIND })
  })

  test('corrupt json falls back instead of throwing', async () => {
    await ensureConfigDir()
    await Bun.write(configPath(SECRETS_FILE), '{ not json')
    expect(await readSecrets()).toEqual({ zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: null })
  })
})

describe('round trip', () => {
  test('secrets survive write then read', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN, zaiBaseUrl: 'https://example.test/anthropic' })
    expect(await readSecrets()).toEqual({
      zaiAuthToken: TOKEN,
      zaiBaseUrl: 'https://example.test/anthropic',
      apiToken: null,
    })
  })

  test('partial writes merge with stored values', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    await writeSecrets({ zaiBaseUrl: 'https://example.test/anthropic' })
    const stored = await readSecrets()
    expect(stored.zaiAuthToken).toBe(TOKEN)
    expect(stored.zaiBaseUrl).toBe('https://example.test/anthropic')
  })

  test('auth and config survive write then read', async () => {
    await writeAuthRecord({ passwordHash: '$argon2id$fake', cookieSecret: 'deadbeef' })
    await writeConfig({ bind: '0.0.0.0:8080' })
    expect(await readAuthRecord()).toEqual({
      passwordHash: '$argon2id$fake',
      cookieSecret: 'deadbeef',
    })
    expect(await readConfig()).toEqual({ bind: '0.0.0.0:8080' })
  })
})

describe('permissions', () => {
  test('directory is 0700 and every file is 0600', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    await writeAuthRecord({ passwordHash: 'hash' })
    await writeConfig({ bind: DEFAULT_BIND })

    expect(await modeOf(dir)).toBe(0o700)
    expect(await modeOf(configPath(SECRETS_FILE))).toBe(0o600)
    expect(await modeOf(configPath(AUTH_FILE))).toBe(0o600)
    expect(await modeOf(configPath(CONFIG_FILE))).toBe(0o600)
  })

  test('rewriting an existing file keeps it at 0600', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    await writeSecrets({ zaiAuthToken: `${TOKEN}-rotated` })
    expect(await modeOf(configPath(SECRETS_FILE))).toBe(0o600)
  })
})

describe('publicView', () => {
  test('never exposes the token value', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    const view = publicView(await readSecrets())

    expect(JSON.stringify(view)).not.toContain(TOKEN)
    expect(Object.values(view)).not.toContain(TOKEN)
    expect(view).toEqual({
      zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
      zaiAuthTokenConfigured: true,
      apiTokenConfigured: false,
    })
  })

  test('reports unconfigured for missing or empty token', () => {
    expect(publicView({ zaiAuthToken: null, zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: null })).toEqual({
      zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
      zaiAuthTokenConfigured: false,
      apiTokenConfigured: false,
    })
    expect(publicView({ zaiAuthToken: '', zaiBaseUrl: DEFAULT_ZAI_BASE_URL, apiToken: '' })).toEqual({
      zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
      zaiAuthTokenConfigured: false,
      apiTokenConfigured: false,
    })
  })

  test('never exposes the api token value once generated', async () => {
    const apiToken = await readApiToken()
    const view = publicView(await readSecrets())

    expect(JSON.stringify(view)).not.toContain(apiToken)
    expect(view.apiTokenConfigured).toBe(true)
  })
})

describe('readApiToken', () => {
  test('generates a prefixed token on first read and persists it', async () => {
    const token = await readApiToken()
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect(token.slice(API_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{48}$/)

    const stored = await readSecrets()
    expect(stored.apiToken).toBe(token)
  })

  test('is idempotent — repeat reads return the same token', async () => {
    const first = await readApiToken()
    const second = await readApiToken()
    expect(second).toBe(first)
  })

  test('is persisted at 0600', async () => {
    await readApiToken()
    expect(await modeOf(configPath(SECRETS_FILE))).toBe(0o600)
  })
})

describe('rotateApiToken', () => {
  test('replaces the stored token with a new, differently-valued one', async () => {
    const original = await readApiToken()
    const rotated = await rotateApiToken()

    expect(rotated).not.toBe(original)
    expect(rotated.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect((await readSecrets()).apiToken).toBe(rotated)
    expect(await readApiToken()).toBe(rotated)
  })
})

describe('parseBind', () => {
  test('parses a valid host:port', () => {
    expect(parseBind('127.0.0.1:7777')).toEqual({ hostname: '127.0.0.1', port: 7777 })
    expect(parseBind('0.0.0.0:8080')).toEqual({ hostname: '0.0.0.0', port: 8080 })
  })

  test('falls back to the default for malformed values', () => {
    const fallback = { hostname: '127.0.0.1', port: 7777 }
    expect(parseBind('nonsense')).toEqual(fallback)
    expect(parseBind('127.0.0.1:0')).toEqual(fallback)
    expect(parseBind(':7777')).toEqual(fallback)
    expect(parseBind('127.0.0.1:99999')).toEqual(fallback)
  })
})
