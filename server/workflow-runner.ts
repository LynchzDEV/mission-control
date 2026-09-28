import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { parseThread } from './activity'
import { BUILTIN_AGENTS, createConnectionStore, modelFamily, type AgentConnection } from './agent-connections'
import { resolveBinary } from './engines'
import { git } from './job-worktrees'
import { type JobManager, type JobRecord, readLogFile, redactSecrets } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import type { TerminalRegistry } from './terminals'
import { threadRootOf } from './threads'
import { configDir, readConfig, readSecrets } from './secrets'
import { validateWorkspaceCwd } from './workspace'
import { atomicJson, composeWorkflowPrompt, draftRevision, identifier, type Outcome, type PolicyRevision, type WorkflowNode, type WorkflowRevision, type WorkflowStore } from './workflows'

const jobId = z.string().min(1).max(200)
const startSchema = z.object({ terminalId: identifier.optional(), workflowId: identifier.optional(), revision: identifier.optional(), cwd: z.string().min(1).max(2048), request: z.string().trim().min(1).max(32000), label: z.string().trim().min(1).max(120), chat: jobId.optional(), chatTurn: jobId.optional(), engine: identifier.optional(), model: z.string().min(1).max(200).optional(), graph: z.unknown().optional() })
const resultSchema = z.object({ outcome: z.enum(['pass', 'fail', 'blocked']), summary: z.string().trim().min(1).max(16000), evidence: z.array(z.string().min(1).max(4000)).max(100) })
type NodeResult = z.infer<typeof resultSchema>
export type ResolvedAgent = { engine: string; model: string | null; family: string | null; connection?: AgentConnection }
type ChatDefault = { engine: string; model: string | null }
export type CheckResult = { command: string; args: string[]; exitCode: number | null; output: string; timedOut: boolean }
export type WorkflowAttempt = {
  nodeId: string; number: number; jobId: string | null; status: 'starting' | 'running' | 'checking' | 'settled';
  prompt: string; startedAt: number; endedAt: number | null; result: NodeResult | null; checks: CheckResult[];
  output: string; checkPid?: number; workspace: { head: string; diffHash: string } | null;
}
export type RunStatus = 'awaiting-approval' | 'running' | 'paused' | 'done' | 'failed' | 'blocked' | 'stopped'
export type ApprovalVia = 'user' | 'drawer' | 'conversation' | 'auto'
export type RunVersion = { number: number; revision: string; reason: string; size: 'initial' | 'small' | 'big'; state: 'pending' | 'approved' | 'rejected'; approvedVia: ApprovalVia | null; relayedBy: string | null; at: number }
export type RunOrigin = { source: 'saved' | 'drafted'; by: string; where: 'chat' | 'terminal' | 'studio' }
export type ApprovalContext = { via: 'drawer' | 'conversation'; chat?: string; terminalId?: string; version?: number }
export class RunActionError extends Error { constructor(message: string, readonly status: 403 | 404 | 409) { super(message) } }
export const LIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['awaiting-approval', 'running', 'paused'])
type SettledStatus = Exclude<RunStatus, 'awaiting-approval' | 'running' | 'paused'>
export type WorkflowRun = {
  terminalId?: string
  chatId?: string; chatTurn?: string; reportedAt?: number | null
  id: string; label: string; cwd: string; request: string; workflow: WorkflowRevision; policy: PolicyRevision;
  agents: Record<string, ResolvedAgent>; skills: Record<string, Array<{ path: string; content: string }>>;
  status: RunStatus; error: string | null; origin: RunOrigin; versions: RunVersion[];
  currentNodeId: string; attempts: WorkflowAttempt[]; createdAt: number; updatedAt: number;
}

export function readNodeResult(log: string): NodeResult | null {
  const messages = parseThread(log).filter(event => event.kind === 'text' || event.kind === 'result').map(event => event.detail)
  for (const message of messages.reverse()) {
    const match = /(?:^|\n)MC_RESULT\s+(\{[^\n]*\})\s*$/.exec(message.trim())
    if (!match) continue
    try { return resultSchema.parse(JSON.parse(match[1]!)) } catch { return null }
  }
  return null
}

