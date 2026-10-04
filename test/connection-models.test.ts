import { expect, test } from 'bun:test'
import { discoveryLine, modelsLabel } from '../client/connection-models'

const now = 10 * 60 * 60_000

test('a found list says when it was checked and offers a refresh', () => {
  expect(discoveryLine('acp', { models: ['grok-4.7'], current: 'grok-4.7', checkedAt: now - 3 * 60_000, error: null }, now)).toEqual({ text: 'Found automatically · checked 3m ago', refresh: true })
  expect(discoveryLine('opencode', { models: ['llama3'], current: null, checkedAt: now, error: null }, now)).toEqual({ text: 'Found automatically · checked just now', refresh: true })
})

test('a failed check shows its reason', () => {
  expect(discoveryLine('acp', { models: [], current: null, checkedAt: now, error: 'grok is not signed in' }, now)).toEqual({ text: "Couldn't list models: grok is not signed in", refresh: true })
})

test('an unchecked connection is still looking', () => {
  expect(discoveryLine('acp', null, now)).toEqual({ text: 'Looking for models…', refresh: true })
  expect(discoveryLine('acp', undefined, now)).toEqual({ text: 'Looking for models…', refresh: true })
})

test('a CLI connection is told to list its models by hand', () => {
  expect(discoveryLine('cli', null, now)).toEqual({ text: "This AI can't report its models. Add them in its settings.", refresh: false })
})

test('the model field reads as optional extras when the AI reports its own', () => {
  expect(modelsLabel('acp')).toBe('Extra model IDs · one per line (optional)')
  expect(modelsLabel('opencode')).toBe('Extra model IDs · one per line (optional)')
  expect(modelsLabel(undefined)).toBe('Extra model IDs · one per line (optional)')
  expect(modelsLabel('cli')).toBe('Available model IDs · one per line')
})
