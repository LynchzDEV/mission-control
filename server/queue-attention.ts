import { attentionKey, type AttentionStore } from './attention'
import type { QueueItem, QueueStore } from './queue-store'

const NEEDS_PERSON = new Set<QueueItem['state']>(['ready', 'failed', 'waiting-info'])

export function raiseQueueAlert(attention: AttentionStore, item: QueueItem, reason: string): Promise<void> {
  return attention.raise({ key: attentionKey.queue(item.id), kind: 'queue', title: item.title, detail: reason, command: null, chatId: null, jobId: null, requestId: null })
}

export function watchQueueAlerts(store: QueueStore, attention: AttentionStore): () => void {
  return store.subscribe(() => {
    void attention.resolveWhere(alert => {
      if (alert.kind !== 'queue') return false
      const item = store.get(alert.key.slice('queue:'.length))
      return item === undefined || !NEEDS_PERSON.has(item.state)
    })
  })
}
