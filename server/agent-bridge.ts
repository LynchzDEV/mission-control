import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { connectionSchema, connectionCommand, connectionEnvironment } from './agent-connections'
import { pathWithFallbackDirs, PARENT_CLAUDE_SESSION_VARS, resolveBinary } from './engines'
import { mcpSchema } from './workflows'
import { parseThread, parseSessionId, reportedJobOutcome } from './activity'

const launchSchema = z.object({ connection: connectionSchema, prompt: z.string().max(500000), model: z.string().optional(), resumeSessionId: z.string().optional(), mcpServers: z.array(mcpSchema).default([]), probe: z.boolean().default(false), readOnly: z.boolean().default(false) })
const OUTPUT_LIMIT = 2_000_000

export async function workspaceFile(path: string, cwd: string, writable = false): Promise<string> {
  const root = await realpath(cwd)
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  let canonical: string
  try { canonical = await realpath(absolute) }
  catch (error) {
    if (!writable || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    canonical = resolve(await realpath(dirname(absolute)), absolute.slice(absolute.lastIndexOf(sep) + 1))
  }
  if (canonical !== root && !canonical.startsWith(root + sep)) throw new Error('Tool path is outside the assigned workspace')
  return canonical
}

export async function runAgentBridge(raw: unknown): Promise<number> {
  const input = launchSchema.parse(raw)
  const { connection } = input
  const overlay = connectionEnvironment(connection)
  const env: Record<string, string | undefined> = { ...process.env, ...overlay, PATH: pathWithFallbackDirs(process.env.PATH) }
  for (const key of PARENT_CLAUDE_SESSION_VARS) delete env[key]
  const secrets = [...Object.values(connection.env), connection.apiKeyEnv].filter((key): key is string => !!key).map(key => process.env[key]).filter((value): value is string => !!value)
  const sanitize = (value: string) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value, (_, entry) => typeof entry === 'string' ? sanitize(entry) : entry)}\n`)
  const children = new Set<ChildProcess>()
  const kill = (child: ChildProcess) => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch {} }
  const shutdown = () => { for (const child of children) kill(child) }
  let cancelling = false
  const forceKill = () => { for (const child of children) { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch {} } }
  const cancel = () => { if (cancelling) return; cancelling = true; shutdown(); setTimeout(() => { forceKill(); process.exit(143) }, 1000) }
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  const deadline = setTimeout(cancel, 60 * 60_000)
  let setupTimer: ReturnType<typeof setTimeout> | undefined
  function launch(command: string, args: string[], cwd = process.cwd(), extraEnv = {}) {
    const child = spawn(resolveBinary(command), args, { cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    children.add(child)
    let output = '', errors = ''
    child.stdout!.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-OUTPUT_LIMIT) })
    child.stderr!.on('data', (data: Buffer) => { errors = (errors + data.toString()).slice(-32000) })
    const exited = new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)) })
    void exited.catch(() => {})
    return { child, exited, output: () => output, errors: () => errors }
  }
  let denied = false
  function requireTools() {
    if (input.readOnly || !connection.autoApprove) { denied = true; throw new Error('Connection requires tool approval; enable trusted tools in the connection to run unattended') }
  }
  try {
    const command = connectionCommand(connection, input.prompt, input.model, input.resumeSessionId)
    const running = launch(command.command, command.args)
    if (connection.adapter === 'cli') {
      if (input.probe) throw new Error('CLI connections are checked when run; use an ACP connection for capability probing')
      if (input.mcpServers.length) throw new Error('MCP attachment requires an ACP or OpenCode connection')
      running.child.stdin!.end()
      const processExit = await running.exited
      const exit = connection.output !== 'text' && reportedJobOutcome(running.output()) === 'failed' ? 1 : processExit
      const sessionId = connection.output === 'text' ? null : parseSessionId(running.output())
      if (sessionId) emit({ type: 'system', session_id: sessionId, resumeSupported: connection.args.some(arg => arg.includes('{{session}}')) })
      const output = connection.output === 'text' ? running.output() : parseThread(running.output()).filter(event => event.kind === 'text' || event.kind === 'result').map(event => event.detail).join('\n')
      emit({ type: 'result', is_error: exit !== 0, result: output, subtype: exit === 0 ? 'success' : 'error' })
      if (exit) emit({ type: 'result', is_error: true, result: running.errors() || `Agent exited ${exit}` })
      return exit === 0 ? 0 : 1
    }
    const terminals = new Map<string, ReturnType<typeof launch>>()
    let text = '', sessionId: string | undefined, replaying = false, announced = false
    const app = acp.client({ name: 'mission-control' })
      .onRequest('session/request_permission', ({ params }) => {
        const option = !input.readOnly && connection.autoApprove ? params.options.find(option => option.kind === 'allow_once') : undefined
        if (!option) denied = true
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
      })
      .onNotification('session/update', ({ params }) => {
        if (replaying) return
        const update = params.update
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          text = (text + update.content.text).slice(-OUTPUT_LIMIT)
          if (!announced) { emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Agent is responding…' }] } }); announced = true }
        } else if (update.sessionUpdate === 'tool_call') {
          emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: update.toolCallId, name: update.title, input: update.rawInput ?? {} }] } })
        }
      })
      .onRequest('fs/read_text_file', async ({ params }) => {
        if (input.readOnly) throw new Error('Workflow drafting does not use filesystem tools')
        const content = await readFile(await workspaceFile(params.path, process.cwd()), 'utf8')
        if (content.length > OUTPUT_LIMIT) throw new Error('File is too large for the ACP client')
        const start = Math.max(0, (params.line ?? 1) - 1)
        return { content: content.split('\n').slice(start, params.limit ? start + params.limit : undefined).join('\n') }
      })
      .onRequest('fs/write_text_file', async ({ params }) => {
        requireTools()
        if (params.content.length > OUTPUT_LIMIT) throw new Error('Write exceeds the ACP client size limit')
        await writeFile(await workspaceFile(params.path, process.cwd(), true), params.content)
        return {}
      })
      .onRequest('terminal/create', async ({ params }) => {
        requireTools()
        const cwd = params.cwd ? await workspaceFile(params.cwd, process.cwd()) : process.cwd()
        const terminalId = crypto.randomUUID()
        const terminal = launch(params.command, params.args ?? [], cwd, Object.fromEntries((params.env ?? []).map(entry => [entry.name, entry.value])))
        terminal.child.stdin!.end()
        terminals.set(terminalId, terminal)
        return { terminalId }
      })
      .onRequest('terminal/output', ({ params }) => {
        const terminal = terminals.get(params.terminalId)
        if (!terminal) throw new Error('Terminal not found')
        return { output: sanitize(terminal.output() + terminal.errors()), truncated: terminal.output().length >= OUTPUT_LIMIT, ...(terminal.child.exitCode === null ? {} : { exitStatus: { exitCode: terminal.child.exitCode } }) }
      })
      .onRequest('terminal/wait_for_exit', async ({ params }) => {
        const terminal = terminals.get(params.terminalId)
        if (!terminal) throw new Error('Terminal not found')
        return { exitCode: await terminal.exited }
      })
      .onRequest('terminal/kill', ({ params }) => { const terminal = terminals.get(params.terminalId); if (terminal) kill(terminal.child); return {} })
      .onRequest('terminal/release', ({ params }) => { const terminal = terminals.get(params.terminalId); if (terminal) kill(terminal.child); terminals.delete(params.terminalId); return {} })
    const stream = acp.ndJsonStream(Writable.toWeb(running.child.stdin!), Readable.toWeb(running.child.stdout!) as unknown as ReadableStream<Uint8Array>)
    return await app.connectWith(stream, async agent => {
      const handshake = AbortSignal.timeout(30000)
      setupTimer = setTimeout(() => kill(running.child), 30000)
      const init = await agent.request<'initialize'>('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: 'Mission Control', version: '1' }, clientCapabilities: { fs: { readTextFile: !input.readOnly, writeTextFile: !input.readOnly }, terminal: !input.readOnly } }, { cancellationSignal: handshake })
      if (connection.authMethod) {
        if (!init.authMethods?.some(method => method.id === connection.authMethod)) throw new Error('Configured authentication method is not advertised by this agent')
        await agent.request('authenticate', { methodId: connection.authMethod }, { cancellationSignal: handshake })
      }
      if (input.probe) { emit({ type: 'mc_capabilities', capabilities: init.agentCapabilities, authMethods: init.authMethods, agentInfo: init.agentInfo }); return 0 }
      const mcpServers = input.mcpServers.map(server => ({ name: server.name, command: resolveBinary(server.command), args: server.args, env: Object.entries(server.env).map(([name, reference]) => {
        const value = process.env[reference]
        if (!value) throw new Error(`Missing MCP environment variable: ${reference}`)
        secrets.push(value)
        return { name, value }
      }) }))
      const params: acp.NewSessionRequest = { cwd: process.cwd(), mcpServers }
      if (input.resumeSessionId && !init.agentCapabilities?.loadSession) throw new Error('Agent does not support session resume')
      replaying = !!input.resumeSessionId
      const session = input.resumeSessionId
        ? await agent.request<'session/load'>('session/load', { ...params, sessionId: input.resumeSessionId }, { cancellationSignal: handshake })
        : await agent.request<'session/new'>('session/new', params, { cancellationSignal: handshake })
      replaying = false
      sessionId = input.resumeSessionId ?? ('sessionId' in session && typeof session.sessionId === 'string' ? session.sessionId : undefined)
      if (!sessionId) throw new Error('Agent did not return a session ID')
      emit({ type: 'system', session_id: sessionId, resumeSupported: init.agentCapabilities?.loadSession === true, capabilities: init.agentCapabilities })
      if (input.model) {
        const selected = connection.adapter === 'opencode' && connection.baseUrl && !input.model.startsWith(`${connection.provider}/`) ? `${connection.provider}/${input.model}` : input.model
        const option = session.configOptions?.find(option => option.category === 'model' || option.id === 'model')
        if (option) await agent.request('session/set_config_option', { sessionId, configId: option.id, value: selected }, { cancellationSignal: handshake })
        else await agent.request('session/set_model', { sessionId, modelId: selected }, { cancellationSignal: handshake })
      }
      clearTimeout(setupTimer)
      const result = await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] })
      const success = result.stopReason === 'end_turn' && !denied
      emit({ type: 'result', session_id: sessionId, is_error: !success, result: denied ? 'MC_RESULT {"outcome":"blocked","summary":"Tool approval required","evidence":[]}' : text, subtype: success ? 'success' : 'error', stopReason: result.stopReason })
      return success ? 0 : 2
    })
  } catch (error) {
    emit({ type: 'result', is_error: true, result: error instanceof Error ? error.message : 'Agent connection failed' })
    return 1
  } finally {
    clearTimeout(deadline)
    clearTimeout(setupTimer)
    process.off('SIGTERM', cancel)
    process.off('SIGINT', cancel)
    shutdown()
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const closed = [...children].map(child => !child.pid || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolveClose => child.once('close', () => resolveClose())))
    await Promise.race([Promise.all(closed), new Promise<void>(resolveTimeout => { cleanupTimer = setTimeout(resolveTimeout, 1000) })])
    clearTimeout(cleanupTimer)
    forceKill()
  }
}

if (import.meta.main) {
  try { process.exitCode = await runAgentBridge(JSON.parse(await Bun.stdin.text())) }
  catch { process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, result: 'Invalid agent launch input' })}\n`); process.exitCode = 1 }
}
