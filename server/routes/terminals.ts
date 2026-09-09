import { Elysia } from 'elysia'
import { parseTranscript, readTranscriptTail, statTranscript, type TranscriptMessage } from '../session-transcript'

const transcriptCache = new Map<string, { key: string; messages: TranscriptMessage[] }>()

import { requireSession, verifyCookieHeader } from '../auth'
import { checkDropSize, findOriginalFile, saveDroppedCopy } from '../drops'
import { MAX_MODEL_LENGTH } from '../engines'
import { MAX_TITLE_LENGTH, normalizeTitle, type TerminalRegistry } from '../terminals'
import { listSessions } from '../transcripts'
import { validateWorkspaceCwd } from '../workspace'

export const CLOSE_TERMINAL_NOT_FOUND = 4404
export const CLOSE_TERMINAL_ENDED = 4410
const RESUME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type ControlMessage =
  | { kind: 'resize'; cols: unknown; rows: unknown }
  | { kind: 'data'; data: string }
  | { kind: 'ignore' }

function decodeBinary(message: unknown): string | null {
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message)
  if (ArrayBuffer.isView(message)) {
    const view = message as ArrayBufferView
    return new TextDecoder().decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    )
  }
  return null
}

// Elysia coerces string frames (JSON, numerics, booleans) before any hook sees them, so keystrokes ride binary frames.
export function readSocketMessage(message: unknown): ControlMessage {
  const binary = decodeBinary(message)
  if (binary !== null) return { kind: 'data', data: binary }
  if (message === null || typeof message !== 'object') return { kind: 'ignore' }

  const payload = message as Record<string, unknown>
  if (payload.type === 'resize') return { kind: 'resize', cols: payload.cols, rows: payload.rows }
  if (payload.type === 'data' && typeof payload.data === 'string') {
    return { kind: 'data', data: payload.data }
  }
  return { kind: 'ignore' }
}

type TerminalHelpers = {
  find?: typeof findOriginalFile
  save?: typeof saveDroppedCopy
  listSessions?: typeof listSessions
}

