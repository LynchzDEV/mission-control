import { watch } from 'node:fs'

import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { parseActivity } from '../activity'
import type { CreateJobParams, JobManager } from '../jobs'
import { readLogFile, readLogSince, readLogTail } from '../jobs'
import type { EngineResolver } from '../jobs-engine-iface'
import { engineSupportsResume } from '../jobs-engine-iface'
import { assembleThread, replySessionId, threadChain, threadIsRunning, threadRootOf } from '../threads'

export const SSE_TAIL_BYTES = 4096
export const HEARTBEAT_MS = 15_000
export const ACTIVITY_FEED_MAX = 50

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

export function createLogStreamResponse(path: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
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
      if (initial.content !== '') controller.enqueue(encoder.encode(formatSSEData(initial.content)))

      const pushUpdates = async (): Promise<void> => {
        if (closed) return
        const chunk = await readLogSince(path, offset)
        if (closed || chunk.content === '') return
        offset = chunk.offset
        safeEnqueue(controller, () => closed, encoder.encode(formatSSEData(chunk.content)))
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

export function jobsRoutes(manager: JobManager, resolver: EngineResolver): Elysia {
  return new Elysia()
    .onBeforeHandle(requireSession)
    .post('/api/jobs', async ({ body, set }) => {
      const payload = body as Partial<CreateJobParams> | null
      if (
        typeof payload?.engine !== 'string' ||
        typeof payload.cwd !== 'string' ||
        typeof payload.prompt !== 'string' ||
        typeof payload.label !== 'string'
      ) {
        set.status = 400
        return { error: 'engine, cwd, prompt, and label are required' }
      }

      const result = await manager.createJob(
        {
          engine: payload.engine,
          cwd: payload.cwd,
          prompt: payload.prompt,
          label: payload.label,
          ...(typeof payload.terminalId === 'string' ? { terminalId: payload.terminalId } : {}),
        },
        resolver,
      )
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .get('/api/jobs', () => ({
      jobs: manager.listJobs().map((job) => ({ ...job, currentActivity: manager.currentActivity(job.id) })),
    }))
    .get('/api/jobs/:id/activity', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const events = parseActivity(await readLogFile(manager.logPath(params.id)), ACTIVITY_FEED_MAX)
      return { status: job.status, currentActivity: manager.currentActivity(params.id), events }
    })
    .get('/api/jobs/:id/log', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const content = await readLogFile(manager.logPath(params.id))
      return new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    })
    .get('/api/jobs/:id/stream', ({ params, set, request }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      return createLogStreamResponse(manager.logPath(params.id), request.signal)
    })
    .get('/api/jobs/:id/thread', async ({ params, set }) => {
      const job = manager.getJob(params.id)
      if (job === undefined) {
        set.status = 404
        return { error: 'job not found' }
      }
      const rootId = threadRootOf(job)
      const chain = threadChain(manager.listJobs(), rootId)
      const messages = await assembleThread(chain, (jobId) => readLogFile(manager.logPath(jobId)))
      return {
        rootId,
        engine: job.engine,
        running: threadIsRunning(chain),
        sessionId: replySessionId(chain),
        canReply: engineSupportsResume(job.engine) && replySessionId(chain) !== null,
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
      if (!engineSupportsResume(parent.engine)) {
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

      const result = await manager.createJob(
        {
          engine: parent.engine,
          cwd: parent.cwd,
          prompt: message,
          label: parent.label,
          parentJobId: parent.id,
          threadRoot: rootId,
          resumeSessionId: sessionId,
          ...(parent.terminalId === null ? {} : { terminalId: parent.terminalId }),
        },
        resolver,
      )
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
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
