import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attentionKey, createAttentionStore } from '../server/attention'
import { attentionEvents } from '../server/attention-events'
import type { JobRecord } from '../server/jobs'

const store = () => createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))
const job = (patch: Partial<JobRecord>): JobRecord => ({ id: 'j1', label: 'Army export', threadRoot: 'j1', turns: 81, startedAt: 0, slowAt: 20 * 60_000, status: 'running', ...patch } as JobRecord)
const chatRoot = job({ id: 'root1', label: 'Login fix', purpose: 'chat', threadRoot: 'root1' })

test('a slow job raises one loop item that links to its chat', async () => {
  const items = store()
  await attentionEvents(items).slow(job({ chatId: 'c1' }))
  expect(items.list()).toMatchObject([{ key: attentionKey.loop('j1'), kind: 'loop', title: 'Army export', detail: 'May be stuck: 81 turns in 20 min', chatId: 'c1', jobId: 'j1' }])
})

test('needsYou raises one item per chat', async () => {
  const items = store()
  const events = attentionEvents(items)
  await events.needsYou(chatRoot, 'Needs you: Build it')
  await events.needsYou(chatRoot, 'Needs you: Ship it')
  expect(items.list()).toMatchObject([{ key: attentionKey.needs('root1'), title: 'Login fix', detail: 'Needs you: Ship it', chatId: 'root1' }])
})

test('a user turn or a new agent job in the chat clears its needs item; an agent report turn does not', async () => {
  const items = store()
  const events = attentionEvents(items)
  await events.needsYou(chatRoot, 'Needs you: Build it')
  await events.started(job({ id: 't2', purpose: 'chat', threadRoot: 'root1', source: 'agent' }))
  expect(items.list()).toHaveLength(1)
  await events.started(job({ id: 't3', purpose: 'chat', threadRoot: 'root1', source: 'user' }))
  expect(items.list()).toEqual([])
  await events.needsYou(chatRoot, 'Needs you: Build it')
  await events.started(job({ id: 'retry', chatId: 'root1' }))
  expect(items.list()).toEqual([])
})

test('a job that ends clears its loop and permission items but not its chat needs item', async () => {
  const items = store()
  const events = attentionEvents(items)
  await events.slow(job({ chatId: 'root1' }))
  await items.raise({ key: attentionKey.permission('j1', 'r1'), kind: 'permission', title: 'Chat', detail: 'Wants to run a command', command: 'ls', chatId: 'root1', jobId: 'j1', requestId: 'r1' })
  await events.needsYou(chatRoot, 'Needs you: Build it')
  await events.settled(job({ status: 'failed', chatId: 'root1' }))
  expect(items.list().map(item => item.kind)).toEqual(['needs'])
})

test('a permission request raises one item with the command, linked to its chat and job', async () => {
  const items = store()
  const events = attentionEvents(items)
  await events.permission(job({ id: 't9', label: 'Login fix', purpose: 'chat', threadRoot: 'root1' }), { requestId: 'r1', title: 'Claude wants to run a command', body: 'bun test' })
  await events.permission(job({ id: 't9', label: 'Login fix', purpose: 'chat', threadRoot: 'root1' }), { requestId: 'r2', title: 'Claude wants to edit a file', body: '' })
  expect(items.list()).toMatchObject([
    { key: attentionKey.permission('t9', 'r1'), kind: 'permission', title: 'Login fix', detail: 'Claude wants to run a command', command: 'bun test', chatId: 'root1', jobId: 't9', requestId: 'r1' },
    { key: attentionKey.permission('t9', 'r2'), command: null },
  ])
})
