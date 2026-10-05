import type { TaskContext } from './plugins/context-files'
import { branchLabel, questionsOf, runRequest, SETTLED, type RunView } from './queue-prompts'
import { message, replyCheck } from './queue-replies'
import type { QueueSource } from './queue-source'
import type { QueueItem, QueueStore } from './queue-store'
import { fileExists, worktreeRestorer } from './queue-worktree'

export type QueueRunner = {
  start(input: { cwd: string; request: string; label: string; workflowId?: string }, context: { startedByUser: boolean }): Promise<{ id: string }>
  get(id: string): RunView | undefined
}

export type QueueEngineDeps = {
  store: QueueStore
  runner: QueueRunner
  source(pluginId: string): QueueSource
  prepareWorktree(repo: string, label: string): Promise<{ worktree: string }>
  isWorktree?(repo: string, worktree: string): Promise<boolean>
  writeContext(pluginId: string, context: TaskContext, cwd: string): Promise<string>
  pluginFiles(pluginId: string): string
  needsYou(item: QueueItem, reason: string): void
  now?: () => number
}

export type AddInput = { source: string; externalId: string; repo: string; flowId?: string | null; position?: 'end' | 'next' }

export type QueueEngine = {
  add(input: AddInput): Promise<QueueItem>
  kick(): Promise<void>
  onRunSettled(run: RunView): Promise<void>
  recover(): Promise<void>
  requeue(id: string): Promise<QueueItem>
  remove(id: string): Promise<void>
  move(id: string, to: number): Promise<void>
  checkReplies(): Promise<{ checked: number; resumed: number }>
  checkedAt(): number | null
  subscribeChecks(listener: () => void): () => void
}

const MAX_RUN_LABEL = 120
const REQUEUEABLE: ReadonlySet<QueueItem['state']> = new Set(['failed', 'ready', 'waiting-info'])
const RETRIED_FROM = REQUEUEABLE

export class QueueRefusal extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'QueueRefusal'
  }
}

export class SourceFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceFailure'
  }
}

async function fromSource<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new SourceFailure(message(error))
  }
}

const stateRefusal = (state: QueueItem['state']): QueueRefusal => new QueueRefusal(`It is ${state} now`, 409)

function found(store: QueueStore, id: string): QueueItem {
  const item = store.get(id)
  if (item === undefined) throw new QueueRefusal(`No queue item ${id}`, 404)
  return item
}

type QueueSteps = {
  fail(item: QueueItem, reason: string): Promise<void>
  settle(run: RunView): Promise<void>
  startNext(): Promise<void>
}

function queueSteps(deps: QueueEngineDeps): QueueSteps {
  const { store } = deps

  async function fail(item: QueueItem, reason: string): Promise<void> {
    const failed = await store.update(item.id, { state: 'failed', error: reason, currentRunId: null, questions: [] })
    deps.needsYou(failed, reason)
  }

  const applied = new Map<string, string>()
  const fingerprint = (run: RunView): string => JSON.stringify([run.status, run.error, run.attempts.length, run.attempts.at(-1)?.endedAt ?? null])

  function settling(run: RunView): QueueItem | undefined {
    const items = store.list()
    const building = items.find(entry => entry.state === 'building' && entry.currentRunId === run.id)
    if (building !== undefined) return building
    if (applied.get(run.id) === fingerprint(run)) return undefined
    return items.find(entry => RETRIED_FROM.has(entry.state) && entry.runIds.at(-1) === run.id)
  }

  async function askOrFail(item: QueueItem, run: RunView): Promise<void> {
    const questions = questionsOf(run)
    if (questions.length === 0) return fail(item, run.error ?? `Run ${run.status}`)
    try {
      const posted = await deps.source(item.source).post({ id: item.externalId, kind: 'ask', lines: questions })
      await store.update(item.id, { state: 'waiting-info', questions, lastSeenId: item.lastSeenId ?? posted.commentId, currentRunId: null })
    } catch (error) {
      await fail(item, `Could not post the questions: ${message(error)}`)
    }
  }

  async function settle(run: RunView): Promise<void> {
    if (!SETTLED.has(run.status)) return
    const item = settling(run)
    if (item === undefined) return
    applied.set(run.id, fingerprint(run))
    if (run.status !== 'done') return askOrFail(item, run)
    const ready = await store.update(item.id, { state: 'ready', currentRunId: null, error: null, questions: [] })
    deps.needsYou(ready, 'Built and ready for review')
  }

  const restore = worktreeRestorer(deps)

  async function contextIn(item: QueueItem, worktree: string): Promise<string> {
    if (item.contextPath !== null && await fileExists(item.contextPath)) return item.contextPath
    const detail = await deps.source(item.source).item({ id: item.externalId })
    return deps.writeContext(item.source, { name: `item-${item.externalId}`, markdown: detail.contextMarkdown }, worktree)
  }

  async function build(item: QueueItem): Promise<void> {
    const worktree = item.worktree === null ? (await deps.prepareWorktree(item.repo, branchLabel(item))).worktree : await restore({ ...item, worktree: item.worktree })
    const contextPath = await contextIn(item, worktree)
    const ready = { ...item, worktree, contextPath }
    const run = await deps.runner.start({ cwd: worktree, request: runRequest(ready), label: item.title.slice(0, MAX_RUN_LABEL), ...(item.flowId ? { workflowId: item.flowId } : {}) }, { startedByUser: true })
    await store.update(item.id, { state: 'building', worktree, contextPath, currentRunId: run.id, runIds: [...item.runIds, run.id], error: null })
    const now = deps.runner.get(run.id)
    if (now !== undefined && SETTLED.has(now.status)) await settle(now)
  }

  async function startNext(): Promise<void> {
    while (!store.list().some(item => item.state === 'building')) {
      const next = store.list().find(item => item.state === 'queued')
      if (next === undefined) return
      try { await build(next) } catch (error) { await fail(next, message(error)) }
    }
  }

  return { fail, settle, startNext }
}

