import { Elysia } from 'elysia'

import { requireSession, verifyCookieHeader } from '../auth'
import type { TerminalRegistry } from '../terminals'

export const CLOSE_TERMINAL_NOT_FOUND = 4404
export const CLOSE_TERMINAL_ENDED = 4410

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

function terminalApi(registry: TerminalRegistry): Elysia {
  return new Elysia()
    .onBeforeHandle(requireSession)
    .post('/api/terminals', async ({ body, set }) => {
      const payload = body as Record<string, unknown> | null
      if (typeof payload?.engine !== 'string' || typeof payload.cwd !== 'string') {
        set.status = 400
        return { error: 'engine and cwd are required' }
      }
      const result = await registry.createTerminal({
        engine: payload.engine,
        cwd: payload.cwd,
        cols: payload.cols,
        rows: payload.rows,
      })
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.terminal
    })
    .get('/api/terminals', () => registry.list())
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

export function terminalsRoutes(registry: TerminalRegistry): Elysia {
  return new Elysia().use(terminalApi(registry)).use(terminalSocket(registry))
}
