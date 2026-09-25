import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { transpileClientModule, transpileClientStyles } from '../server/index'

const TS_ONLY_SYNTAX = ['export type LaunchProvider', ': LaunchProvider[]', 'lastEngine: string']

describe('transpileClientModule', () => {
  test('returns browser JS with no TypeScript syntax left', async () => {
    const code = await transpileClientModule('shell-launch.js')

    expect(code).not.toBeNull()
    expect(code).toContain('function launchChoice(')
    for (const marker of TS_ONLY_SYNTAX) {
      expect(code).not.toContain(marker)
    }
  })

  test('serves a byte-identical result from cache on repeat requests', async () => {
    const first = await transpileClientModule('shell-launch.js')
    const second = await transpileClientModule('shell-launch.js')
    expect(second).toBe(first as string)
  })

  test('bundles the shell-activity island with its awareness, work and shared imports inlined', async () => {
    const code = await transpileClientModule('shell-activity.js')

    expect(code).not.toBeNull()
    expect(code).toContain('mc:agent-open')
    for (const specifier of ['./awareness', './work', './shared']) expect(code).not.toContain(specifier)
  })

  test('returns null for an unknown module', async () => {
    expect(await transpileClientModule('does-not-exist.js')).toBeNull()
  })

  test('returns null without a .js suffix', async () => {
    expect(await transpileClientModule('shell-launch')).toBeNull()
    expect(await transpileClientModule('shell-launch.ts')).toBeNull()
  })

  test('rejects path traversal and separators', async () => {
    for (const attempt of [
      '../secrets.js',
      '../server/secrets.js',
      '../../etc/passwd.js',
      './shell-launch.js',
      'sub/shell-launch.js',
      'shell-launch.js/../../secrets.js',
      '..%2Fsecrets.js',
      'shell-launch\0.js',
    ]) {
      expect(await transpileClientModule(attempt)).toBeNull()
    }
  })
})

describe('GET /js/:file', () => {
  test('serves shell-launch.js as javascript and 404s unknown names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-transpile-'))
    const previous = process.env.MISSION_CONTROL_CONFIG_DIR
    process.env.MISSION_CONTROL_CONFIG_DIR = dir
    try {
      const { createApp } = await import('../server/index')
      const app = await createApp()

      const ok = await app.handle(new Request('http://localhost/js/shell-launch.js'))
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(await ok.text()).toContain('function launchChoice(')

      const missing = await app.handle(new Request('http://localhost/js/nope.js'))
      expect(missing.status).toBe(404)

      const traversal = await app.handle(new Request('http://localhost/js/..%2Fsecrets.js'))
      expect(traversal.status).not.toBe(200)
    } finally {
      if (previous === undefined) delete process.env.MISSION_CONTROL_CONFIG_DIR; else process.env.MISSION_CONTROL_CONFIG_DIR = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('Studio ships its React graph and stylesheet without server-side dependencies', async () => {
  const js = await transpileClientModule('studio.js')
  const css = await transpileClientStyles('studio.css')
  expect(js).toContain('Run workflow')
  expect(js!.length).toBeLessThan(500000)
  expect(js).not.toContain('node:fs')
  expect(css).toContain('.react-flow')
  expect(await transpileClientStyles('../studio.css')).toBeNull()
})
