import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attentionKey, chatOfJob, createAttentionStore, type AttentionItem } from '../server/attention'

const file = () => join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json')
const needs = (chatId: string): Omit<AttentionItem, 'createdAt'> => ({ key: attentionKey.needs(chatId), kind: 'needs', title: 'Login fix', detail: 'Needs you: Build it', command: null, chatId, jobId: null, requestId: null })
const loop = (jobId: string): Omit<AttentionItem, 'createdAt'> => ({ key: attentionKey.loop(jobId), kind: 'loop', title: 'Army export', detail: 'May be stuck: 81 turns in 20 min', command: null, chatId: null, jobId, requestId: null })

test('raising the same key twice keeps one item, its first time and the newest detail', async () => {
  let now = 1000
  const store = createAttentionStore(file(), () => now)
  await store.raise(needs('c1'))
  now = 2000
  await store.raise({ ...needs('c1'), detail: 'Needs you: Build it, Ship it' })
  expect(store.list()).toEqual([{ ...needs('c1'), detail: 'Needs you: Build it, Ship it', createdAt: 1000 }])
})

test('resolve removes by key and reports whether anything was there', async () => {
  const store = createAttentionStore(file())
  await store.raise(needs('c1'))
  expect(await store.resolve(attentionKey.needs('c1'))).toBe(true)
  expect(await store.resolve(attentionKey.needs('c1'))).toBe(false)
  expect(store.list()).toEqual([])
})

test('resolveWhere removes every match and returns the count', async () => {
  const store = createAttentionStore(file())
  await store.raise(loop('j1'))
  await store.raise(needs('c1'))
  expect(await store.resolveWhere(item => item.jobId === 'j1')).toBe(1)
  expect(store.list().map(item => item.key)).toEqual([attentionKey.needs('c1')])
})

test('items survive a restart', async () => {
  const path = file()
  await createAttentionStore(path).raise(needs('c1'))
  expect(createAttentionStore(path).list().map(item => item.key)).toEqual([attentionKey.needs('c1')])
})

test('prune drops permission and loop items for jobs no longer running and keeps needs items', async () => {
  const store = createAttentionStore(file())
  await store.raise(loop('gone'))
  await store.raise(loop('alive'))
  await store.raise({ key: attentionKey.permission('gone', 'r1'), kind: 'permission', title: 'Chat', detail: 'Wants to run a command', command: 'ls', chatId: 'c9', jobId: 'gone', requestId: 'r1' })
  await store.raise(needs('c1'))
  await store.prune(jobId => jobId === 'alive')
  expect(store.list().map(item => item.key).sort()).toEqual([attentionKey.loop('alive'), attentionKey.needs('c1')].sort())
})

test('a corrupt file starts empty instead of throwing', () => {
  const path = file()
  writeFileSync(path, '{not json')
  expect(createAttentionStore(path).list()).toEqual([])
})

test('every change notifies subscribers and the file holds the list', async () => {
  const path = file()
  const store = createAttentionStore(path)
  let calls = 0
  store.subscribe(() => { calls += 1 })
  await store.raise(needs('c1'))
  await store.resolve(attentionKey.needs('c1'))
  expect(calls).toBe(2)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ items: [] })
})

test('chatOfJob points chat turns at their thread root and agent jobs at their chat', () => {
  expect(chatOfJob({ purpose: 'chat', threadRoot: 'root1', chatId: undefined })).toBe('root1')
  expect(chatOfJob({ purpose: undefined, threadRoot: 'j1', chatId: 'root2' })).toBe('root2')
  expect(chatOfJob({ purpose: undefined, threadRoot: 'j1', chatId: undefined })).toBeNull()
})
