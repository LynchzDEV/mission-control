import { parseThread, type ActivityEvent, type PermissionState } from './activity'
import type { JobRecord } from './jobs'

export type ThreadMessagePermission = {
  requestId: string
  toolName: string
  title: string
  description: string
  command: string | null
  target: string | null
  plan: string | null
  suppressAlways: boolean
  state: PermissionState
}

export type ThreadMessage =
  | { role: 'user'; kind: 'prompt'; jobId: string; ts: number; text: string; images?: string[] }
  | { role: 'assistant'; kind: 'thinking'; jobId: string; text: string; partial?: true }
  | { role: 'assistant'; kind: 'text'; jobId: string; text: string; partial?: true }
  | {
      role: 'assistant'
      kind: 'tool'
      jobId: string
      title: string
      detail: string
      input: string
      result: string
      resultIsError: boolean
      toolUseId: string
      undone: boolean
    }
  | { role: 'assistant'; kind: 'permission'; jobId: string } & ThreadMessagePermission
  | { role: 'result'; kind: 'result'; jobId: string; text: string; isError: boolean }

export function threadRootOf(job: JobRecord): string {
  return job.threadRoot === '' ? job.id : job.threadRoot
}

// Ordering by root + startedAt rather than walking parentJobId links keeps the chain total: a reply
// whose parent record is missing still renders, and sibling replies interleave chronologically.
export function threadChain(jobs: readonly JobRecord[], rootId: string): JobRecord[] {
  return jobs
    .filter((job) => threadRootOf(job) === rootId)
    .sort((left, right) => left.startedAt - right.startedAt)
}

export function eventToMessage(event: ActivityEvent, jobId: string): ThreadMessage | null {
  if (event.kind === 'tool') {
    return {
      role: 'assistant',
      kind: 'tool',
      jobId,
      title: event.title,
      detail: event.detail,
      input: event.input ?? '',
      result: event.result ?? '',
      resultIsError: event.resultIsError === true,
      toolUseId: event.toolUseId ?? '',
      undone: false,
    }
  }
  if (event.kind === 'permission') {
    return {
      role: 'assistant',
      kind: 'permission',
      jobId,
      requestId: event.requestId ?? '',
      toolName: event.toolName ?? '',
      title: event.title,
      description: event.detail,
      command: event.command ?? null,
      target: event.target ?? null,
      plan: event.plan ?? null,
      suppressAlways: event.suppressAlways === true,
      state: event.state ?? 'pending',
    }
  }
  if (event.kind === 'thinking') return { role: 'assistant', kind: 'thinking', jobId, text: event.detail, ...(event.partial ? { partial: true } : {}) }
  if (event.kind === 'text') return { role: 'assistant', kind: 'text', jobId, text: event.detail, ...(event.partial ? { partial: true } : {}) }
  if (event.kind === 'result') {
    return { role: 'result', kind: 'result', jobId, text: event.detail, isError: false }
  }
  if (event.kind === 'error') {
    return { role: 'result', kind: 'result', jobId, text: event.detail, isError: true }
  }
  return null
}

const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

export function jobMessages(job: JobRecord, log: string): ThreadMessage[] {
  const turn: ThreadMessage[] = [
    { role: 'user', kind: 'prompt', jobId: job.id, ts: job.startedAt, text: job.prompt, ...(job.images && job.images.length > 0 ? { images: job.images.map((image) => baseName(image.path)) } : {}) },
  ]
  for (const event of parseThread(log)) {
    const message = eventToMessage(event, job.id)
    if (message !== null) turn.push(message)
  }
  if (job.status === 'running') return turn
  return turn.map((message) => {
    if (message.kind === 'permission' && message.state === 'pending') return { ...message, state: 'cancelled' as const }
    if (message.kind === 'tool' && message.toolUseId !== '' && (job.undone ?? []).includes(message.toolUseId)) return { ...message, undone: true }
    return message
  })
}

export async function assembleThread(
  chain: readonly JobRecord[],
  readLog: (jobId: string) => Promise<string>,
): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = []
  for (const job of chain) {
    messages.push(...jobMessages(job, await readLog(job.id)))
  }
  return messages
}

export function threadIsRunning(chain: readonly JobRecord[]): boolean {
  return chain.some((job) => job.status === 'running')
}

export function replySessionId(chain: readonly JobRecord[]): string | null {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const found = chain[index]?.sessionId
    if (found !== undefined && found !== null && found !== '') return found
  }
  return null
}
