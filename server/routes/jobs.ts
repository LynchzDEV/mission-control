import { watch } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { parseActivity } from '../activity'
import type { ChatJobPatch, CreateJobParams, JobManager, JobRecord } from '../jobs'
import { readLogSince, readLogTail } from '../jobs'
import { configDir, readConfig } from '../secrets'
import { activityRedactor, createSecretsRedactor, logSecrets, readRedactedLog, redactedTailReader } from '../log-redaction'
import { projectMemory } from '../chat-reports'
import type { ChatQueue } from '../chat-queue'
import { chatQueuePath, createChatQueue } from '../chat-queue'
import { attentionKey, type AttentionStore } from '../attention'
import { chatHome } from '../chat-home'
import { returnedOriginals } from '../drops'
import { validateWorkspaceCwd } from '../workspace'
import type { BridgeImage, BridgeImageMedia, ChatPermissionMode } from '../chat-bridge-core'
import type { EngineResolver } from '../jobs-engine-iface'
import { chatUsesBridge, engineSupportsResume } from '../jobs-engine-iface'
import { MAX_MODEL_LENGTH } from '../engines'
import { lintSpec } from '../spec-lint'
import { readRoles } from './roles'
import { assembleThread, replySessionId, threadChain, threadIsRunning, threadRootOf } from '../threads'

export const SSE_TAIL_BYTES = 4096
export const HEARTBEAT_MS = 15_000
export const ACTIVITY_FEED_MAX = 50
export const CHAT_TITLE_MAX = 60
export const SPAWN_REASON_MAX = 200
export const IMAGE_MAX_BYTES = 3_932_160
export const IMAGE_MAX_COUNT = 8
export const CHAT_PERMISSION_MODES = ['settings', 'ask', 'acceptEdits', 'plan', 'bypass'] as const

function imageMediaType(bytes: Uint8Array): BridgeImageMedia | null {
  const at = (index: number): number => bytes[index] ?? 0
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  return null
}

async function dropsRoot(): Promise<string | null> {
  try {
    return await realpath(join(configDir(), 'drops'))
  } catch {
    return null
  }
}

export type ChatImages = { images: BridgeImage[]; tokens: string[] } | Failure

export async function resolveChatImages(payload: Record<string, unknown>): Promise<ChatImages> {
  const raw = payload.images
  if (raw === undefined) return { images: [], tokens: [] }
  if (!Array.isArray(raw)) return { status: 400, error: 'images must be a list of paths' }
  if (raw.length > IMAGE_MAX_COUNT) return { status: 400, error: `An image list may hold at most ${IMAGE_MAX_COUNT} files` }
  const root = await dropsRoot()
  const images: BridgeImage[] = []
  const tokens: string[] = []
  for (const entry of raw) {
    const path = typeof entry === 'object' && entry !== null && typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : ''
    const bad = (reason: string): Failure => ({ status: 400, error: `Image ${path === '' ? 'file' : basename(path)} cannot be sent: ${reason}` })
    if (path === '') return bad('a path is required')
    let real: string
    try {
      real = await realpath(path)
    } catch {
      return bad('attach it again')
    }
    if (root === null || (real !== root && !real.startsWith(`${root}/`))) {
      if (!returnedOriginals.has(real)) return bad('attach it again')
    }
    const info = await stat(real).catch(() => null)
    if (info === null || !info.isFile()) return bad('attach it again')
    if (info.size > IMAGE_MAX_BYTES) return bad('it is larger than 3.75 MB')
    const mediaType = imageMediaType(new Uint8Array(await readFile(real).catch(() => new ArrayBuffer(0))))
    if (mediaType === null) return bad('it is not a PNG, JPEG, GIF or WebP image')
    images.push({ path: real, mediaType })
    for (const token of new Set([path, real])) tokens.push(token)
  }
  return { images, tokens }
}

export function stripImageTokens(text: string, tokens: readonly string[]): string {
  let next = text
  for (const token of tokens) {
    for (const form of [token, `'${token}'`, `"${token}"`]) {
      next = next.split(form).join('')
    }
  }
  return next.replace(/[ \t]{2,}/g, ' ').trim()
}

function chatPromptWithImages(payload: Record<string, unknown>, prompt: string, images: readonly BridgeImage[], tokens: readonly string[]): string {
  if (images.length === 0 || !chatUsesBridge(String(payload.engine ?? ''), payload.purpose === 'chat' ? 'chat' : undefined)) return prompt
  return stripImageTokens(prompt, tokens)
}

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
  const check = await validateWorkspaceCwd(path, home, { requireGit: false })
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
  const check = await validateWorkspaceCwd(payload.project, await realHome(), { requireGit: false })
  if (!check.ok) return { status: 400, error: check.error }
  return { purpose: 'chat', edit: payload.edit === true, project: check.path }
}

