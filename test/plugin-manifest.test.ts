import { describe, expect, test } from 'bun:test'

import { parseManifest, permissionsAdded, type PluginManifest } from '../server/plugins/manifest'

const CLICKUP_MANIFEST: PluginManifest = {
  id: 'clickup-board',
  name: 'ClickUp board',
  version: '1.0.0',
  description: 'See a ClickUp board and start a chat or terminal on any task.',
  pluginApi: 1,
  runtime: 'isolated',
  icon: 'assets/icon.svg',
  server: 'src/server.ts',
  screen: 'src/screen.ts',
  permissions: {
    network: ['api.clickup.com'],
    sessions: ['chat', 'terminal'],
    settings: true,
  },
  settings: [
    { key: 'token', label: 'ClickUp token', type: 'secret', help: 'ClickUp, Settings, Apps, Generate.' },
  ],
}

describe('parseManifest', () => {
  test('accepts the ClickUp manifest from the spec', () => {
    expect(parseManifest(CLICKUP_MANIFEST)).toEqual({ ok: true, manifest: CLICKUP_MANIFEST })
  })

  test('queueSource is optional and must be a boolean', () => {
    expect(parseManifest({ ...CLICKUP_MANIFEST, queueSource: true })).toEqual({ ok: true, manifest: { ...CLICKUP_MANIFEST, queueSource: true } })
    expect(parseManifest({ ...CLICKUP_MANIFEST, queueSource: false })).toEqual({ ok: true, manifest: { ...CLICKUP_MANIFEST, queueSource: false } })
    const absent = parseManifest(CLICKUP_MANIFEST)
    expect(absent.ok && absent.manifest.queueSource).toBeUndefined()
    const wrong = parseManifest({ ...CLICKUP_MANIFEST, queueSource: 'yes' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.errors.join('\n')).toContain('queueSource')
  })

  test('refuses a pluginApi the host does not speak', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, pluginApi: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContain('This plugin needs a newer Mission Control')
  })

  test('refuses an invalid id', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, id: 'Bad_ID' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
  })

  test('refuses paths outside the plugin folder', () => {
    for (const field of ['server', 'screen', 'icon']) {
      const result = parseManifest({ ...CLICKUP_MANIFEST, [field]: '../x.ts' })
      expect(result.ok, field).toBe(false)
      if (!result.ok) expect(result.errors.join('\n')).toContain(field)
    }
    expect(parseManifest({ ...CLICKUP_MANIFEST, screen: '/abs.ts' }).ok).toBe(false)
  })

  test('refuses wildcard and non-plain network permissions', () => {
    for (const host of ['*.clickup.com', 'https://api.clickup.com', 'api.clickup.com/path', 'API.ClickUp.com']) {
      const result = parseManifest({ ...CLICKUP_MANIFEST, permissions: { ...CLICKUP_MANIFEST.permissions, network: [host] } })
      expect(result.ok, host).toBe(false)
      if (!result.ok) expect(result.errors.join('\n')).toContain(host)
    }
  })

  test('the network format rule holds for trusted plugins too', () => {
    expect(parseManifest({ ...CLICKUP_MANIFEST, runtime: 'trusted', permissions: { network: ['*.example.com'] } }).ok).toBe(false)
  })

  test('refuses a settings key declared twice', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, settings: [
      { key: 'token', label: 'ClickUp token', type: 'secret' },
      { key: 'token', label: 'Token again', type: 'text' },
    ] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toContain('declared more than once')
  })

  test('collects several errors at once', () => {
    const result = parseManifest({ ...CLICKUP_MANIFEST, id: 'x', pluginApi: 2, screen: '../x.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBe(3)
  })
})

describe('permissionsAdded', () => {
  test('lists new hosts, new session kinds and new settings in order', () => {
    expect(permissionsAdded(
      { network: ['a.com'] },
      { network: ['a.com', 'b.com'], sessions: ['chat'] },
    )).toEqual(['Reach b.com', 'Start chats'])
  })

  test('reports nothing when permissions only shrink', () => {
    expect(permissionsAdded(
      { network: ['a.com', 'b.com'], sessions: ['chat', 'terminal'], settings: true },
      { network: ['a.com'] },
    )).toEqual([])
  })

  test('reports settings false to true and terminal growth separately', () => {
    expect(permissionsAdded({ sessions: ['chat'] }, { sessions: ['chat', 'terminal'], settings: true })).toEqual(['Start terminals', 'Keep its own settings'])
  })
})
