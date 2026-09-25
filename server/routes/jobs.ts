import { watch } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'

import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { parseActivity } from '../activity'
import type { ChatJobPatch, CreateJobParams, JobManager, JobRecord } from '../jobs'
import { readLogSince, readLogTail } from '../jobs'
import { readConfig } from '../secrets'
import { createSecretsRedactor, logSecrets, readRedactedLog, redactedTailReader } from '../log-redaction'
import { projectMemory } from '../chat-reports'
import { notifyChat } from '../notify'
import { chatHome } from '../chat-home'
import { validateWorkspaceCwd } from '../workspace'
import type { EngineResolver } from '../jobs-engine-iface'
import { engineSupportsResume } from '../jobs-engine-iface'
import { MAX_MODEL_LENGTH } from '../engines'
import { lintSpec } from '../spec-lint'
import { readRoles } from './roles'
import { assembleThread, replySessionId, threadChain, threadIsRunning, threadRootOf } from '../threads'

export const SSE_TAIL_BYTES = 4096
export const HEARTBEAT_MS = 15_000
export const ACTIVITY_FEED_MAX = 50
export const CHAT_TITLE_MAX = 60
export const SPAWN_REASON_MAX = 200

type Failure = { status: number; error: string }

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value
}

async function realHome(): Promise<string> {
  try {
    return await realpath(homedir())
  } catch {
    return homedir()
  }
}

function isChatRoot(job: JobRecord | undefined): job is JobRecord {
  return job !== undefined && job.purpose === 'chat' && threadRootOf(job) === job.id
}

async function chatMemory(manager: JobManager, project: string | null | undefined, rootId: string): Promise<Pick<CreateJobParams, 'memory'>> {
  if (!project) return {}
  const read = await redactedTailReader()
  return { memory: await projectMemory(manager.listJobs(), project, rootId, (id) => read(manager.logPath(id))) }
}

function chatTitle(prompt: string): string {
  return (prompt.split('\n')[0] ?? '').trim().slice(0, CHAT_TITLE_MAX)
}

async function projectInChatHome(path: string, root: JobRecord): Promise<string | Failure> {
  const home = await realHome()
  const check = await validateWorkspaceCwd(path, home)
  if (!check.ok) return { status: 400, error: check.error }
  const chat = chatHome(await readConfig(), [root.cwd], home)
  if (!chat.ok || (check.path !== chat.path && !check.path.startsWith(`${chat.path}/`))) {
    return { status: 400, error: 'project must be inside Chat home' }
  }
  return check.path
}

function chatSpawnFields(payload: Record<string, unknown>, manager: JobManager): Pick<CreateJobParams, 'chatId' | 'chatTurn' | 'reason' | 'reviewOf'> | Failure {
  const { chat, chatTurn, reason, reviewOf } = payload
  if (chat !== undefined && (typeof chat !== 'string' || !isChatRoot(manager.getJob(chat)))) return { status: 400, error: 'chat not found' }
  if (reviewOf !== undefined && (typeof reviewOf !== 'string' || manager.getJob(reviewOf) === undefined)) return { status: 400, error: 'reviewOf must name an existing job' }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > SPAWN_REASON_MAX)) return { status: 400, error: `reason must be at most ${SPAWN_REASON_MAX} characters` }
  return {
    ...(typeof chat === 'string' ? { chatId: chat } : {}),
    ...(typeof chatTurn === 'string' && chatTurn !== '' ? { chatTurn } : {}),
    ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
    ...(typeof reviewOf === 'string' ? { reviewOf } : {}),
  }
}

async function chatRootFields(payload: Record<string, unknown>): Promise<Pick<CreateJobParams, 'purpose' | 'edit' | 'project'> | Failure> {
  if (payload.purpose !== 'chat') return {}
  if (!engineSupportsResume(payload.engine as string)) return { status: 400, error: 'chat needs an AI that can resume a conversation' }
  if (typeof payload.project !== 'string') return { purpose: 'chat', edit: payload.edit === true }
  const check = await validateWorkspaceCwd(payload.project, await realHome())
  if (!check.ok) return { status: 400, error: check.error }
  return { purpose: 'chat', edit: payload.edit === true, project: check.path }
}

function chatPatch(body: Record<string, unknown>, root: JobRecord): ChatJobPatch | Failure {
  const patch: ChatJobPatch = {}
  if (body.titleLocked !== undefined) {
    if (typeof body.titleLocked !== 'boolean') return { status: 400, error: 'titleLocked must be a boolean' }
    patch.titleLocked = body.titleLocked
  }
  if (body.label !== undefined) {
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label === '' || label.length > CHAT_TITLE_MAX) return { status: 400, error: `label must be 1-${CHAT_TITLE_MAX} characters` }
    if (body.titleLocked !== undefined || root.titleLocked !== true) patch.label = label
  }
  return patch
}