export function createQueueEngine(deps: QueueEngineDeps): QueueEngine {
  const { store } = deps
  const { fail, settle, startNext } = queueSteps(deps)
  let lane: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lane.then(work)
    lane = result.catch(error => console.error('queue step failed', error))
    return result
  }

  const refuseDuplicate = (input: AddInput): void => {
    if (store.list().some(item => item.source === input.source && item.externalId === input.externalId)) throw new QueueRefusal('Already in the queue', 409)
  }

  async function add(input: AddInput): Promise<QueueItem> {
    refuseDuplicate(input)
    const detail = await fromSource(() => deps.source(input.source).item({ id: input.externalId }))
    refuseDuplicate(input)
    const item = await store.add({ source: input.source, externalId: input.externalId, title: detail.title, url: detail.url, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end')
    await serial(startNext)
    return store.get(item.id) ?? item
  }

  const runningInStudio = (item: QueueItem): boolean => {
    const lastRunId = item.runIds.at(-1)
    const run = lastRunId === undefined ? undefined : deps.runner.get(lastRunId)
    return run !== undefined && !SETTLED.has(run.status)
  }

  const requeue = (id: string): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (!REQUEUEABLE.has(item.state)) throw stateRefusal(item.state)
    if (runningInStudio(item)) throw new QueueRefusal('It is running in Studio now', 409)
    await store.update(id, { state: 'queued', error: null, currentRunId: null, questions: [] })
    await store.move(id, store.list().length)
    await startNext()
    return found(store, id)
  })

  const remove = (id: string): Promise<void> => serial(async () => {
    if (found(store, id).state === 'building') throw stateRefusal('building')
    await store.remove(id)
  })

  const move = (id: string, to: number): Promise<void> => serial(async () => {
    const item = found(store, id)
    if (item.state !== 'queued') throw stateRefusal(item.state)
    await store.move(id, to)
  })

  const replies = replyCheck(deps, fail)
  const stillWaiting = (read: QueueItem): { item: QueueItem; worktree: string } | undefined => {
    const item = store.get(read.id)
    if (item?.state !== 'waiting-info' || item.lastSeenId !== read.lastSeenId || item.worktree === null || runningInStudio(item)) return undefined
    return { item, worktree: item.worktree }
  }

  let lastCheckedAt: number | null = null
  const checkListeners = new Set<() => void>()
  const markChecked = (): void => {
    lastCheckedAt = (deps.now ?? Date.now)()
    for (const listener of checkListeners) listener()
  }

  const checkReplies = async (): Promise<{ checked: number; resumed: number }> => {
    const waiting = store.list().filter(item => item.state === 'waiting-info' && item.worktree !== null)
    const reads = await Promise.allSettled(waiting.map(item => runningInStudio(item) ? Promise.resolve(null) : replies.read(item)))
    return serial(async () => {
      let resumed = 0
      for (const [index, read] of reads.entries()) {
        const current = stillWaiting(waiting[index]!)
        if (read.status !== 'fulfilled' || read.value === null || current === undefined) continue
        if (await replies.apply(current.item, current.worktree, read.value)) resumed += 1
      }
      await startNext()
      return { checked: waiting.length, resumed }
    }).then((counts) => { markChecked(); return counts })
  }

  async function recover(): Promise<void> {
    await serial(async () => {
      for (const item of store.list().filter(entry => entry.state === 'building')) {
        const run = item.currentRunId === null ? undefined : deps.runner.get(item.currentRunId)
        if (run === undefined) await fail(item, 'Its run is gone')
        else if (SETTLED.has(run.status)) await settle(run)
      }
      await startNext()
    })
  }

  return {
    add,
    requeue,
    remove,
    move,
    recover,
    kick: () => serial(startNext),
    onRunSettled: run => serial(async () => { await settle(run); await startNext() }),
    checkReplies,
    checkedAt: () => lastCheckedAt,
    subscribeChecks: (listener) => { checkListeners.add(listener); return () => { checkListeners.delete(listener) } },
  }
}
