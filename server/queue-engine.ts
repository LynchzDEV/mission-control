import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

import { SESSION_CONTEXT_DIR, type TaskContext } from './plugins/context-files'
import { answersMarkdown, branchLabel, questionsOf, runRequest, SETTLED, type RunView } from './queue-prompts'
import type { QueueSource, SourceReply } from './queue-source'
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

const MAX_RUN_LABEL = 120
const REQUEUEABLE: ReadonlySet<QueueItem['state']> = new Set(['failed', 'ready'])
const MAX_REPLY_FAILURES = 3

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function found(store: QueueStore, id: string): QueueItem {
  const item = store.get(id)
  if (item === undefined) throw new Error(`No queue item ${id}`)
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
    const failed = await store.update(item.id, { state: 'failed', error: reason, currentRunId: null })
    deps.needsYou(failed, reason)
  }

  async function settle(run: RunView): Promise<void> {
    const item = store.list().find(entry => entry.state === 'building' && entry.currentRunId === run.id)
    if (item === undefined || !SETTLED.has(run.status)) return
    if (run.status === 'done') {
      const ready = await store.update(item.id, { state: 'ready', currentRunId: null, error: null })
      deps.needsYou(ready, 'Built and ready for review')
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

async function insideFile(realBase: string, candidate: string): Promise<string> {
  if (!(await lstat(candidate)).isFile()) throw new Error(`not a regular file: ${candidate}`)
  const real = await realpath(candidate)
  if (!real.startsWith(realBase + sep)) throw new Error(`outside the plugin folder: ${candidate}`)
  return real
}

async function importImages(root: string, replies: SourceReply[], folder: string): Promise<string[]> {
  const realBase = realpath(root)
  realBase.catch(() => undefined)
  const copied: string[] = []
  await mkdir(folder, { recursive: true, mode: 0o700 })
  for (const reply of replies) {
    for (const [index, image] of reply.images.entries()) {
      const to = join(folder, `${reply.id}-${index}-${basename(image.name)}`.replace(/[^A-Za-z0-9._-]/g, '-'))
      try {
        const base = await realBase
        await copyFile(await insideFile(base, resolve(base, image.path)), to)
        copied.push(to)
      } catch (error) {
        console.error('queue image skipped', error)
      }
    }
  }
  return copied
}

function replyCheck(deps: QueueEngineDeps): (item: QueueItem, worktree: string) => Promise<boolean> {
  const { store } = deps
  const replyFailures = new Map<string, number>()

  async function resume(item: QueueItem, worktree: string, replies: SourceReply[], lastId: string | null): Promise<void> {
    const folder = join(worktree, SESSION_CONTEXT_DIR, 'context', item.source)
    const images = await importImages(deps.pluginFiles(item.source), replies, folder)
    const path = await deps.writeContext(item.source, { name: `answers-${item.externalId}`, markdown: answersMarkdown(item.questions, replies, images) }, worktree)
    await store.update(item.id, { state: 'queued', answerPaths: [...item.answerPaths, path], questions: [], lastSeenId: lastId ?? item.lastSeenId })
    await store.toFront(item.id)
  }

  async function read(item: QueueItem) {
    try {
      const result = await deps.source(item.source).replies({ id: item.externalId, sinceId: item.lastSeenId })
      replyFailures.delete(item.id)
      return result
    } catch (error) {
      const failures = (replyFailures.get(item.id) ?? 0) + 1
      replyFailures.set(item.id, failures % MAX_REPLY_FAILURES)
      if (failures === MAX_REPLY_FAILURES) deps.needsYou(store.get(item.id) ?? item, `Could not read replies: ${message(error)}`)
      return null
    }
  }

  return async function checkOne(item: QueueItem, worktree: string): Promise<boolean> {
    const result = await read(item)
    if (result === null || result.replies.length === 0) return false
    try {
      await resume(item, worktree, result.replies, result.lastId)
      return true
    } catch (error) {
      console.error('queue resume failed', error)
      return false
    }
  }
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

  const requeue = (id: string): Promise<QueueItem> => serial(async () => {
    const item = found(store, id)
    if (!REQUEUEABLE.has(item.state)) throw new Error(`It is ${item.state} now`)
    await store.update(id, { state: 'queued', error: null, currentRunId: null })
    await store.move(id, store.list().length)
    await startNext()
    return found(store, id)
  })

  const checkOne = replyCheck(deps)
  const checkReplies = (): Promise<{ checked: number; resumed: number }> => serial(async () => {
    const waiting = store.list().flatMap(item => item.state === 'waiting-info' && item.worktree !== null ? [{ item, worktree: item.worktree }] : [])
    let resumed = 0
    for (const { item, worktree } of waiting) if (await checkOne(item, worktree)) resumed += 1
    await startNext()
    return { checked: waiting.length, resumed }
  })

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
    checkReplies,
  }
}