function formatSSEData(content: string): string {
  return `${content
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`
}

export function safeEnqueue<T>(
  controller: { enqueue(chunk: T): void },
  isClosed: () => boolean,
  chunk: T,
): void {
  if (isClosed()) return
  try {
    controller.enqueue(chunk)
  } catch {
    // controller was torn down between the guard check and this call
  }
}

function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  }
}

export function createLogStreamResponse(path: string, signal: AbortSignal, secrets: ReadonlyArray<string | null> = []): Response {
  const encoder = new TextEncoder()
  const redactor = createSecretsRedactor(secrets)
  let watcher: ReturnType<typeof watch> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let offset = 0
  let closed = false

  function cleanup(): void {
    if (closed) return
    closed = true
    watcher?.close()
    if (heartbeat !== null) clearInterval(heartbeat)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const initial = await readLogTail(path, SSE_TAIL_BYTES)
      offset = initial.offset
      const initialText = redactor.redact(initial.content)
      if (initialText !== '') controller.enqueue(encoder.encode(formatSSEData(initialText)))

      const pushUpdates = async (): Promise<void> => {
        if (closed) return
        const chunk = await readLogSince(path, offset)
        if (closed || chunk.content === '') return
        offset = chunk.offset
        const text = redactor.redact(chunk.content)
        if (text === '') return
        safeEnqueue(controller, () => closed, encoder.encode(formatSSEData(text)))
      }

      try {
        watcher = watch(path, { persistent: false }, () => void pushUpdates())
      } catch {
        watcher = null
      }

      heartbeat = setInterval(() => {
        if (closed) return
        controller.enqueue(encoder.encode(': heartbeat\n\n'))
      }, HEARTBEAT_MS)

      signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {
          // stream already closed by the client disconnecting first
        }
      })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, { headers: sseHeaders() })
}

export type JobsRoutesOptions = { notify?: (title: string, body: string) => Promise<void> }

