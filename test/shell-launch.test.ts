import { describe, expect, test } from 'bun:test'
import { launchChoice, restoreRequested } from '../client/shell-launch'

const providers = [
  { id: 'claude', name: 'Claude', models: ['opus', 'sonnet'] },
  { id: 'glm', name: 'GLM', models: ['glm-5.3'] },
]

describe('launchChoice', () => {
  test('restores a remembered engine and its model', () => {
    expect(launchChoice(providers, 'glm', 'glm-5.3')).toEqual({ engine: 'glm', model: 'glm-5.3' })
  })
  test('falls back to the first provider and clears the model when the remembered engine is gone', () => {
    expect(launchChoice(providers, 'codex', 'gpt-5.5')).toEqual({ engine: 'claude', model: '' })
  })
  test('uses the first provider with no memory at all', () => {
    expect(launchChoice(providers, null, null)).toEqual({ engine: 'claude', model: '' })
  })
  test('yields an empty choice for an empty provider list', () => {
    expect(launchChoice([], 'claude', 'opus')).toEqual({ engine: '', model: '' })
  })
})

describe('restoreRequested', () => {
  test('is true for the #terminal hash or a ?terminal id', () => {
    expect(restoreRequested({ hash: '#terminal', search: '' })).toBe(true)
    expect(restoreRequested({ hash: '', search: '?terminal=abc' })).toBe(true)
  })
  test('is false for a plain visit', () => {
    expect(restoreRequested({ hash: '', search: '' })).toBe(false)
    expect(restoreRequested({ hash: '#flow', search: '?embed=1' })).toBe(false)
  })
})
