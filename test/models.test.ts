import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConnectionStore } from '../server/agent-connections'
import { GLM_MODEL } from '../server/engines'
import { createModelDiscovery } from '../server/model-discovery'
import { CLAUDE_MODEL_ALIASES, codexModels, glmModels, listModels } from '../server/models'

async function writeCache(models: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-models-'))
  const path = join(dir, 'models_cache.json')
  await writeFile(path, JSON.stringify(models))
  return path
}

describe('codexModels', () => {
  test('keeps visibility=list slugs sorted by priority', async () => {
    const path = await writeCache({
      models: [
        { slug: 'gpt-5.4', visibility: 'list', priority: 30 },
        { slug: 'hidden-one', visibility: 'hide', priority: 1 },
        { slug: 'gpt-5.6-sol', visibility: 'list', priority: 10 },
        { slug: 42, visibility: 'list', priority: 5 },
      ],
    })
    try {
      expect(await codexModels(path)).toEqual(['gpt-5.6-sol', 'gpt-5.4'])
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true })
    }
  })

  test('falls back when the cache file is missing', async () => {
    expect(await codexModels(join(tmpdir(), 'mc-models-missing', 'models_cache.json'))).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ])
  })

  test('falls back on malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-models-'))
    const path = join(dir, 'models_cache.json')
    await writeFile(path, 'not json at all')
    try {
      expect(await codexModels(path)).toEqual([
        'gpt-5.6-sol',
        'gpt-5.6-luna',
        'gpt-5.6-terra',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex-spark',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('glmModels', () => {
  test('pins GLM_MODEL first, reverses api order, dedupes', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'glm-5' }, { id: 'glm-5.3-flash' }] }), {
        status: 200,
      })) as typeof fetch
    expect(await glmModels({ zaiAuthToken: 'tok', zaiBaseUrl: 'https://api.example.com' }, fetchImpl)).toEqual([
      GLM_MODEL,
      'glm-5.3-flash',
      'glm-5',
    ])
  })

  test('falls back when fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    expect(await glmModels({ zaiAuthToken: 'tok', zaiBaseUrl: 'https://api.example.com' }, fetchImpl)).toEqual([
      GLM_MODEL,
      'glm-5.3-flash',
    ])
  })

  test('falls back without a token and never calls fetch', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    expect(await glmModels({ zaiAuthToken: null, zaiBaseUrl: 'https://api.example.com' }, fetchImpl)).toEqual([
      GLM_MODEL,
      'glm-5.3-flash',
    ])
    expect(called).toBe(false)
  })
})

describe('listModels', () => {
  test('returns all three engines with codex from the injected cache path', async () => {
    const path = await writeCache({ models: [{ slug: 'gpt-x', visibility: 'list', priority: 1 }] })
    try {
      const lists = await listModels({
        codexCachePath: path,
        secrets: async () => ({ zaiAuthToken: null, zaiBaseUrl: 'https://api.example.com', apiToken: null }),
      })
      expect(lists.claude).toEqual(CLAUDE_MODEL_ALIASES)
      expect(lists.glm).toEqual([GLM_MODEL, 'glm-5.3-flash'])
      expect(lists.codex).toEqual(['gpt-x'])
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true })
    }
  })

  test('a connection reports discovered models first and starts a check when it has none', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mc-models-connections-'))
    const previous = process.env.MISSION_CONTROL_CONFIG_DIR
    process.env.MISSION_CONTROL_CONFIG_DIR = base
    try {
      await createConnectionStore(base).save({ id: 'grok', name: 'Grok', adapter: 'acp', command: 'grok', args: ['agent', 'stdio'], models: ['grok-custom'] })
      await createConnectionStore(base).save({ id: 'qwen', name: 'Qwen', adapter: 'acp', command: 'qwen', args: ['--acp'], models: ['qwen3-coder'] })
      const asked: string[] = []
      const discovery = createModelDiscovery({ base, now: () => 1000, bridge: async input => { asked.push((input as { connection: { id: string } }).connection.id); return [{ type: 'mc_models', models: ['qwen-max'], current: null }] } })
      await discovery.write('grok', { models: ['grok-4.7'], current: 'grok-4.7', checkedAt: 1000, error: null })
      const lists = await listModels({ discovery, secrets: async () => ({ zaiAuthToken: null, zaiBaseUrl: 'https://api.example.com', apiToken: null }) })
      expect(lists.grok).toEqual(['grok-4.7', 'grok-custom'])
      expect(lists.qwen).toEqual(['qwen3-coder'])
      await Bun.sleep(5)
      expect(asked).toEqual(['qwen'])
    } finally {
      if (previous === undefined) delete process.env.MISSION_CONTROL_CONFIG_DIR
      else process.env.MISSION_CONTROL_CONFIG_DIR = previous
      await rm(base, { recursive: true, force: true })
    }
  })
})