function terminalApi(registry: TerminalRegistry, helpers: TerminalHelpers): Elysia {
  const find = helpers.find ?? findOriginalFile
  const save = helpers.save ?? saveDroppedCopy
  const sessionsFor = helpers.listSessions ?? listSessions
  return new Elysia()
    .onBeforeHandle(requireSession)
    .post('/api/terminals', async ({ body, set }) => {
      const payload = body as Record<string, unknown> | null
      if (typeof payload?.engine !== 'string' || typeof payload.cwd !== 'string') {
        set.status = 400
        return { error: 'engine and cwd are required' }
      }
      const model = typeof payload.model === 'string' && payload.model !== '' ? payload.model : undefined
      if (model !== undefined && model.length > MAX_MODEL_LENGTH) {
        set.status = 400
        return { error: 'model too long' }
      }
      const resumeSessionId =
        typeof payload.resumeSessionId === 'string' ? payload.resumeSessionId : undefined
      if (resumeSessionId !== undefined && !RESUME_ID_PATTERN.test(resumeSessionId)) {
        set.status = 400
        return { error: 'invalid session id' }
      }
      const title = typeof payload.title === 'string' ? payload.title : undefined
      const result = await registry.createTerminal({
        engine: payload.engine,
        cwd: payload.cwd,
        cols: payload.cols,
        rows: payload.rows,
        ...(model === undefined ? {} : { model }),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        ...(title === undefined ? {} : { title }),
      })
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.terminal
    })
    .post('/api/terminals/drops', async ({ body, set }) => {
      const payload = body as Record<string, unknown> | null
      const file = payload?.file instanceof File ? payload.file : null
      if (file === null) {
        set.status = 400
        return { error: 'file is required' }
      }
      if (!checkDropSize(file.size)) {
        set.status = 413
        return { error: 'file too large' }
      }
      const rawModified = typeof payload?.lastModified === 'string' ? Number(payload.lastModified) : Number.NaN
      const lastModified = Number.isFinite(rawModified) ? rawModified : Date.now()
      const found = await find({ name: file.name, size: file.size, lastModified })
      if (found !== null) return { path: found, original: true }
      return { path: await save(file.name, await file.arrayBuffer()), original: false }
    })
    .get('/api/terminals/sessions', async ({ query, set }) => {
      const cwd = typeof query.cwd === 'string' ? query.cwd : ''
      if (cwd === '') {
        set.status = 400
        return { error: 'cwd is required' }
      }
      const check = await validateWorkspaceCwd(cwd, undefined, { requireGit: false })
      if (!check.ok) {
        set.status = 400
        return { error: check.error }
      }
      return { sessions: await sessionsFor(check.path) }
    })
    .get('/api/terminals', () => ({ sessions: registry.list() }))
    .get('/api/terminals/:id/thread', async ({ params, set }) => {
      const record = registry.get(params.id)
      if (record === undefined) {
        set.status = 404
        return { error: 'terminal not found' }
      }
      const path = await registry.transcriptPath(params.id)
      const info = path === null ? null : await statTranscript(path)
      const key = info === null ? '' : `${path}:${info.mtimeMs}:${info.size}`
      let messages: TranscriptMessage[] = []
      if (info !== null) {
        const cached = transcriptCache.get(params.id)
        if (cached?.key === key) messages = cached.messages
        else {
          const text = await readTranscriptTail(path!)
          messages = text === null ? [] : parseTranscript(record.engine, text)
          transcriptCache.set(params.id, { key, messages })
        }
      } else transcriptCache.delete(params.id)
      return {
        engine: record.engine,
        sessionId: record.sessionId,
        running: true,
        canReply: false,
        bound: info !== null,
        messages,
      }
    })
    .patch('/api/terminals/:id', ({ params, body, set }) => {
      const title = normalizeTitle((body as Record<string, unknown> | null)?.title)
      if (title === null) {
        set.status = 400
        return { error: `title must be 1-${MAX_TITLE_LENGTH} characters` }
      }
      if (!registry.rename(params.id, title)) {
        set.status = 404
        return { error: 'terminal not found' }
      }
      return registry.get(params.id)
    })
    .delete('/api/terminals/:id', ({ params, set }) => {
      if (!registry.kill(params.id)) {
        set.status = 404
        return { error: 'terminal not found' }
      }
      return { ok: true }
    })
}

function terminalSocket(registry: TerminalRegistry): Elysia {
  const detachers = new Map<string, () => void>()

  function detach(key: string): void {
    detachers.get(key)?.()
    detachers.delete(key)
  }

  return new Elysia().ws('/ws/terminal/:id', {
    async beforeHandle({ request, set }) {
      if (await verifyCookieHeader(request.headers.get('cookie'))) return
      set.status = 401
      return { error: 'unauthorized' }
    },
    open(ws) {
      const id = ws.data.params.id
      if (registry.get(id) === undefined) {
        ws.close(CLOSE_TERMINAL_NOT_FOUND, 'terminal not found')
        return
      }
      const replay = registry.replay(id)
      if (replay !== '') ws.send(replay)
      detach(ws.id)
      detachers.set(
        ws.id,
        registry.subscribe(
          id,
          (chunk) => {
            ws.send(chunk)
          },
          () => {
            ws.close(CLOSE_TERMINAL_ENDED, 'terminal ended')
          },
        ),
      )
    },
    message(ws, message) {
      const id = ws.data.params.id
      const control = readSocketMessage(message)
      if (control.kind === 'resize') registry.resize(id, control.cols, control.rows)
      else if (control.kind === 'data') registry.write(id, control.data)
    },
    close(ws) {
      detach(ws.id)
    },
  })
}

export function terminalsRoutes(registry: TerminalRegistry, helpers: TerminalHelpers = {}): Elysia {
  return new Elysia().use(terminalApi(registry, helpers)).use(terminalSocket(registry))
}
