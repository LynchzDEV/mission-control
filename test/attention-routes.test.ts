import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { attentionKey, createAttentionStore } from '../server/attention'
import { attentionRoutes } from '../server/routes/attention'

const store = () => createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))
const call = (app: Elysia, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777' } }))
const needs = { key: attentionKey.needs('c1'), kind: 'needs' as const, title: 'Login fix', detail: 'Needs you: Build it', command: null, chatId: 'c1', jobId: null, requestId: null }
const perm = { key: attentionKey.permission('j1', 'r1'), kind: 'permission' as const, title: 'Chat', detail: 'Wants to run a command', command: 'ls', chatId: 'c1', jobId: 'j1', requestId: 'r1' }

test('GET lists the items', async () => {
  const items = store()
  await items.raise(needs)
  const response = await call(new Elysia().use(attentionRoutes(items)), '/api/attention')
  expect((await response.json()).items.map((item: { key: string }) => item.key)).toEqual([needs.key])
})

test('the stream sends a snapshot, then a new snapshot after a change', async () => {
  const items = store()
  const controller = new AbortController()
  const response = await new Elysia().use(attentionRoutes(items)).handle(new Request('http://127.0.0.1:7777/api/attention/stream', { headers: { host: '127.0.0.1:7777' }, signal: controller.signal }))
  const reader = response.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).toBe('data: {"items":[]}\n\n')
  await items.raise(needs)
  const second = new TextDecoder().decode((await reader.read()).value)
  expect(JSON.parse(second.slice('data: '.length)).items[0].key).toBe(needs.key)
  controller.abort()
})

test('dismiss clears a needs item, refuses a permission item, and 404s an unknown key', async () => {
  const items = store()
  await items.raise(needs)
  await items.raise(perm)
  const app = new Elysia().use(attentionRoutes(items))
  expect((await call(app, `/api/attention/${encodeURIComponent(needs.key)}/dismiss`, { method: 'POST' })).status).toBe(200)
  expect((await call(app, `/api/attention/${encodeURIComponent(perm.key)}/dismiss`, { method: 'POST' })).status).toBe(409)
  expect((await call(app, `/api/attention/${encodeURIComponent('needs:nope')}/dismiss`, { method: 'POST' })).status).toBe(404)
  expect(items.list().map(item => item.key)).toEqual([perm.key])
})

test('a request from outside this machine is refused', async () => {
  const response = await new Elysia().use(attentionRoutes(store())).handle(new Request('http://evil.example/api/attention', { headers: { host: 'evil.example' } }))
  expect(response.status).toBe(403)
})
