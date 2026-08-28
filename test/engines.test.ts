import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ENGINE_NAMES,
  ENGINES,
  FAKE_ENGINES,
  buildEnv,
  fakeEnginesEnabled,
  resolveEngine,
} from '../server/engines'
import { writeSecrets } from '../server/secrets'

const TOKEN = 'zai-secret-token-must-never-appear-in-argv'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-engines-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  delete process.env.MC_FAKE_ENGINES
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_AUTH_TOKEN
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  delete process.env.MC_FAKE_ENGINES
  await rm(dir, { recursive: true, force: true })
})

describe('claude engine', () => {
  test('inherits process.env with no z.ai overlay at all', async () => {
    const env = await buildEnv('claude')
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL')
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(env).not.toHaveProperty('ANTHROPIC_DEFAULT_OPUS_MODEL')
    expect(env.PATH).toBe(process.env.PATH)
  })
})

describe('glm engine', () => {
  test('throws when zaiAuthToken is not configured', () => {
    expect(buildEnv('glm')).rejects.toThrow(/zaiAuthToken/)
  })

  test('overlays base url, token, and all three default-model vars once configured', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN, zaiBaseUrl: 'https://api.z.ai/api/anthropic' })
    const env = await buildEnv('glm')

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN)
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3-flash')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3-flash')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash')
    expect(env.PATH).toBe(process.env.PATH)
  })

  test('rejects an empty-string token the same as a missing one', async () => {
    await writeSecrets({ zaiAuthToken: '' })
    expect(buildEnv('glm')).rejects.toThrow(/zaiAuthToken/)
  })
})

describe('codex engine', () => {
  test('inherits process.env with no overlay', async () => {
    const env = await buildEnv('codex')
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL')
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  })
})

describe('secrets never reach argv', () => {
  test('cmd for every engine is a static literal that never contains the token', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    for (const name of ENGINE_NAMES) {
      expect(ENGINES[name].cmd).not.toContain(TOKEN)
      expect(FAKE_ENGINES[name].cmd).not.toContain(TOKEN)
    }
    expect(ENGINES.glm.cmd).toBe('claude')
    expect(ENGINES.claude.cmd).toBe('claude')
    expect(ENGINES.codex.cmd).toBe('codex')
  })

  test('the token only ever surfaces inside the env object, never as a spawn argument', async () => {
    await writeSecrets({ zaiAuthToken: TOKEN })
    const cmd = [resolveEngine('glm').cmd, '-p', 'hello']
    expect(cmd.join(' ')).not.toContain(TOKEN)
    const env = await buildEnv('glm')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN)
  })
})

describe('MC_FAKE_ENGINES', () => {
  test('is off by default', () => {
    expect(fakeEnginesEnabled()).toBe(false)
    expect(resolveEngine('claude')).toBe(ENGINES.claude)
  })

  test('swaps every engine cmd for /bin/echo when set to 1', async () => {
    process.env.MC_FAKE_ENGINES = '1'
    expect(fakeEnginesEnabled()).toBe(true)
    for (const name of ENGINE_NAMES) {
      expect(resolveEngine(name).cmd).toBe('/bin/echo')
    }
  })

  test('other values do not enable fake mode', () => {
    process.env.MC_FAKE_ENGINES = 'true'
    expect(fakeEnginesEnabled()).toBe(false)
  })

  test('fake glm still requires a configured token and still overlays the same env', async () => {
    process.env.MC_FAKE_ENGINES = '1'
    await writeSecrets({ zaiAuthToken: TOKEN })
    const env = await buildEnv('glm')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN)
    expect(resolveEngine('glm').cmd).toBe('/bin/echo')
  })
})
