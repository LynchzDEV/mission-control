import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectionStore, connectionSchema, connectionEnvironment, connectionCommand, modelFamily } from '../server/agent-connections'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-connections-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('custom connections persist without restricting the agent or provider catalog', async () => {
  const store = createConnectionStore(dir)
  await store.save({ id: 'qwen-team', name: 'Qwen coding plan', adapter: 'acp', command: 'qwen', args: ['--acp'], family: 'qwen' })
  expect((await createConnectionStore(dir).get('qwen-team')).args).toEqual(['--acp'])
  await expect(store.save({ id: 'claude', name: 'Replacement', adapter: 'acp', command: 'x' })).rejects.toThrow('built-in')
})

test('credentials use environment references and missing credentials fail without revealing values', () => {
  const connection = connectionSchema.parse({ id: 'local', name: 'Local', adapter: 'acp', command: 'agent', env: { PROVIDER_KEY: 'MY_KEY' } })
  expect(connectionEnvironment(connection, { MY_KEY: 'secret-value' })).toEqual({ PROVIDER_KEY: 'secret-value' })
  expect(() => connectionEnvironment(connection, {})).toThrow('MY_KEY')
  expect(connectionSchema.safeParse({ ...connection, env: { KEY: 'sk-secret-key' } }).success).toBe(false)
})

test('CLI arguments substitute literal values without shell evaluation', () => {
  const connection = connectionSchema.parse({ id: 'any', name: 'Any CLI', adapter: 'cli', command: 'agent', args: ['-p', '{{prompt}}', '-m', '{{model}}'] })
  expect(connectionCommand(connection, 'do $(nothing)', 'custom-model').args).toEqual(['-p', 'do $(nothing)', '-m', 'custom-model'])
  expect(modelFamily('openrouter/anthropic/claude-opus')).toBe('claude')
  expect(modelFamily('unrecognized')).toBeNull()
})

test('connections cannot override worker identity or embed credentials in endpoint URLs', () => {
  const base = { id: 'custom', name: 'Custom', adapter: 'acp', command: 'agent' }
  expect(connectionSchema.safeParse({ ...base, env: { MC_JOB_ID: 'MY_JOB_ID' } }).success).toBe(false)
  expect(connectionSchema.safeParse({ ...base, adapter: 'opencode', models: ['local'], baseUrl: 'https://user:secret@example.com/v1' }).success).toBe(false)
})

test('removing a connection deletes it, tolerates repeats and protects built-ins', async () => {
  const store = createConnectionStore(dir)
  await store.save({ id: 'qwen', name: 'Qwen', adapter: 'acp', command: 'qwen', args: ['--acp'] })
  await store.remove('qwen')
  expect(await store.list()).toEqual([])
  await expect(store.get('qwen')).rejects.toThrow()
  await store.remove('qwen')
  await expect(store.remove('claude')).rejects.toThrow('Cannot remove a built-in connection')
})

test('a missing connection reads as not configured instead of a filesystem path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-conn-missing-'))
  try { await expect(createConnectionStore(dir).get('ghost')).rejects.toThrow('Connection "ghost" is not configured') } finally { await rm(dir, { recursive: true, force: true }) }
})
