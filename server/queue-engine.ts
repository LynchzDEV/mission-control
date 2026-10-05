import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

import { SESSION_CONTEXT_DIR, type TaskContext } from './plugins/context-files'
import { answersMarkdown, branchLabel, questionsOf, runRequest, SETTLED, type RunView } from './queue-prompts'
import type { QueueSource, SourceReplies, SourceReply } from './queue-source'
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
  remove(id: string): Promise<void>
  move(id: string, to: number): Promise<void>
  checkReplies(): Promise<{ checked: number; resumed: number }>
}

const MAX_RUN_LABEL = 120
const REQUEUEABLE: ReadonlySet<QueueItem['state']> = new Set(['failed', 'ready', 'waiting-info'])
const RETRIED_FROM = REQUEUEABLE
const MAX_REPLY_FAILURES = 3
const MAX_IMAGE_BYTES = 3_932_160

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class QueueRefusal extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = 'QueueRefusal'
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
    const failed = await store.update(item.id, { state: 'failed', error: reason, currentRunId: null })
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
    const ready = await store.update(item.id, { state: 'ready', currentRunId: null, error: null })
    deps.needsYou(ready, 'Built and ready for review')
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

async function readCapped(handle: FileHandle, candidate: string): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1)
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  if (filled > MAX_IMAGE_BYTES) throw new Error(`image over ${MAX_IMAGE_BYTES} bytes: ${candidate}`)
  return buffer.subarray(0, filled)
}

async function readInsideFile(realBase: string, candidate: string): Promise<Buffer> {
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`not a single-link regular file: ${candidate}`)
    if (opened.size > MAX_IMAGE_BYTES) throw new Error(`image over ${MAX_IMAGE_BYTES} bytes: ${candidate}`)
    const real = await realpath(candidate)
    if (!real.startsWith(realBase + sep)) throw new Error(`outside the plugin folder: ${candidate}`)
    const named = await lstat(real)
    if (!named.isFile() || named.nlink !== 1 || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error(`changed while checking: ${candidate}`)
    return await readCapped(handle, candidate)
  } finally {
    await handle.close()
  }
}

async function clearTarget(to: string): Promise<void> {
  const existing = await lstat(to).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing === null) return
  if (!existing.isFile()) throw new Error(`not a regular file at the copy target: ${to}`)
  await unlink(to)
}

async function writePrivate(to: string, bytes: Buffer): Promise<void> {
  await clearTarget(to)
  const handle = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
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
        await writePrivate(to, await readInsideFile(base, resolve(base, image.path)))
        copied.push(to)
      } catch (error) {
        console.error('queue image skipped', error)
      }
    }
  }
  return copied
}

function failureCounter(deps: QueueEngineDeps, reason: string) {
  const counts = new Map<string, number>()
  return {
    clear: (id: string) => { counts.delete(id) },
    record(item: QueueItem, error: unknown): void {
      const failures = (counts.get(item.id) ?? 0) + 1
      counts.set(item.id, failures % MAX_REPLY_FAILURES)
      if (failures === MAX_REPLY_FAILURES) deps.needsYou(deps.store.get(item.id) ?? item, `${reason}: ${message(error)}`)
    },
  }
}

type ReplyCheck = {
  read(item: QueueItem): Promise<SourceReplies | null>
  apply(item: QueueItem, worktree: string, result: SourceReplies): Promise<boolean>
}

function replyCheck(deps: QueueEngineDeps): ReplyCheck {
  const { store } = deps
  const readFailures = failureCounter(deps, 'Could not read replies')
  const saveFailures = failureCounter(deps, 'Could not save the replies')

  async function resume(item: QueueItem, worktree: string, replies: SourceReply[], lastId: string | null): Promise<void> {
    const folder = join(worktree, SESSION_CONTEXT_DIR, 'context', item.source)
    const images = await importImages(deps.pluginFiles(item.source), replies, folder)
    const path = await deps.writeContext(item.source, { name: `answers-${item.externalId}`, markdown: answersMarkdown(item.questions, replies, images) }, worktree)
    await store.update(item.id, { state: 'queued', answerPaths: [...item.answerPaths, path], questions: [], lastSeenId: lastId ?? item.lastSeenId })
    await store.toFront(item.id)
  }

  async function read(item: QueueItem): Promise<SourceReplies | null> {
    try {
      const result = await deps.source(item.source).replies({ id: item.externalId, sinceId: item.lastSeenId })
      readFailures.clear(item.id)
      return result
    } catch (error) {
      readFailures.record(item, error)
      return null
    }
  }

  async function apply(item: QueueItem, worktree: string, result: SourceReplies): Promise<boolean> {
    if (result.replies.length === 0) return false
    try {
      await resume(item, worktree, result.replies, result.lastId)
      saveFailures.clear(item.id)
      return true
    } catch (error) {
      console.error('queue resume failed', error)
      saveFailures.record(item, error)
      return false
    }
  }

  return { read, apply }
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
    const detail = await deps.source(input.source).item({ id: input.externalId })
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

  const replies = replyCheck(deps)
  const stillWaiting = (read: QueueItem): { item: QueueItem; worktree: string } | undefined => {
    const item = store.get(read.id)
    if (item?.state !== 'waiting-info' || item.lastSeenId !== read.lastSeenId || item.worktree === null) return undefined
    return { item, worktree: item.worktree }
  }

  const checkReplies = async (): Promise<{ checked: number; resumed: number }> => {
    const waiting = store.list().filter(item => item.state === 'waiting-info' && item.worktree !== null)
    const reads = await Promise.allSettled(waiting.map(item => replies.read(item)))
    return serial(async () => {
      let resumed = 0
      for (const [index, read] of reads.entries()) {
        const current = stillWaiting(waiting[index]!)
        if (read.status !== 'fulfilled' || read.value === null || current === undefined) continue
        if (await replies.apply(current.item, current.worktree, read.value)) resumed += 1
      }
      await startNext()
      return { checked: waiting.length, resumed }
    })
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
  }
}