function chatPatch(body: Record<string, unknown>, root: JobRecord): ChatJobPatch | Failure {
  const patch: ChatJobPatch = {}
  if (body.titleLocked !== undefined) {
    if (body.titleLocked !== true) return { status: 400, error: 'titleLocked can only be set to true' }
    patch.titleLocked = true
  }
  if (body.label !== undefined) {
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label === '' || label.length > CHAT_TITLE_MAX) return { status: 400, error: `label must be 1-${CHAT_TITLE_MAX} characters` }
    if (body.titleLocked !== undefined || root.titleLocked !== true) patch.label = label
  }
  return patch
}

function logHasPendingPermission(log: string, requestId: string): boolean {
  let pending = false
  for (const line of log.split('\n')) {
    if (!line.includes('"mc_permission_request"') && !line.includes('"mc_permission_resolved"')) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed.type === 'mc_permission_request' && parsed.requestId === requestId) pending = true
    if (parsed.type === 'mc_permission_resolved' && parsed.requestId === requestId) pending = false
  }
  return pending
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

type TerminalSessions = { list(): Array<{ id: string; sessionId: string | null }>; ended(): Array<{ id: string; sessionId: string | null }> }
export type JobsRoutesOptions = { attention?: AttentionStore; queue?: ChatQueue; terminals?: TerminalSessions }

function terminalSessionIds(terminals: TerminalSessions | undefined): Map<string, string> {
  if (!terminals) return new Map()
  return new Map([...terminals.ended(), ...terminals.list()].flatMap((terminal) => (terminal.sessionId ? [[terminal.id, terminal.sessionId] as const] : [])))
}