export function jobsRoutes(manager: JobManager, resolver: EngineResolver, options: JobsRoutesOptions = {}): Elysia {
  const notify = options.notify ?? notifyChat
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .post('/api/jobs', async ({ body, set }) => {
      const payload = body as (Partial<CreateJobParams> & Record<string, unknown>) | null
      const isChat = payload?.purpose === 'chat'
      if (
        typeof payload?.engine !== 'string' ||
        typeof payload.cwd !== 'string' ||
        typeof payload.prompt !== 'string' ||
        (typeof payload.label !== 'string' && !isChat)
      ) {
        set.status = 400
        return { error: 'engine, cwd, prompt, and label are required' }
      }
      const label = typeof payload.label === 'string' && (payload.label !== '' || !isChat) ? payload.label : chatTitle(payload.prompt)

      const chatRoot = await chatRootFields(payload)
      if (isFailure(chatRoot)) {
        set.status = chatRoot.status
        return { error: chatRoot.error }
      }
      const chatSpawn = chatSpawnFields(payload, manager)
      if (isFailure(chatSpawn)) {
        set.status = chatSpawn.status
        return { error: chatSpawn.error }
      }

      const model = typeof payload?.model === 'string' && payload.model !== '' ? payload.model : undefined
      if (model !== undefined && model.length > MAX_MODEL_LENGTH) {
        set.status = 400
        return { error: 'model too long' }
      }

      if (!isChat && payload.engine === (await readRoles()).execute.engine) {
        const misses = lintSpec(payload.prompt)
        if (misses.length > 0) {
          set.status = 422
          return { error: 'spec lint failed: the execute engine only takes an execution plan', misses }
        }
      }

      const result = await manager.createJob(
        {
          engine: payload.engine,
          cwd: payload.cwd,
          prompt: payload.prompt,
          label,
          worktree: payload.worktree === true,
          ...(typeof payload.terminalId === 'string' ? { terminalId: payload.terminalId } : {}),
          ...(model === undefined ? {} : { model }),
          ...chatRoot,
          ...chatSpawn,
          ...(chatRoot.purpose === 'chat' ? await chatMemory(manager, chatRoot.project, '') : {}),
        },
        resolver,
      )
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .get('/api/jobs', ({ query }) => {
      const chat = typeof query.chat === 'string' && query.chat !== '' ? query.chat : null
      const jobs = chat === null ? manager.listJobs() : manager.listJobs().filter((job) => job.chatId === chat || job.threadRoot === chat)
      return { jobs: jobs.map((job) => ({ ...job, currentActivity: manager.currentActivity(job.id) })) }
    })
    .patch('/api/jobs/:id', async ({ params, body, set }) => {
      const root = manager.getJob(params.id)
      if (!isChatRoot(root)) {
        set.status = 404
        return { error: 'chat not found' }
      }
      const payload = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
      const patch = chatPatch(payload, root)
      if (isFailure(patch)) {
        set.status = patch.status
        return { error: patch.error }
      }
      if (payload.project === null) patch.project = null
      else if (payload.project !== undefined) {
        const project = typeof payload.project === 'string' ? await projectInChatHome(payload.project, root) : { status: 400, error: 'project must be a path' }
        if (isFailure(project)) {
          set.status = project.status
          return { error: project.error }
        }
        patch.project = project
      }
      return await manager.updateJob(root.id, patch)
    })
    .get('/api/jobs/:id/activity', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const events = parseActivity(await readRedactedLog(manager.logPath(params.id)), ACTIVITY_FEED_MAX)
      return { status: job.status, currentActivity: manager.currentActivity(params.id), events }
    })
    .get('/api/jobs/:id/log', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const content = await readRedactedLog(manager.logPath(params.id))
      return new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    })
    .get('/api/jobs/:id/stream', async ({ params, set, request }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      return createLogStreamResponse(manager.logPath(params.id), request.signal, await logSecrets())
    })
    .get('/api/jobs/:id/thread', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const rootId = threadRootOf(job)
      const chain = threadChain(manager.listJobs(), rootId)
      const messages = await assembleThread(chain, (jobId) => readRedactedLog(manager.logPath(jobId)))
      return {
        rootId,
        engine: job.engine,
        running: threadIsRunning(chain),
        sessionId: replySessionId(chain),
        canReply: !job.workflowRunId && job.purpose !== 'workflow-design' && (job.resumeSupported ?? engineSupportsResume(job.engine)) && replySessionId(chain) !== null,
        messages,
      }
    })
    .post('/api/jobs/:id/reply', async ({ params, body, set }) => {
      const payload = body as { message?: unknown; source?: unknown } | null
      const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
      if (message === '') {
        set.status = 400
        return { error: 'message is required' }
      }

      const parent = manager.getJob(params.id)
      if (parent === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      if (parent.workflowRunId || parent.purpose === 'workflow-design') {
        set.status = 409
        return { error: 'Use Studio to retry this workflow step with its pinned instructions' }
      }
      if (!(parent.resumeSupported ?? engineSupportsResume(parent.engine))) {
        set.status = 400
        return { error: 'engine does not support conversation resume' }
      }

      const rootId = threadRootOf(parent)
      const chain = threadChain(manager.listJobs(), rootId)
      const sessionId = replySessionId(chain)
      if (sessionId === null) {
        set.status = 400
        return { error: 'job has no session id to resume yet' }
      }

      const chatRoot = parent.purpose === 'chat' ? manager.getJob(rootId) : undefined
      const result = await manager.createJob(
        {
          ...(parent.purpose === 'chat' ? {
            purpose: 'chat' as const,
            source: payload?.source === 'agent' ? 'agent' as const : 'user' as const,
            edit: chatRoot?.edit ?? parent.edit ?? false,
            project: chatRoot?.project ?? null,
            ...await chatMemory(manager, chatRoot?.project, rootId),
          } : {}),
          engine: parent.engine,
          cwd: parent.cwd,
          prompt: message,
          label: parent.label,
          parentJobId: parent.id,
          threadRoot: rootId,
          resumeSessionId: sessionId,
          ...(parent.terminalId === null ? {} : { terminalId: parent.terminalId }),
          ...(parent.model === null ? {} : { model: parent.model }),
        },
        resolver,
      )
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .post('/api/jobs/:id/land', async ({ params, set }) => {
      const result = await manager.landJob(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error, ...(result.files === undefined ? {} : { files: result.files }) }
      }
      const landed = manager.getJob(params.id)
      if (landed?.chatId) void notify('Landed', `${landed.label} · ${result.landed.length} commit${result.landed.length === 1 ? '' : 's'}`).catch(() => {})
      return { landed: result.landed, base: result.base }
    })
    .post('/api/jobs/:id/reviewed', async ({ params, set }) => {
      const result = await manager.markReviewed(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .post('/api/jobs/:id/kill', async ({ params, set }) => {
      const result = await manager.killJob(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return { ok: true }
    })
}
