import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Elysia } from 'elysia'

import { createApp } from '../server/index'

let dir: string
let app: Elysia

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-views-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  app = await createApp()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

const RETIRED_PAGES = ['/lanes', '/dispatch', '/terminals', '/review', '/settings']

describe('retired page routes', () => {
  test('each old tab page redirects to the shell, embedded or not', async () => {
    for (const path of RETIRED_PAGES) {
      for (const url of [path, `${path}?embed=1`]) {
        const response = await app.handle(new Request(`http://localhost${url}`))
        expect(response.status).toBe(302)
        expect(response.headers.get('location')).toBe('/')
      }
    }
  })

  test('/studio opens the Studio screen in the shell, embedded or not', async () => {
    for (const path of ['/studio', '/studio?embed=1']) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/?screen=studio')
    }
  })

  test('a rebinding host is refused without a redirect', async () => {
    for (const path of ['/', '/studio', ...RETIRED_PAGES]) {
      const response = await app.handle(new Request(`http://rebind.example${path}`, { headers: { host: 'rebind.example:7777' } }))
      expect(response.status).toBe(403)
      expect(response.headers.get('location')).toBeNull()
    }
  })
})

describe('retired islands', () => {
  test('the removed pre-2.0 islands are no longer served', async () => {
    for (const island of ['nav', 'forms', 'sprites', 'flow', 'lanes', 'resize', 'dispatch', 'terminal', 'agents', 'workspace']) {
      expect((await app.handle(new Request(`http://localhost/js/${island}.js`))).status).toBe(404)
    }
  })
})

describe('flow route', () => {
  test('serves the live session map behind the local-access guard', async () => {
    expect((await app.handle(new Request('http://rebind.example/api/flow'))).status).toBe(403)

    const response = await app.handle(new Request('http://localhost/api/flow'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      source: string
      current: string
      sessions: Record<string, Record<string, [string, string]>>
      reviewCount: number
      mergedToday: number
    }
    expect(body.source).toBe('live')
    expect(body.sessions).toEqual({})
    expect(body.current).toBe('')
    expect(body.reviewCount).toBe(0)
    expect(body.mergedToday).toBe(0)
  })
})
