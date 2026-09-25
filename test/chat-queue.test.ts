import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChatQueue } from '../server/chat-queue'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-chat-queue-'))
  path = join(dir, 'nested', 'chat-queue.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createChatQueue', () => {
  test('an empty or missing file is an empty queue', () => {
    const queue = createChatQueue(path)
    expect(queue.list('c1')).toEqual([])
    expect(queue.chats()).toEqual([])
  })

  test('added messages are listed per chat in order and survive a new instance on the same file', async () => {
    const queue = createChatQueue(path)
    const first = await queue.add('c1', 'first')
    const second = await queue.add('c1', 'second')
    await queue.add('c2', 'other')
    expect(first.chatId).toBe('c1')
    expect(first.text).toBe('first')
    expect(typeof first.id).toBe('string')
    expect(typeof first.queuedAt).toBe('number')
    expect(first.id).not.toBe(second.id)
    const reloaded = createChatQueue(path)
    expect(reloaded.list('c1').map((item) => item.text)).toEqual(['first', 'second'])
    expect(reloaded.chats().sort()).toEqual(['c1', 'c2'])
    expect(JSON.parse(await readFile(path, 'utf8')).items).toHaveLength(3)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('take removes and returns every message of one chat', async () => {
    const queue = createChatQueue(path)
    await queue.add('c1', 'first')
    await queue.add('c2', 'other')
    await queue.add('c1', 'second')
    expect((await queue.take('c1')).map((item) => item.text)).toEqual(['first', 'second'])
    expect(queue.list('c1')).toEqual([])
    expect(await queue.take('c1')).toEqual([])
    expect(createChatQueue(path).chats()).toEqual(['c2'])
  })

  test('restore puts taken messages back ahead of newer ones', async () => {
    const queue = createChatQueue(path)
    await queue.add('c1', 'first')
    const taken = await queue.take('c1')
    await queue.add('c1', 'newer')
    await queue.restore('c1', taken)
    expect(createChatQueue(path).list('c1').map((item) => item.text)).toEqual(['first', 'newer'])
  })

  test('remove deletes one message of that chat only', async () => {
    const queue = createChatQueue(path)
    const item = await queue.add('c1', 'first')
    await queue.add('c1', 'second')
    expect(await queue.remove('c2', item.id)).toBe(false)
    expect(await queue.remove('c1', item.id)).toBe(true)
    expect(await queue.remove('c1', item.id)).toBe(false)
    expect(createChatQueue(path).list('c1').map((entry) => entry.text)).toEqual(['second'])
  })

  test('a corrupt file or malformed items are ignored', async () => {
    await Bun.write(path, '{not json')
    expect(createChatQueue(path).list('c1')).toEqual([])
    await Bun.write(path, JSON.stringify({ items: [{ id: 'a', chatId: 'c1', text: 'ok', queuedAt: 1 }, { id: 2 }, null] }))
    expect(createChatQueue(path).list('c1').map((item) => item.text)).toEqual(['ok'])
  })
})