async function snapshotSkills(node: WorkflowNode, cwd: string): Promise<Array<{ path: string; content: string }>> {
  return Promise.all(node.skills.map(async path => {
    const full = await realpath(isAbsolute(path) ? path : resolve(cwd, path))
    const home = await realpath(homedir())
    if (!full.startsWith(home + sep) || !full.endsWith('.md')) throw new Error('Skills must be Markdown files under your home directory')
    const info = await stat(full)
    if (!info.isFile() || info.size > 64000) throw new Error('Skill must be a Markdown file up to 64 KB')
    return { path: full, content: await readFile(full, 'utf8') }
  }))
}

async function workspaceSnapshot(cwd: string): Promise<{ head: string; diffHash: string }> {
  const [head, diff, untracked] = await Promise.all([git(cwd, 'rev-parse', 'HEAD'), git(cwd, 'diff', '--binary', 'HEAD'), git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')])
  const hash = createHash('sha256').update(diff)
  for (const path of untracked.split('\0').filter(Boolean).sort()) {
    const resolved = await realpath(join(cwd, path))
    hash.update(path)
    if (!resolved.startsWith(cwd + sep)) { hash.update(resolved); continue }
    const info = await stat(resolved)
    if (info.size > 10_000_000) throw new Error(`Untracked artifact too large to fingerprint: ${path}`)
    hash.update(await readFile(resolved))
  }
  return { head, diffHash: hash.digest('hex') }
}

export function createWorkflowRunner(deps: { manager: JobManager; resolver: EngineResolver; store: WorkflowStore; base?: string; terminals?: Pick<TerminalRegistry, 'get'>; onRunSettled?: (run: WorkflowRun) => void; requireApproval?: () => Promise<boolean>; onChange?: (run: WorkflowRun) => void }) {
  const root = join(deps.base ?? configDir(), 'workflow-runs')
  const requireApproval = deps.requireApproval ?? (async () => (await readConfig()).flowApproval)
  const runs = new Map<string, WorkflowRun>()
  try {
    for (const file of readdirSync(root).filter(file => /^[a-zA-Z0-9-]+\.json$/.test(file))) {
      const record = JSON.parse(readFileSync(join(root, file), 'utf8')) as WorkflowRun
      record.origin ??= { source: 'saved', by: 'you', where: record.terminalId ? 'terminal' : record.chatId ? 'chat' : 'studio' }
      record.versions ??= [{ number: 1, revision: record.workflow.revision, reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'user', relayedBy: null, at: record.createdAt }]
      runs.set(record.id, record)
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const pending = new Map<string, Promise<unknown>>()
  const stopping = new Set<string>()
  const checks = new Map<string, () => void>()
  let starts = Promise.resolve<unknown>(undefined)
  function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (pending.get(id) ?? Promise.resolve()).then(action)
    pending.set(id, task.catch(() => {}))
    return task
  }
  async function persist(run: WorkflowRun): Promise<void> {
    run.updatedAt = Date.now()
    await mkdir(root, { recursive: true, mode: 0o700 })
    await atomicJson(join(root, `${run.id}.json`), run)
    runs.set(run.id, run)
    deps.onChange?.(structuredClone(run))
    if (!LIVE_STATUSES.has(run.status) && !processAlive(run.attempts.at(-1)?.checkPid) && !deps.manager.listJobs().some(job => job.workflowRunId === run.id && job.status === 'running')) deps.manager.releaseWorkspace(run.cwd, run.id)
  }
  function processAlive(pid?: number): boolean {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  async function finish(run: WorkflowRun, status: SettledStatus, error: string | null): Promise<void> {
    const wasLive = LIVE_STATUSES.has(run.status)
    run.status = status; run.error = error
    await persist(run)
    if (wasLive) deps.onRunSettled?.(structuredClone(run))
  }
  async function block(run: WorkflowRun, error: string): Promise<void> {
    await finish(run, 'blocked', error)
  }
  function workspaceBusy(cwd: string, except?: string): boolean {
    return [...runs.values()].some(run => run.id !== except && run.cwd === cwd && LIVE_STATUSES.has(run.status)) || deps.manager.listJobs().some(job => job.cwd === cwd && job.status === 'running' && job.purpose !== 'chat' && job.workflowRunId !== except)
  }
  async function agentsFor(workflow: WorkflowRevision, chatDefault?: ChatDefault): Promise<Record<string, ResolvedAgent>> {
    const roles = (await readConfig()).roles
    const connections = createConnectionStore(deps.base)
    async function resolveAgent(node: WorkflowNode, fallback: ChatDefault | undefined): Promise<ResolvedAgent> {
      const role = fallback ?? roles[node.agent.role]
      const engine = node.agent.engine ?? role.engine
      const model = node.agent.model ?? (node.agent.engine ? null : role.model)
      const builtin = BUILTIN_AGENTS.includes(engine as typeof BUILTIN_AGENTS[number])
      const connection = builtin ? undefined : await connections.get(engine)
      if (node.mcpServers.length && (!connection || connection.adapter === 'cli')) throw new Error(`${node.title}: attached MCP servers need an ACP connection`)
      const family = (modelFamily(model) ?? node.agent.family ?? connection?.family ?? (builtin ? engine === 'codex' ? 'gpt' : engine : null))?.toLowerCase() ?? null
      return { engine, model, family, ...(connection ? { connection } : {}) }
    }
    const agents: Record<string, ResolvedAgent> = Object.fromEntries(await Promise.all(workflow.nodes.map(async node => [node.id, await resolveAgent(node, chatDefault)] as const)))
    const implementationFamilies = new Set(workflow.nodes.filter(node => node.kind === 'implement').map(node => agents[node.id]!.family))
    for (const review of workflow.nodes.filter(node => chatDefault && node.kind === 'review' && !node.agent.engine && implementationFamilies.has(agents[node.id]!.family))) {
      agents[review.id] = await resolveAgent(review, undefined)
    }
    for (const implementation of workflow.nodes.filter(node => node.kind === 'implement')) {
      if (!agents[implementation.id]!.family) throw new Error(`${implementation.title}: select or declare the model family for cross-family review`)
    }
    for (const review of workflow.nodes.filter(node => node.kind === 'review')) {
      if (!agents[review.id]!.family) throw new Error(`${review.title}: select or declare the review model family`)
    }
    let next: string | undefined = workflow.entry
    const visited = new Set<string>()
    const walkFamilies = new Set<string>()
    while (next && !visited.has(next)) {
      visited.add(next)
      const node = workflow.nodes.find(node => node.id === next)!
      if (node.kind === 'implement') walkFamilies.add(agents[node.id]!.family!)
      if (node.kind === 'review') {
        if (walkFamilies.has(agents[node.id]!.family!)) throw new Error(`${node.title} must use a different model family from implementation`)
        walkFamilies.clear()
      }
      next = workflow.edges.find(edge => edge.source === node.id && edge.outcome === 'pass')?.target
    }
    return agents
  }
  async function dispatch(run: WorkflowRun): Promise<void> {
    if (stopping.has(run.id) || run.status !== 'running') return
    const node = run.workflow.nodes.find(node => node.id === run.currentNodeId)!
    const visits = run.attempts.filter(attempt => attempt.nodeId === node.id).length
    if (visits >= node.maxVisits) return block(run, `${node.title} reached its ${node.maxVisits}-visit limit`)
    if (run.attempts.length >= 256) return block(run, 'Run reached its 256-node execution limit')
    const lastPlan = run.attempts.findLastIndex(attempt => run.workflow.nodes.find(node => node.id === attempt.nodeId)?.kind === 'plan')
    const verification = run.attempts.findLastIndex(attempt => run.workflow.nodes.find(node => node.id === attempt.nodeId)?.kind === 'verify-plan')
    const verified = verification > lastPlan && run.attempts[verification]?.result?.outcome === 'pass'
    if (node.kind === 'implement' && !verified) return block(run, 'Implementation requires a successfully verified plan')
    const lastReview = run.attempts.findLastIndex(attempt => run.workflow.nodes.find(node => node.id === attempt.nodeId)?.kind === 'review' && attempt.result?.outcome === 'pass')
    const implementations = run.attempts.slice(lastReview + 1).filter(attempt => run.workflow.nodes.find(node => node.id === attempt.nodeId)?.kind === 'implement')
    if (node.kind === 'review' && implementations.some(attempt => run.agents[attempt.nodeId]!.family === run.agents[node.id]!.family)) return block(run, 'Review must use a different model family from implementation; change the blueprint and start a new run')
    const latest = new Map(run.attempts.filter(attempt => attempt.result).map(attempt => [attempt.nodeId, attempt]))
    const inputs = [...latest.values()].map(attempt => ({ node: attempt.nodeId, outcome: attempt.result, output: attempt.output, checks: attempt.checks, workspace: attempt.workspace }))
    const prompt = composeWorkflowPrompt(run.policy, run.workflow, node, run.request, inputs, run.skills[node.id])
    const attempt: WorkflowAttempt = { nodeId: node.id, number: run.attempts.length, jobId: null, status: 'starting', prompt, startedAt: Date.now(), endedAt: null, result: null, checks: [], output: '', workspace: null }
    if (prompt.length > 500000) return block(run, 'Combined task inputs exceed 500 KB; use artifact paths for large outputs')
    run.attempts.push(attempt)
    await persist(run)
    const agent = run.agents[node.id]!
    const chat = run.chatId ? { chatId: run.chatId, ...(run.chatTurn ? { chatTurn: run.chatTurn } : {}), reason: `Studio · ${run.workflow.name} · ${node.title}` } : {}
    const result = await deps.manager.createJob({ engine: agent.engine, model: agent.model ?? undefined, connection: agent.connection, cwd: run.cwd, label: run.chatId ? node.title : run.label, prompt, ...chat, coreRules: node.kind === 'implement' ? `${run.policy.coreRules}\n\n${run.policy.implementationRules}` : run.policy.coreRules, mcpServers: node.mcpServers, workflowRunId: run.id, workflowNodeId: node.id, workflowAttempt: attempt.number, terminalId: run.terminalId }, deps.resolver)
    if (!result.ok) return block(run, result.error)
    attempt.jobId = result.job.id; attempt.status = 'running'
    await persist(run)
    const job = deps.manager.getJob(result.job.id)
    if (job && job.status !== 'running') queueMicrotask(() => { void onJobSettled(job).catch(error => block(run, String(error))) })
  }
  function chatDefaultFor(input: z.infer<typeof startSchema>): ChatDefault | undefined {
    if (!input.chat) {
      if (input.chatTurn) throw new Error('A chat turn needs its chat')
      return input.engine ? { engine: input.engine, model: input.model ?? null } : undefined
    }
    const root = deps.manager.getJob(input.chat)
    if (!root || root.purpose !== 'chat' || threadRootOf(root) !== root.id) throw new Error('Chat not found')
    const turn = input.chatTurn ? deps.manager.getJob(input.chatTurn) : root
    if (!turn || threadRootOf(turn) !== root.id) throw new Error('Chat turn not found in this chat')
    return input.engine ? { engine: input.engine, model: input.model ?? null } : { engine: root.engine, model: root.model }
  }
  async function start(value: unknown, context: { startedByUser: boolean } = { startedByUser: false }): Promise<WorkflowRun> {
    const action = starts.then(async () => {
      const input = startSchema.parse(value)
      if (input.graph !== undefined && input.workflowId) throw new Error('Use either a saved workflow or a drafted graph')
      const chatDefault = chatDefaultFor(input)
      const cwd = await validateWorkspaceCwd(input.cwd)
      if (!cwd.ok) throw new Error(cwd.error)
      const terminal = input.terminalId ? deps.terminals?.get(input.terminalId) : undefined
      if (input.terminalId && !terminal) throw new Error('Terminal not found; open a new terminal before starting its workflow')
      if (terminal && terminal.cwd !== cwd.path) throw new Error('Use this terminal’s project directory')
      const selection = terminal?.workflow
      if (terminal && !selection) throw new Error('This terminal has no pinned workflow; open a new terminal')
      const workflow = input.graph !== undefined ? draftRevision(input.graph) : input.workflowId ? await deps.store.get(input.workflowId, input.revision) : selection ? await deps.store.get(selection.id, selection.revision) : await deps.store.selected()
      if (workspaceBusy(cwd.path)) throw new Error('Workspace already has running work')
      const agents = await agentsFor(workflow, chatDefault)
      const policy = await deps.store.policy()
      const skills = Object.fromEntries(await Promise.all(workflow.nodes.map(async node => [node.id, await snapshotSkills(node, cwd.path)])))
      const chat = input.chat ? { chatId: input.chat, ...(input.chatTurn ? { chatTurn: input.chatTurn } : {}), reportedAt: null } : {}
      const by = terminal?.engine ?? (input.chat ? deps.manager.getJob(input.chat)?.engine : undefined) ?? 'you'
      const where = terminal ? 'terminal' : input.chat ? 'chat' : 'studio'
      const waits = !context.startedByUser && await requireApproval()
      const version: RunVersion = { number: 1, revision: workflow.revision, reason: 'Initial flow', size: 'initial', state: waits ? 'pending' : 'approved', approvedVia: waits ? null : context.startedByUser ? 'user' : 'auto', relayedBy: null, at: Date.now() }
      const run: WorkflowRun = { id: crypto.randomUUID(), ...(input.terminalId ? { terminalId: input.terminalId } : {}), ...chat, label: input.label, cwd: cwd.path, request: input.request, workflow, policy, agents, skills, status: waits ? 'awaiting-approval' : 'running', error: null, origin: { source: input.graph !== undefined ? 'drafted' : 'saved', by, where }, versions: [version], currentNodeId: workflow.entry, attempts: [], createdAt: Date.now(), updatedAt: Date.now() }
      if (!deps.manager.claimWorkspace(run.cwd, run.id)) throw new Error('Workspace already has running work')
      await persist(run)
      if (!waits) await exclusive(run.id, () => dispatch(run))
      return structuredClone(run)
    })
    starts = action.catch(() => {})
    return action
  }
  async function redactRunOutput(run: WorkflowRun, text: string): Promise<string> {
    const references = Object.values(run.agents).flatMap(agent => [...Object.values(agent.connection?.env ?? {}), agent.connection?.apiKeyEnv]).filter((value): value is string => !!value)
    references.push(...run.workflow.nodes.flatMap(node => node.mcpServers.flatMap(server => Object.values(server.env))))
    const values = [(await readSecrets()).zaiAuthToken, ...references.map(reference => process.env[reference] ?? null)]
    return values.reduce<string>((output, secret) => redactSecrets(output, secret), text)
  }
  async function runCheck(run: WorkflowRun, check: WorkflowNode['checks'][number]): Promise<CheckResult> {
    const proc = spawn(resolveBinary(check.command), check.args, { cwd: run.cwd, env: { ...process.env, MC_WORKFLOW_RUN_ID: run.id }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const completion = new Promise<number | null>((resolveExit, reject) => { proc.once('error', reject); proc.once('exit', resolveExit) })
    void completion.catch(() => {})
    const attempt = run.attempts.at(-1)!
    attempt.checkPid = proc.pid
    let output = '', timedOut = false
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16000) }
    proc.stdout.on('data', collect); proc.stderr.on('data', collect)
    const kill = () => { try { if (proc.pid) process.kill(-proc.pid, 'SIGTERM') } catch {}; setTimeout(() => { try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL') } catch {} }, 1000).unref() }
    checks.set(run.id, kill)
    const timer = setTimeout(() => { timedOut = true; kill() }, check.timeoutSeconds * 1000)
    try {
      await persist(run)
      const exitCode = await completion
      return { command: check.command, args: check.args, exitCode, output: await redactRunOutput(run, output), timedOut }
    } catch (error) {
      return { command: check.command, args: check.args, exitCode: null, output: (error as Error).message, timedOut }
    } finally { clearTimeout(timer); checks.delete(run.id); delete attempt.checkPid }
  }
  async function settle(run: WorkflowRun, record: JobRecord): Promise<void> {
    if ((run.status !== 'running' && run.status !== 'paused') || stopping.has(run.id)) return
    const attempt = run.attempts.at(-1)
    if (!attempt || attempt.jobId !== record.id || attempt.status === 'settled') return
    const node = run.workflow.nodes.find(node => node.id === attempt.nodeId)!
    const log = await redactRunOutput(run, await readLogFile(deps.manager.logPath(record.id)))
    const messages = parseThread(log)
    attempt.output = (messages.findLast(event => event.kind === 'result')?.detail ?? messages.filter(event => event.kind === 'text').map(event => event.detail).join('\n')).slice(-64000)
    let result = readNodeResult(log)
    if (record.status !== 'done' && result?.outcome !== 'blocked') result = { outcome: 'fail', summary: `Agent process failed (${record.exitCode ?? 'unknown exit'})`, evidence: [] }
    if (!result || (result.outcome === 'pass' && !result.evidence.length)) result = { outcome: 'blocked', summary: 'Agent did not provide a valid MC_RESULT with evidence', evidence: [] }
    attempt.result = result
    if (result.outcome === 'pass' && node.checks.length) {
      attempt.status = 'checking'
      await persist(run)
      for (const check of node.checks) {
        if (stopping.has(run.id)) return
        const checked = await runCheck(run, check)
        attempt.checks.push(checked)
        await persist(run)
        if (checked.exitCode !== 0 || checked.timedOut) { result = { ...result, outcome: 'fail', summary: `Acceptance check failed: ${check.command}` }; break }
      }
    }
    if (stopping.has(run.id)) return
    attempt.workspace = await workspaceSnapshot(run.cwd)
    attempt.result = result; attempt.status = 'settled'; attempt.endedAt = Date.now()
    const edge = run.workflow.edges.find(edge => edge.source === node.id && edge.outcome === result.outcome)
    if (edge) {
      run.currentNodeId = edge.target
      await persist(run)
      if (run.status === 'running') await dispatch(run)
    } else {
      await finish(run, result.outcome === 'pass' ? 'done' : result.outcome === 'fail' ? 'failed' : 'blocked', result.outcome === 'pass' ? null : result.summary)
    }
  }
  async function onJobSettled(record: JobRecord): Promise<void> {
    if (!record.workflowRunId || record.status === 'running') return
    const run = runs.get(record.workflowRunId)
    if (!run) return
    await exclusive(run.id, async () => {
      try { if (run.status !== 'running' && run.status !== 'paused') await persist(run); else await settle(run, record) }
      catch (error) { await block(run, error instanceof Error ? error.message : 'Workflow settlement failed') }
    })
  }
  async function stop(id: string): Promise<WorkflowRun> {
    const run = runs.get(id)
    if (!run) throw new Error('Run not found')
    if (!LIVE_STATUSES.has(run.status)) throw new Error('Run is not running')
    if (run.status === 'awaiting-approval') for (const version of run.versions.filter(version => version.state === 'pending')) Object.assign(version, { state: 'rejected', at: Date.now() })
    stopping.add(id)
    checks.get(id)?.()
    const jobId = run.attempts.at(-1)?.jobId
    if (jobId && deps.manager.getJob(jobId)?.status === 'running') await deps.manager.killJob(jobId)
    return exclusive(id, async () => {
      const latestJob = run.attempts.at(-1)?.jobId
      if (latestJob && deps.manager.getJob(latestJob)?.status === 'running') await deps.manager.killJob(latestJob)
      await finish(run, 'stopped', 'Stopped by user'); stopping.delete(id)
      return structuredClone(run)
    })
  }
  async function retry(id: string): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = runs.get(id)
      if (!run) throw new Error('Run not found')
      if (LIVE_STATUSES.has(run.status) || run.status === 'done') throw new Error('Only failed, blocked or stopped runs can be retried')
      if (run.versions[0]?.state !== 'approved') throw new RunActionError('Approve the flow before retrying', 409)
      if (workspaceBusy(run.cwd, id) || deps.manager.listJobs().some(job => job.workflowRunId === id && job.status === 'running')) throw new Error('Workspace still has running work')
      const previous = run.attempts.at(-1)
      if (processAlive(previous?.checkPid)) throw new Error('The interrupted acceptance process may still be running; inspect it before retrying')
      if (previous && previous.status !== 'settled') previous.status = 'settled'
      if (!deps.manager.claimWorkspace(run.cwd, run.id)) throw new Error('Workspace already has running work')
      run.status = 'running'; run.error = null
      if (run.chatId) run.reportedAt = null
      await persist(run)
      await dispatch(run)
      return structuredClone(run)
    })
  }
  async function recover(): Promise<void> {
    for (const run of runs.values()) {
      const lastStatus = run.attempts.at(-1)?.status
      if (run.status === 'awaiting-approval' || (run.status === 'paused' && (lastStatus === undefined || lastStatus === 'settled'))) { if (!deps.manager.claimWorkspace(run.cwd, run.id)) await block(run, 'Another run owns this workspace'); continue }
      if (run.status !== 'running' && run.status !== 'paused') { if (processAlive(run.attempts.at(-1)?.checkPid)) deps.manager.claimWorkspace(run.cwd, run.id); continue }
      if (!deps.manager.claimWorkspace(run.cwd, run.id)) { await block(run, 'Another run owns this workspace'); continue }
      const attempt = run.attempts.at(-1)
      const job = attempt ? deps.manager.listJobs().find(job => job.workflowRunId === run.id && job.workflowAttempt === attempt.number) : undefined
      if (!attempt || !job || attempt.status === 'checking' || attempt.status === 'settled') { await block(run, `Interrupted transition or acceptance check; inspect evidence${attempt?.checkPid ? ` and process ${attempt.checkPid}` : ''} before retrying`); continue }
      attempt.jobId = job.id; attempt.status = 'running'
      await persist(run)
      if (job.status !== 'running') await onJobSettled(job)
    }
  }
  function owned(run: WorkflowRun, context: ApprovalContext): void {
    if (context.via !== 'conversation') return
    const matches = (context.chat && context.chat === run.chatId) || (context.terminalId && context.terminalId === run.terminalId)
    if (!matches) throw new RunActionError('This flow belongs to a different session', 403)
  }
  function pendingVersion(run: WorkflowRun, context: ApprovalContext): RunVersion {
    const version = run.versions.find(version => version.state === 'pending')
    if (!version) throw new RunActionError('Nothing is waiting for approval', 409)
    if (context.version !== undefined && context.version !== version.number) throw new RunActionError('That version is no longer waiting', 409)
    return version
  }
  function mustGet(id: string): WorkflowRun {
    const run = runs.get(id)
    if (!run) throw new RunActionError('Run not found', 404)
    return run
  }
  async function approve(id: string, context: ApprovalContext): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = mustGet(id)
      owned(run, context)
      const version = pendingVersion(run, context)
      Object.assign(version, { state: 'approved', approvedVia: context.via, relayedBy: context.via === 'conversation' ? run.origin.by : null, at: Date.now() })
      if (run.status === 'awaiting-approval') { run.status = 'running'; await persist(run); await dispatch(run) } else await persist(run)
      return structuredClone(run)
    })
  }
  async function reject(id: string, context: ApprovalContext): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = mustGet(id)
      owned(run, context)
      const version = pendingVersion(run, context)
      Object.assign(version, { state: 'rejected', at: Date.now() })
      if (run.status === 'awaiting-approval') await finish(run, 'stopped', 'Flow rejected')
      else await persist(run)
      return structuredClone(run)
    })
  }
  async function pause(id: string): Promise<WorkflowRun> {
    const run = mustGet(id)
    if (run.status !== 'running') throw new RunActionError('Only a running flow can be paused', 409)
    run.status = 'paused'
    return exclusive(id, async () => { await persist(run); return structuredClone(run) })
  }
  async function resume(id: string): Promise<WorkflowRun> {
    return exclusive(id, async () => {
      const run = mustGet(id)
      if (run.status !== 'paused') throw new RunActionError('Only a paused flow can be resumed', 409)
      run.status = 'running'
      await persist(run)
      const last = run.attempts.at(-1)
      if (!last || last.status === 'settled') await dispatch(run)
      return structuredClone(run)
    })
  }
  async function markReported(id: string, at: number): Promise<void> {
    await exclusive(id, async () => {
      const run = runs.get(id)
      if (!run) return
      run.reportedAt = at
      await persist(run)
    })
  }
  return { start, stop, retry, recover, approve, reject, pause, resume, onJobSettled, markReported, get: (id: string) => { const run = runs.get(id); return run ? structuredClone(run) : undefined }, list: () => [...runs.values()].map(run => structuredClone(run)).sort((a, b) => b.createdAt - a.createdAt) }
}
export type WorkflowRunner = ReturnType<typeof createWorkflowRunner>
