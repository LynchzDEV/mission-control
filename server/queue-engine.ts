import type { TaskContext } from './plugins/context-files'
import { branchLabel, questionsOf, runRequest, SETTLED, type RunView } from './queue-prompts'
import type { QueueSource } from './queue-source'
import type { QueueItem, QueueStore } from './queue-store'

export type QueueRunner = {
  start(input: { cwd: string; request: string; label: string; workflowId?: string }, context: { startedByUser: boolean }): Promise<{ id: string }>
  get(id: string): RunView | undefined
}

export type QueueEngineDeps = {
  store: QueueStore
  runner: QueueRunner
  source(pluginId: string): QueueSource
  prepareWorktree(repo: string, label: string): Promise<{ worktree: string }>
  writeContext(pluginId: string, context: TaskContext, cwd: string): Promise<string>
  pluginFiles(pluginId: string): string
  needsYou(item: QueueItem, reason: string): void
}

export type AddInput = { source: string; externalId: string; repo: string; flowId?: string | null; position?: 'end' | 'next' }

export type QueueEngine = {
  add(input: AddInput): Promise<QueueItem>
  kick(): Promise<void>
  onRunSettled(run: RunView): Promise<void>
  recover(): Promise<void>
  requeue(id: string): Promise<QueueItem>
  checkReplies(): Promise<{ checked: number; resumed: number }>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function queueSteps(deps: QueueEngineDeps) {
  const { store } = deps

  async function fail(item: QueueItem, reason: string): Promise<void> {
    await store.update(item.id, { state: 'failed', error: reason, currentRunId: null })
    deps.needsYou(item, reason)
  }

  async function settle(run: RunView): Promise<void> {
    const item = store.list().find(entry => entry.state === 'building' && entry.currentRunId === run.id)
    if (item === undefined || !SETTLED.has(run.status)) return
    if (run.status === 'done') {
      await store.update(item.id, { state: 'ready', currentRunId: null, error: null })
      deps.needsYou(item, 'Built and ready for review')
      return
    }
    const questions = questionsOf(run)
    if (questions.length === 0) return fail(item, run.error ?? `Run ${run.status}`)
    try {
      const posted = await deps.source(item.source).post({ id: item.externalId, kind: 'ask', lines: questions })
      await store.update(item.id, { state: 'waiting-info', questions, lastSeenId: posted.commentId, currentRunId: null })
    } catch (error) {
      await fail(item, `Could not post the questions: ${message(error)}`)
    }
  }

  async function build(item: QueueItem): Promise<void> {
    const { worktree } = item.worktree !== null ? { worktree: item.worktree } : await deps.prepareWorktree(item.repo, branchLabel(item))
    const contextPath = item.contextPath ?? await deps.writeContext(item.source, { name: `item-${item.externalId}`, markdown: (await deps.source(item.source).item({ id: item.externalId })).contextMarkdown }, worktree)
    const ready = { ...item, worktree, contextPath }
    const run = await deps.runner.start({ cwd: worktree, request: runRequest(ready), label: item.title.slice(0, 120), ...(item.flowId ? { workflowId: item.flowId } : {}) }, { startedByUser: true })
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

  async function add(input: AddInput): Promise<QueueItem> {
    const detail = await deps.source(input.source).item({ id: input.externalId })
    const item = await store.add({ source: input.source, externalId: input.externalId, title: detail.title, url: detail.url, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end')
    await serial(startNext)
    return store.get(item.id) ?? item
  }

  async function requeue(id: string): Promise<QueueItem> {
    if (store.get(id) === undefined) throw new Error(`No queue item ${id}`)
    await store.update(id, { state: 'queued', error: null, currentRunId: null })
    await store.move(id, store.list().length)
    await serial(startNext)
    return store.get(id)!
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
    recover,
    kick: () => serial(startNext),
    onRunSettled: run => serial(async () => { await settle(run); await startNext() }),
    checkReplies: async () => ({ checked: 0, resumed: 0 }),
  }
}
