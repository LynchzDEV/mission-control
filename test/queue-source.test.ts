import { expect, test } from 'bun:test'

import type { InstalledPlugin } from '../server/plugins/store'
import { pluginSource, type SourceDeps } from '../server/queue-source'

type Call = { method: string; params: unknown }

function deps(answer: (call: Call) => unknown, options: { installed?: Partial<InstalledPlugin> | null; runtimeError?: string } = {}): { deps: SourceDeps; calls: Call[] } {
  const calls: Call[] = []
  const installed = options.installed === null ? null : ({ id: 'clickup-board', enabled: true, ...options.installed } as InstalledPlugin)
  return {
    calls,
    deps: {
      installed: async () => installed,
      runtimes: async () => ({
        getRuntime: async () => options.runtimeError
          ? { ok: false, status: 503, error: options.runtimeError }
          : { ok: true, runtime: { call: async (method: string, params: unknown) => { calls.push({ method, params }); const result = answer({ method, params }); return result instanceof Error ? { ok: false, status: 500, error: result.message } : { ok: true, result } }, dispose: async () => {} } },
      }),
    },
  }
}

test('item calls source.item and returns the parsed item', async () => {
  const { deps: d, calls } = deps(() => ({ title: 'Login copy', url: 'https://x/t/1', contextMarkdown: '# task' }))
  expect(await pluginSource('clickup-board', d).item({ id: '1' })).toEqual({ title: 'Login copy', url: 'https://x/t/1', contextMarkdown: '# task' })
  expect(calls).toEqual([{ method: 'source.item', params: { id: '1' } }])
})

test('post sends kind and lines and returns the comment id', async () => {
  const { deps: d, calls } = deps(() => ({ commentId: 'c9' }))
  expect(await pluginSource('clickup-board', d).post({ id: '1', kind: 'ask', lines: ['Which page?'] })).toEqual({ commentId: 'c9' })
  expect(calls[0]).toEqual({ method: 'source.post', params: { id: '1', kind: 'ask', lines: ['Which page?'] } })
})

test('replies parses replies and images', async () => {
  const { deps: d } = deps(() => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' }))
  expect(await pluginSource('clickup-board', d).replies({ id: '1', sinceId: 'c9' })).toEqual({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' })
})

test('a malformed plugin answer is rejected, not trusted', async () => {
  const { deps: d } = deps(() => ({ title: 3 }))
  await expect(pluginSource('clickup-board', d).item({ id: '1' })).rejects.toThrow('clickup-board returned an unexpected source.item result')
})

test('missing, disabled, unstartable or failing plugins throw readable errors', async () => {
  await expect(pluginSource('clickup-board', deps(() => ({}), { installed: null }).deps).item({ id: '1' })).rejects.toThrow('clickup-board is not installed')
  await expect(pluginSource('clickup-board', deps(() => ({}), { installed: { enabled: false } }).deps).item({ id: '1' })).rejects.toThrow('clickup-board is turned off')
  await expect(pluginSource('clickup-board', deps(() => ({}), { runtimeError: 'needs a newer Bun' }).deps).item({ id: '1' })).rejects.toThrow('needs a newer Bun')
  await expect(pluginSource('clickup-board', deps(() => new Error('No method source.item')).deps).item({ id: '1' })).rejects.toThrow('No method source.item')
})
