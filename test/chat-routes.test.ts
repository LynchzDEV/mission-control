import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { chatRoutes } from '../server/routes/chat'
import { readConfig } from '../server/secrets'

let configDir: string
let project: string
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-chat-routes-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  project = await mkdtemp(join(homedir(), 'mc-chat-home-'))
})
afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const app = (known: string[]) => new Elysia().use(chatRoutes({ knownDirectories: () => known }))
const local = (init: RequestInit = {}) => ({ headers: { host: '127.0.0.1:7777', ...(init.headers ?? {}) }, ...init })

describe('chat home routes', () => {
  test('GET reports a derived home and PUT stores one', async () => {
    const first = await app([join(project, 'a'), join(project, 'b')]).handle(new Request('http://127.0.0.1:7777/api/chat/home', local()))
    expect(await first.json()).toEqual({ ok: true, path: project, source: 'derived' })
    const put = await app([]).handle(new Request('http://127.0.0.1:7777/api/chat/home', local({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: project }) })))
    expect(put.status).toBe(200)
    expect((await readConfig()).chatHome).toBe(project)
  })
  test('PUT rejects ~, a missing folder and a folder outside $HOME', async () => {
    for (const path of [homedir(), join(project, 'missing'), tmpdir()]) {
      const response = await app([]).handle(new Request('http://127.0.0.1:7777/api/chat/home', local({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })))
      expect(response.status).toBe(400)
    }
  })
})
