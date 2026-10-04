import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { terminalsRoutes } from '../server/routes/terminals'
import { connectionTerminalArgs, terminalArgs, type CreateTerminalParams, type TerminalRegistry } from '../server/terminals'

describe('terminalArgs with a first message', () => {
  test('appends the first message last for every built-in engine', () => {
    expect(terminalArgs('claude', undefined, undefined, 'S', undefined, 'hello')).toEqual(['--session-id', 'S', 'hello'])
    expect(terminalArgs('glm', 'glm-5', undefined, 'S', 'be brief', 'hello')).toEqual(['--session-id', 'S', '--model', 'glm-5', '--append-system-prompt', 'be brief', 'hello'])
    expect(terminalArgs('codex', 'gpt', undefined, undefined, 'be brief', 'hello')).toEqual(['--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt', '-c', 'developer_instructions="be brief"', 'hello'])
  })

  test('leaves the arguments unchanged without a first message', () => {
    expect(terminalArgs('claude', undefined, undefined, 'S')).toEqual(['--session-id', 'S'])
    expect(terminalArgs('codex', undefined, undefined, 'ignored')).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
  })
})

describe('connectionTerminalArgs', () => {
  test('fills the prompt slot', () => {
    expect(connectionTerminalArgs(['--x', '{{prompt}}'], { prompt: 'hi' })).toEqual({ args: ['--x', 'hi'], promptUsed: true })
  })

  test('drops an empty prompt slot', () => {
    expect(connectionTerminalArgs(['--x', '{{prompt}}'], {})).toEqual({ args: ['--x'], promptUsed: false })
  })

  test('reports a prompt it had no slot for', () => {
    expect(connectionTerminalArgs(['--m', '{{model}}'], { model: 'k', prompt: 'hi' })).toEqual({ args: ['--m', 'k'], promptUsed: false })
  })

  test('keeps the existing model and instructions replacement', () => {
    expect(connectionTerminalArgs(['--m', '{{model}}', '--i', '{{instructions}}'], { instructions: 'x' })).toEqual({ args: ['--m', '', '--i', 'x'], promptUsed: false })
  })
})

function recordingRegistry(): { registry: TerminalRegistry; calls: CreateTerminalParams[] } {
  const calls: CreateTerminalParams[] = []
  const registry = {
    createTerminal: async (params: CreateTerminalParams) => {
      calls.push(params)
      return { ok: true as const, terminal: { id: 't1', engine: params.engine, cwd: params.cwd, pid: 1, createdAt: 0, title: 't', sessionId: null } }
    },
  } as unknown as TerminalRegistry
  return { registry, calls }
}

function post(app: Elysia, body: unknown): Promise<Response> {
  return app.handle(new Request('http://localhost/api/terminals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

describe('POST /api/terminals initialPrompt', () => {
  test('passes a trimmed first message through', async () => {
    const { registry, calls } = recordingRegistry()
    const response = await post(new Elysia().use(terminalsRoutes(registry)), { engine: 'claude', cwd: '/tmp', initialPrompt: '  read the task  ' })
    expect(response.status).toBe(200)
    expect(calls[0]!.initialPrompt).toBe('read the task')
  })

  test('ignores a blank first message', async () => {
    const { registry, calls } = recordingRegistry()
    await post(new Elysia().use(terminalsRoutes(registry)), { engine: 'claude', cwd: '/tmp', initialPrompt: '   ' })
    expect(calls[0]!.initialPrompt).toBeUndefined()
  })

  test('rejects a first message over 8000 characters', async () => {
    const { registry, calls } = recordingRegistry()
    const response = await post(new Elysia().use(terminalsRoutes(registry)), { engine: 'claude', cwd: '/tmp', initialPrompt: 'x'.repeat(8001) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'initialPrompt too long' })
    expect(calls).toHaveLength(0)
  })

  test('rejects a first message on a resume', async () => {
    const { registry, calls } = recordingRegistry()
    const response = await post(new Elysia().use(terminalsRoutes(registry)), { engine: 'claude', cwd: '/tmp', initialPrompt: 'hi', resumeSessionId: '11111111-2222-3333-4444-555555555555' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'initialPrompt cannot be used when resuming' })
    expect(calls).toHaveLength(0)
  })
})
