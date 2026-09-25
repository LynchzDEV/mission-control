import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { configDir } from './secrets'
import { atomicJson } from './workflows'

export const CHAT_QUEUE_FILE = 'chat-queue.json'

export type ChatQueueItem = { id: string; chatId: string; text: string; queuedAt: number }

export type ChatQueue = {
  list(chatId: string): ChatQueueItem[]
  add(chatId: string, text: string): Promise<ChatQueueItem>
  remove(chatId: string, id: string): Promise<boolean>
  take(chatId: string): Promise<ChatQueueItem[]>
  restore(chatId: string, items: readonly ChatQueueItem[]): Promise<void>
  chats(): string[]
}

export function chatQueuePath(): string {
  return join(configDir(), CHAT_QUEUE_FILE)
}

function isItem(value: unknown): value is ChatQueueItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.chatId === 'string' && typeof item.text === 'string' && typeof item.queuedAt === 'number'
}

function load(path: string): ChatQueueItem[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown }
    return Array.isArray(parsed.items) ? parsed.items.filter(isItem) : []
  } catch {
    return []
  }
}

export function createChatQueue(path: string): ChatQueue {
  let items = load(path)
  let writes = Promise.resolve()

  const save = (): Promise<void> => {
    const snapshot = { items }
    const write = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await atomicJson(path, snapshot)
    })
    writes = write.catch((error) => console.error('chat queue write failed', error))
    return write
  }

  const ofChat = (chatId: string) => items.filter((item) => item.chatId === chatId)

  return {
    list: ofChat,
    async add(chatId, text) {
      const item = { id: crypto.randomUUID(), chatId, text, queuedAt: Date.now() }
      items = [...items, item]
      await save()
      return item
    },
    async remove(chatId, id) {
      const rest = items.filter((item) => item.chatId !== chatId || item.id !== id)
      if (rest.length === items.length) return false
      items = rest
      await save()
      return true
    },
    async take(chatId) {
      const taken = ofChat(chatId)
      if (taken.length === 0) return []
      items = items.filter((item) => item.chatId !== chatId)
      await save()
      return taken
    },
    async restore(chatId, restored) {
      if (restored.length === 0) return
      items = [...restored.map((item) => ({ ...item, chatId })), ...items]
      await save()
    },
    chats: () => [...new Set(items.map((item) => item.chatId))],
  }
}