export function jobsRoutes(manager: JobManager, resolver: EngineResolver, options: JobsRoutesOptions = {}): Elysia {
  const queue = options.queue ?? createChatQueue(chatQueuePath())
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

      let images: BridgeImage[] = []
      let imageTokens: string[] = []
      if (isChat && chatUsesBridge(payload.engine, 'chat')) {
        const resolved = await resolveChatImages(payload)
        if (isFailure(resolved)) {
          set.status = resolved.status
          return { error: resolved.error }
        }
        images = resolved.images
        imageTokens = resolved.tokens
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
          prompt: chatPromptWithImages(payload, payload.prompt, images, imageTokens),
          label,
          worktree: payload.worktree === true,
          ...(typeof payload.terminalId === 'string' ? { terminalId: payload.terminalId } : {}),
          ...(model === undefined ? {} : { model }),
          ...(images.length > 0 ? { images } : {}),
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
    .get('/api/jobs', async ({ query }) => {
      const chat = typeof query.chat === 'string' && query.chat !== '' ? query.chat : null
      const jobs = chat === null ? manager.listJobs() : manager.listJobs().filter((job) => job.chatId === chat || job.threadRoot === chat)
      const redact = await activityRedactor()
      const sessions = terminalSessionIds(options.terminals)
      return { jobs: jobs.map((job) => { const terminalSessionId = job.terminalId ? sessions.get(job.terminalId) : undefined; return { ...job, currentActivity: redact(manager.currentActivity(job.id)), ...(terminalSessionId ? { terminalSessionId } : {}) } }) }
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
      return { status: job.status, currentActivity: (await activityRedactor())(manager.currentActivity(params.id)), events }
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
      const payload = body as { message?: unknown } | null
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

      const threadHead = manager.getJob(rootId)
      const isChat = parent.purpose === 'chat' || threadHead?.purpose === 'chat'
      if (isChat && threadIsRunning(chain)) {
        const item = await queue.add(rootId, message)
        set.status = 202
        return { queued: true, item }
      }
      const chatRoot = isChat ? threadHead : undefined
      const earlier = isChat ? await queue.take(rootId) : []
      let replyImages: BridgeImage[] = []
      let replyTokens: string[] = []
      if (isChat && chatUsesBridge(parent.engine, 'chat')) {
        const resolved = await resolveChatImages(body as Record<string, unknown>)
        if (isFailure(resolved)) {
          set.status = resolved.status
          return { error: resolved.error }
        }
        replyImages = resolved.images
        replyTokens = resolved.tokens
      }
      const newest = chain[chain.length - 1]
      const payloadModel = typeof (body as { model?: unknown } | null)?.model === 'string' ? String((body as { model: string }).model).trim() : ''
      if (payloadModel.length > MAX_MODEL_LENGTH) {
        set.status = 400
        return { error: 'model too long' }
      }
      const payloadMode = (body as { permissionMode?: unknown } | null)?.permissionMode
      if (payloadMode !== undefined && !CHAT_PERMISSION_MODES.includes(payloadMode as ChatPermissionMode)) {
        set.status = 400
        return { error: 'permissionMode must be one of settings, ask, acceptEdits, plan or bypass' }
      }
      const model = payloadModel !== '' ? payloadModel : newest?.model ?? parent.model
      const permissionMode = isChat ? ((payloadMode as ChatPermissionMode | undefined) ?? newest?.permissionMode ?? 'settings') : (payloadMode as ChatPermissionMode | undefined)
      const result = await manager.createJob(
        {
          ...(isChat ? {
            purpose: 'chat' as const,
            edit: chatRoot?.edit ?? parent.edit ?? false,
            project: chatRoot?.project ?? null,
            ...await chatMemory(manager, chatRoot?.project, rootId),
          } : {}),
          engine: parent.engine,
          cwd: parent.cwd,
          prompt: replyImages.length > 0 ? stripImageTokens([...earlier.map((item) => item.text), message].join('\n\n'), replyTokens) : [...earlier.map((item) => item.text), message].join('\n\n'),
          label: parent.label,
          parentJobId: parent.id,
          threadRoot: rootId,
          resumeSessionId: sessionId,
          ...(parent.terminalId === null ? {} : { terminalId: parent.terminalId }),
          ...(model === null || model === undefined || model === '' ? {} : { model }),
          ...(permissionMode === undefined || permissionMode === null ? {} : { permissionMode }),
          ...(replyImages.length > 0 ? { images: replyImages } : {}),
          ...(parent.chatId ? { chatId: parent.chatId } : {}),
          ...(parent.chatTurn ? { chatTurn: parent.chatTurn } : {}),
          ...(parent.reason ? { reason: parent.reason } : {}),
        },
        resolver,
      )
      if (!result.ok) {
        await queue.restore(rootId, earlier)
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .get('/api/jobs/:id/images/:n', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      const index = Number(params.n)
      const image = job?.images?.[index]
      if (job === undefined || !Number.isInteger(index) || index < 0 || image === undefined) {
        set.status = 404
        return { error: 'image not found' }
      }
      const file = Bun.file(image.path)
      if (!(await file.exists())) {
        set.status = 404
        return { error: 'image not found' }
      }
      return new Response(file, { headers: { 'content-type': image.mediaType, 'cache-control': 'no-store' } })
    })
    .get('/api/jobs/:id/commands', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      let commands: Array<{ name: string; description: string; argumentHint: string }> = []
      for (const turn of threadChain(manager.listJobs(), threadRootOf(job))) {
        const log = await readRedactedLog(manager.logPath(turn.id))
        for (const line of log.split('\n')) {
          if (!line.includes('"mc_commands"')) continue
          try {
            const parsed = JSON.parse(line) as { type?: string; commands?: unknown }
            if (parsed.type === 'mc_commands' && Array.isArray(parsed.commands)) {
              commands = parsed.commands.filter((command): command is { name: string; description: string; argumentHint: string } => {
                const candidate = command as { name?: unknown; description?: unknown; argumentHint?: unknown }
                return typeof candidate.name === 'string' && candidate.name !== '' && typeof candidate.description === 'string' && typeof candidate.argumentHint === 'string'
              })
            }
          } catch {
            // a torn line mid-write is skipped
          }
        }
      }
      return { commands }
    })
    .get('/api/jobs/:id/queue', ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      return { items: queue.list(threadRootOf(job)) }
    })
    .delete('/api/jobs/:id/queue/:itemId', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined || !(await queue.remove(threadRootOf(job), params.itemId))) {
        set.status = 404
        return { error: 'queued message not found' }
      }
      return { ok: true }
    })
    .post('/api/jobs/:id/land', async ({ params, set }) => {
      const result = await manager.landJob(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error, ...(result.files === undefined ? {} : { files: result.files }) }
      }
      const landed = await manager.updateJob(params.id, { landedAt: Date.now() })
      if (landed?.chatId) await options.attention?.resolve(attentionKey.needs(landed.chatId))
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
    .post('/api/jobs/:id/permission', async ({ params, body, set }) => {
      const payload = body as { requestId?: unknown; decision?: unknown } | null
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      const decision = payload?.decision
      if (requestId === '' || (decision !== 'allow_once' && decision !== 'allow_always' && decision !== 'deny')) {
        set.status = 400
        return { error: 'requestId and a decision of allow_once, allow_always or deny are required' }
      }
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const log = await readRedactedLog(manager.logPath(params.id))
      if (job.status !== 'running' || !logHasPendingPermission(log, requestId) || !manager.sendControl(params.id, { type: 'permission', requestId, decision })) {
        set.status = 409
        return { error: 'This reply is no longer waiting' }
      }
      await options.attention?.resolve(attentionKey.permission(params.id, requestId))
      return { ok: true }
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
