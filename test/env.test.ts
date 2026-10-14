import { describe, expect, test } from 'bun:test'
import { envNames, exportEnv, readEnv } from '../server/env'
import { fakeEnginesEnabled } from '../server/engines'
import { allowedRemoteHosts } from '../server/local-access'
import { configDir } from '../server/secrets'
import { fullAgentSetup } from '../server/worker-profile'

describe('readEnv', () => {
  test('reads the SKD_ name first', () => {
    expect(readEnv('PORT', { SKD_PORT: '1', MISSION_CONTROL_PORT: '2', MC_PORT: '3' })).toBe('1')
  })
  test('falls back to the MISSION_CONTROL_ name, then the MC_ name', () => {
    expect(readEnv('PORT', { MISSION_CONTROL_PORT: '2', MC_PORT: '3' })).toBe('2')
    expect(readEnv('PORT', { MC_PORT: '3' })).toBe('3')
  })
  test('skips empty values', () => {
    expect(readEnv('PORT', { SKD_PORT: '', MC_PORT: '3' })).toBe('3')
  })
  test('returns undefined when no name is set', () => {
    expect(readEnv('PORT', {})).toBeUndefined()
  })
  test('reads process.env by default', () => {
    process.env.MC_ENV_TEST_ONLY = 'legacy'
    try {
      expect(readEnv('ENV_TEST_ONLY')).toBe('legacy')
    } finally { delete process.env.MC_ENV_TEST_ONLY }
  })
  test('lists the names in read order', () => {
    expect(envNames('LOG')).toEqual(['SKD_LOG', 'MISSION_CONTROL_LOG', 'MC_LOG'])
  })
})

describe('exportEnv', () => {
  test('exports each value under the SKD_ name and its legacy name', () => {
    expect(exportEnv({ URL: 'http://x', JOB_ID: 'j1' })).toEqual({ SKD_URL: 'http://x', MC_URL: 'http://x', SKD_JOB_ID: 'j1', MC_JOB_ID: 'j1' })
  })
  test('exports the config dir under its MISSION_CONTROL_ legacy name', () => {
    expect(exportEnv({ CONFIG_DIR: '/c' })).toEqual({ SKD_CONFIG_DIR: '/c', MISSION_CONTROL_CONFIG_DIR: '/c' })
  })
})

describe('legacy names reach the readers', () => {
  function withEnv(vars: Record<string, string>, check: () => void) {
    const touched = [...new Set(Object.keys(vars).flatMap(key => envNames(key.replace(/^(SKD|MISSION_CONTROL|MC)_/, ''))))]
    const saved = Object.fromEntries(touched.map(key => [key, process.env[key]]))
    for (const key of touched) delete process.env[key]
    Object.assign(process.env, vars)
    try { check() } finally {
      for (const key of touched) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }
  test('MISSION_CONTROL_CONFIG_DIR sets the config dir', () => {
    withEnv({ MISSION_CONTROL_CONFIG_DIR: '/legacy/config' }, () => expect(configDir()).toBe('/legacy/config'))
  })
  test('SKD_CONFIG_DIR wins over MISSION_CONTROL_CONFIG_DIR', () => {
    withEnv({ SKD_CONFIG_DIR: '/new/config', MISSION_CONTROL_CONFIG_DIR: '/legacy/config' }, () => expect(configDir()).toBe('/new/config'))
  })
  test('MISSION_CONTROL_ALLOWED_HOSTS allows a remote host', () => {
    withEnv({ MISSION_CONTROL_ALLOWED_HOSTS: 'pc.tail1234.ts.net' }, () => expect(allowedRemoteHosts()).toEqual(['pc.tail1234.ts.net']))
  })
  test('MC_FAKE_ENGINES turns on fake engines', () => {
    withEnv({ MC_FAKE_ENGINES: '1' }, () => expect(fakeEnginesEnabled()).toBe(true))
  })
  test('MISSION_CONTROL_FULL_AGENT_SETUP turns on the full agent setup', () => {
    withEnv({ MISSION_CONTROL_FULL_AGENT_SETUP: '1' }, () => expect(fullAgentSetup()).toBe(true))
  })
})
