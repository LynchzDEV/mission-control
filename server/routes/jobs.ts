import { watch } from 'node:fs'

import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import type { CreateJobParams, JobManager } from '../jobs'
import { readLogFile, readLogSince, readLogTail } from '../jobs'
import type { EngineResolver } from '../jobs-engine-iface'

export const SSE_TAIL_BYTES = 4096
export const HEARTBEAT_MS = 15_000

function formatSSEData(content: string): string {
  return `${content
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`
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
        if (chunk.content === '') return
        offset = chunk.offset
        controller.enqueue(encoder.encode(formatSSEData(chunk.content)))
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
        { engine: payload.engine, cwd: payload.cwd, prompt: payload.prompt, label: payload.label },
        resolver,
      )
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.job
    })
    .get('/api/jobs', () => ({ jobs: manager.listJobs() }))
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
    .post('/api/jobs/:id/kill', async ({ params, set }) => {
      const result = await manager.killJob(params.id)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return { ok: true }
    })
}
