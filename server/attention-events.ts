import { attentionKey, chatOfJob, type AttentionStore } from './attention'
import type { JobRecord } from './jobs'

export function attentionEvents(store: AttentionStore) {
  return {
    slow: async (record: JobRecord): Promise<void> => {
      const minutes = Math.floor(((record.slowAt ?? Date.now()) - record.startedAt) / 60_000)
      console.error(`job slow: ${record.label} · ${record.turns} turns · ${minutes} min`.replace(/[\r\n]+/g, ' '))
      await store.raise({ key: attentionKey.loop(record.id), kind: 'loop', title: record.label, detail: `May be stuck: ${record.turns} turns in ${minutes} min`, command: null, chatId: chatOfJob(record), jobId: record.id, requestId: null })
    },
    needsYou: async (root: JobRecord, detail: string): Promise<void> => {
      await store.raise({ key: attentionKey.needs(root.id), kind: 'needs', title: root.label, detail, command: null, chatId: root.id, jobId: null, requestId: null })
    },
    started: async (record: JobRecord): Promise<void> => {
      const chat = chatOfJob(record)
      if (chat === null || (record.purpose === 'chat' && record.source === 'agent')) return
      await store.resolve(attentionKey.needs(chat))
    },
    settled: async (record: JobRecord): Promise<void> => {
      await store.resolveWhere(item => item.jobId === record.id && item.kind !== 'needs')
    },
  }
}
