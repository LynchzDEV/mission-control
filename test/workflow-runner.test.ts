import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobManager, type JobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { createWorkflowStore, defaultWorkflow, draftRevision, type Workflow } from '../server/workflows'
import { changeSize, covers, createWorkflowRunner, lineage, RunActionError, type ResolvedAgent, type WorkflowRun, type WorkflowRunner } from '../server/workflow-runner'
import * as worktrees from '../server/job-worktrees'
import { initScratchGitRepo } from './support/scratch-git-repo'
import type { TerminalRecord } from '../server/terminals'

let dir: string, repo: string, manager: JobManager, runner: WorkflowRunner, settledRuns: WorkflowRun[]
const report = (outcome = 'pass') => JSON.stringify({ type: 'result', result: `MC_RESULT ${JSON.stringify({ outcome, summary: 'Completed fixture', evidence: ['fixture assertion'] })}` })
const resolver: EngineResolver = () => ({ cmd: '/bin/echo', args: [report()], env: {} })
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-workflow-runner-'))
  repo = await mkdtemp(join(homedir(), 'mc-workflow-repo-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
  await initScratchGitRepo(repo)
})
afterEach(async () => {
  for (const run of runner?.list() ?? []) if (run.status === 'running') await runner.stop(run.id)
  for (const job of manager?.listJobs() ?? []) if (job.status === 'running') await manager.killJob(job.id)
  const deadline = Date.now() + 4000
  while (manager?.listJobs().some(job => job.status === 'running')) {
    if (Date.now() > deadline) throw new Error('Fixture jobs did not stop before cleanup')
    await Bun.sleep(20)
  }
  for (const job of manager?.listJobs() ?? []) await runner.onJobSettled(job)
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})
function build(agent: EngineResolver = resolver, approval = false) {
  const store = createWorkflowStore(dir)
  const settled: WorkflowRun[] = []
  settledRuns = settled
  manager = createJobManager({ onJobSettled: job => { void runner.onJobSettled(job) } })
  runner = createWorkflowRunner({ manager, resolver: agent, store, base: dir, requireApproval: async () => approval, onRunSettled: run => { settled.push(run) } })
  return store
}
async function finished(id: string) {
  for (let i = 0; i < 200; i++) { const run = runner.get(id)!; if (!['running', 'paused', 'awaiting-approval'].includes(run.status)) return run; await Bun.sleep(20) }
  throw new Error('Run did not settle')
}
async function until(id: string, predicate: (run: WorkflowRun) => boolean) {
  for (let i = 0; i < 200; i++) { const run = runner.get(id)!; if (predicate(run)) return run; await Bun.sleep(20) }
  throw new Error('Run never reached the expected state')
}

test('default workflow executes four nodes with pinned policy and no mandatory commits', async () => {
  build()
  const started = await runner.start({ cwd: repo, request: 'Inspect and implement the fixture', label: 'fixture' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'execute', 'review'])
  expect(done.attempts.every(attempt => attempt.prompt.includes('Never dispatch'))).toBe(true)
  expect(manager.listJobs().every(job => job.workflowRunId === done.id)).toBe(true)
})

test('terminal runs default to their pinned workflow, let a named workflow override it, and reject unknown terminals', async () => {
  const store = build()
  const first = await store.save({ ...defaultWorkflow(), id: 'terminal-workflow', name: 'Original terminal workflow' })
  const terminal: TerminalRecord = { id: 'terminal-a', engine: 'claude', cwd: repo, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, workflow: { id: first.id, name: first.name, revision: first.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, terminals: { get: id => id === terminal.id ? terminal : undefined }, requireApproval: async () => false })
  const next = await store.save({ ...first, name: 'Changed after terminal opened' }, first.revision)
  await store.setDefault(next.id, next.revision)
  const input = { terminalId: terminal.id, cwd: repo, request: 'Inspect this project', label: 'terminal task' }
  await expect(runner.start({ ...input, terminalId: 'unknown' })).rejects.toThrow('Terminal not found')
  expect(manager.listJobs()).toHaveLength(0)
  const started = await runner.start(input)
  expect(started.workflow.revision).toBe(first.revision)
  expect(started.terminalId).toBe(terminal.id)
  expect((await finished(started.id)).status).toBe('done')
  expect(manager.listJobs().every(job => job.terminalId === terminal.id)).toBe(true)
  const named = await runner.start({ ...input, workflowId: 'default' })
  expect(named.workflow.id).toBe('default')
  await finished(named.id)
})

test('free-form E2E nodes require real checks; a failing check overrides AI pass', async () => {
  const store = build()
  const graph = await store.save({ ...defaultWorkflow(), id: 'e2e', entry: 'test', nodes: [{ id: 'test', title: 'E2E', instructions: 'Test with Jev', checks: [{ command: '/usr/bin/false' }] }], edges: [] })
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Test checkout', label: 'e2e' })
  const done = await finished(run.id)
  expect(done.status).toBe('failed')
  expect(done.attempts[0]!.checks[0]!.exitCode).toBe(1)
})

test('missing structured evidence blocks progress even when process exits zero', async () => {
  build(() => ({ cmd: '/bin/echo', args: ['All done'], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'missing-evidence' })
  expect((await finished(run.id)).status).toBe('blocked')
  expect(manager.listJobs()).toHaveLength(1)
})

test('custom blueprint revisions and policy changes cannot alter a retry', async () => {
  const store = build(() => ({ cmd: '/bin/echo', args: [report('fail')], env: {} }))
  const first = await store.save({ ...defaultWorkflow(), id: 'custom' })
  const run = await runner.start({ workflowId: first.id, cwd: repo, request: 'Inspect', label: 'retry' })
  await finished(run.id)
  await store.save({ ...first, name: 'New name' }, first.revision)
  await store.savePolicy('New policy\n{{core_rules}}\n{{workflow}}\n{{assignment}}')
  await runner.retry(run.id)
  const retried = await finished(run.id)
  expect(retried.workflow.revision).toBe(first.revision)
  expect(retried.policy.revision).toBe(run.policy.revision)
  expect(retried.attempts[1]!.prompt).not.toContain('New policy')
})

test('a running workflow reserves its workspace against other workflows and ordinary jobs', async () => {
  build(() => ({ cmd: '/bin/sleep', args: ['2'], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'owner' })
  await expect(runner.start({ cwd: repo, request: 'Other', label: 'intruder' })).rejects.toThrow('running work')
  const job = await manager.createJob({ engine: 'claude', cwd: repo, prompt: 'Other', label: 'intruder' }, resolver)
  expect(job.ok).toBe(false)
  await runner.stop(run.id)
})

test('failure routing is bounded and does not turn an endless loop into success', async () => {
  const store = build(() => ({ cmd: '/bin/echo', args: [report('fail')], env: {} }))
  const graph = await store.save({ ...defaultWorkflow(), id: 'loop', entry: 'test', nodes: [{ id: 'test', title: 'Test', instructions: 'Check', maxVisits: 2 }], edges: [{ source: 'test', target: 'test', outcome: 'fail' }] })
  const run = await runner.start({ workflowId: graph.id, cwd: repo, request: 'Test', label: 'loop' })
  const done = await finished(run.id)
  expect(done.status).toBe('blocked')
  expect(done.attempts).toHaveLength(2)
  expect(done.error).toContain('visit limit')
})

test('same model family through different engine names cannot perform cross-family review', async () => {
  const store = build()
  const graph = defaultWorkflow()
  graph.id = 'same-family'
  graph.nodes[2]!.agent = { role: 'execute', engine: 'claude', model: 'claude-opus' }
  graph.nodes[3]!.agent = { role: 'review', engine: 'codex', model: 'anthropic/claude-sonnet' }
  await store.save(graph)
  await expect(runner.start({ workflowId: graph.id, cwd: repo, request: 'Implement', label: 'families' })).rejects.toThrow('different model family')
  expect(manager.listJobs()).toHaveLength(0)
})

test('restart adopts an existing running job and continues without dispatching it twice', async () => {
  const store = build(({ prompt }) => ({ cmd: process.execPath, args: ['-e', `setTimeout(() => console.log(${JSON.stringify(report())}), 150)`], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'restart' })
  runner = createWorkflowRunner({ manager, resolver, store, base: dir })
  await runner.recover()
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.attempts).toHaveLength(4)
  expect(manager.listJobs()).toHaveLength(4)
})

test('a terminal agent error overrides an earlier claimed pass even with exit zero', async () => {
  build(() => ({ cmd: '/usr/bin/printf', args: ['%s\n%s\n', report(), JSON.stringify({ type: 'result', is_error: true, result: 'Provider failed' })], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'false-success' })
  expect((await finished(run.id)).status).toBe('failed')
  expect(manager.listJobs()).toHaveLength(1)
})

test('stopping an acceptance command prevents the next node from starting', async () => {
  const store = build()
  await store.save({ ...defaultWorkflow(), id: 'slow-check', entry: 'test', nodes: [{ id: 'test', title: 'Check', instructions: 'Check', checks: [{ command: '/bin/sleep', args: ['20'], timeoutSeconds: 30 }] }, { id: 'next', title: 'Next', instructions: 'Inspect' }], edges: [{ source: 'test', target: 'next', outcome: 'pass' }] })
  const run = await runner.start({ workflowId: 'slow-check', cwd: repo, request: 'Inspect', label: 'stop-check' })
  for (let i = 0; i < 100 && !runner.get(run.id)?.attempts[0]?.checkPid; i++) await Bun.sleep(20)
  expect(runner.get(run.id)?.attempts[0]?.status).toBe('checking')
  await runner.stop(run.id)
  expect(runner.get(run.id)?.status).toBe('stopped')
  expect(manager.listJobs()).toHaveLength(1)
})

test('registered ACP agents work through the existing job manager with advertised resume support', async () => {
  const { realEngineResolver } = await import('../server/jobs-engine-iface')
  const { createConnectionStore } = await import('../server/agent-connections')
  build(realEngineResolver)
  await createConnectionStore(dir).save({ id: 'fixture-acp', name: 'Fixture ACP', adapter: 'acp', command: process.execPath, args: [join(import.meta.dir, 'fixtures/agents/acp.ts')] })
  const created = await manager.createJob({ engine: 'fixture-acp', cwd: repo, prompt: 'Inspect', label: 'custom-agent' }, realEngineResolver)
  expect(created.ok).toBe(true)
  if (!created.ok) return
  for (let i = 0; i < 100 && manager.getJob(created.job.id)?.status === 'running'; i++) await Bun.sleep(20)
  expect(manager.getJob(created.job.id)).toMatchObject({ status: 'done', sessionId: 'fixture-session', resumeSupported: true })
})

test('stop during dispatch also terminates the job that finishes launching afterwards', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  build(async () => { await gate; return { cmd: '/bin/sleep', args: ['20'], env: {} } })
  const starting = runner.start({ cwd: repo, request: 'Inspect', label: 'stop-dispatch' })
  for (let i = 0; i < 100 && runner.list().length === 0; i++) await Bun.sleep(10)
  const id = runner.list()[0]!.id
  const stopping = runner.stop(id)
  release()
  await starting
  await stopping
  for (let i = 0; i < 100 && manager.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
  expect(runner.get(id)?.status).toBe('stopped')
  expect(manager.listJobs().some(job => job.status === 'running')).toBe(false)
})

async function chatRoot(engine = 'claude', model?: string) {
  const created = await manager.createJob({ engine, ...(model ? { model } : {}), cwd: repo, prompt: 'Run the shipping workflow', label: 'Shipping chat', purpose: 'chat' }, () => ({ cmd: '/bin/echo', args: ['hi'], env: {} }))
  if (!created.ok) throw new Error(created.error)
  for (let i = 0; i < 200 && manager.getJob(created.job.id)?.status === 'running'; i++) await Bun.sleep(20)
  return created.job
}
async function settledStatuses() {
  for (let i = 0; i < 200 && settledRuns.length === 0; i++) await Bun.sleep(10)
  return settledRuns.map(settled => settled.status)
}
const stepJobs = () => manager.listJobs().filter(job => job.workflowRunId).sort((a, b) => a.workflowAttempt! - b.workflowAttempt!)

test('a chat run puts Chat decides steps on the chat AI, keeps pinned steps, and files its jobs under the chat', async () => {
  const store = build()
  const graph = defaultWorkflow()
  graph.id = 'shipping'; graph.name = 'Shipping'
  graph.nodes[0]!.agent = { role: 'plan', engine: 'codex' }
  await store.save(graph)
  const root = await chatRoot()
  const run = await runner.start({ workflowId: 'shipping', cwd: repo, request: 'Ship it', label: 'ship', chat: root.id, chatTurn: root.id, engine: 'claude', model: 'claude-opus-4' })
  expect(run.chatId).toBe(root.id)
  expect(run.chatTurn).toBe(root.id)
  expect(run.agents.plan).toMatchObject({ engine: 'codex', model: null })
  expect(run.agents['verify-plan']).toMatchObject({ engine: 'claude', model: 'claude-opus-4', family: 'claude' })
  expect(run.agents.execute).toMatchObject({ engine: 'claude', model: 'claude-opus-4', family: 'claude' })
  expect(run.agents.review).toMatchObject({ engine: 'codex', family: 'gpt' })
  const done = await finished(run.id)
  expect(done.status).toBe('done')
  expect(done.reportedAt).toBeNull()
  expect(stepJobs().map(job => job.label)).toEqual(['Plan', 'Verify plan', 'Execute', 'Cross-family review'])
  for (const job of stepJobs()) {
    expect(job).toMatchObject({ chatId: root.id, chatTurn: root.id, reason: `Studio · Shipping · ${job.label}` })
    expect(job.reportedAt).toBeUndefined()
  }
  expect(await settledStatuses()).toEqual(['done'])
})

test('a chat run without an engine uses the chat root AI for Chat decides steps', async () => {
  build()
  const root = await chatRoot('glm')
  const run = await runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id })
  expect(run.agents.plan).toMatchObject({ engine: 'glm' })
  expect(run.agents.execute).toMatchObject({ engine: 'glm' })
  expect(run.agents.review).toMatchObject({ engine: 'codex' })
  expect((await finished(run.id)).status).toBe('done')
})

test('a run outside a chat keeps the stored roles and plain labels', async () => {
  build(() => ({ cmd: '/bin/echo', args: ['All done'], env: {} }))
  const run = await runner.start({ cwd: repo, request: 'Inspect', label: 'plain' })
  expect(run.agents.plan).toMatchObject({ engine: 'claude' })
  expect(run.agents.execute).toMatchObject({ engine: 'glm' })
  expect(run.chatId).toBeUndefined()
  const done = await finished(run.id)
  expect(done.reportedAt).toBeUndefined()
  expect(stepJobs().every(job => job.label === 'plain' && job.chatId === undefined && job.reason === undefined)).toBe(true)
  expect(await settledStatuses()).toEqual(['blocked'])
})

test('a chat run rejects an unknown chat or a turn from another chat', async () => {
  build()
  const root = await chatRoot()
  await expect(runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: 'no-such-chat' })).rejects.toThrow('Chat not found')
  await expect(runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id, chatTurn: 'no-such-turn' })).rejects.toThrow('Chat turn not found')
  expect(runner.list()).toHaveLength(0)
})

test('a chat run loops past the chat retry cap up to its own visit limit', async () => {
  const store = build(() => ({ cmd: '/bin/echo', args: [report('fail')], env: {} }))
  await store.save({ ...defaultWorkflow(), id: 'chat-loop', entry: 'test', nodes: [{ id: 'test', title: 'Test', instructions: 'Check', maxVisits: 4 }], edges: [{ source: 'test', target: 'test', outcome: 'fail' }] })
  const root = await chatRoot()
  const run = await runner.start({ workflowId: 'chat-loop', cwd: repo, request: 'Test', label: 'loop', chat: root.id })
  const done = await finished(run.id)
  expect(done.attempts).toHaveLength(4)
  expect(done.error).toContain('visit limit')
})

test('stopping a chat run settles it once, and a report mark survives a restart', async () => {
  const store = build(() => ({ cmd: '/bin/sleep', args: ['20'], env: {} }))
  const root = await chatRoot()
  const run = await runner.start({ cwd: repo, request: 'Ship it', label: 'ship', chat: root.id })
  await runner.stop(run.id)
  expect(await settledStatuses()).toEqual(['stopped'])
  await runner.markReported(run.id, 1234)
  expect(createWorkflowRunner({ manager, resolver, store, base: dir }).get(run.id)?.reportedAt).toBe(1234)
})

test('a run started by a session AI waits for approval and dispatches nothing', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  expect(started.status).toBe('awaiting-approval')
  expect(started.versions).toEqual([expect.objectContaining({ number: 1, state: 'pending', approvedVia: null, size: 'initial' })])
  expect(started.origin).toEqual({ source: 'saved', by: 'you', where: 'studio' })
  await Bun.sleep(100)
  expect(manager.listJobs()).toHaveLength(0)
})

test('approving from the drawer records the source and runs the flow', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  const approved = await runner.approve(started.id, { via: 'drawer' })
  expect(approved.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'drawer', relayedBy: null }))
  expect((await finished(started.id)).status).toBe('done')
})

test('a second approval of the same version is a conflict and dispatches once', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  const results = await Promise.allSettled([runner.approve(started.id, { via: 'drawer' }), runner.approve(started.id, { via: 'drawer' })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  expect((rejected.reason as RunActionError).status).toBe(409)
  const done = await finished(started.id)
  expect(done.attempts.filter(attempt => attempt.nodeId === 'plan')).toHaveLength(1)
})

test('a relayed approval must come from the session that owns the run', async () => {
  const store = build(resolver, true)
  const first = await store.save({ ...defaultWorkflow(), id: 'terminal-workflow', name: 'Terminal workflow' })
  const terminal: TerminalRecord = { id: 'terminal-a', engine: 'codex', cwd: repo, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, workflow: { id: first.id, name: first.name, revision: first.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, terminals: { get: id => id === terminal.id ? terminal : undefined }, requireApproval: async () => true })
  const started = await runner.start({ terminalId: 'terminal-a', cwd: repo, request: 'Implement', label: 'fixture' })
  expect(started.origin).toEqual({ source: 'saved', by: 'codex', where: 'terminal' })
  await expect(runner.approve(started.id, { via: 'conversation', terminalId: 'terminal-b' })).rejects.toMatchObject({ status: 403 })
  const approved = await runner.approve(started.id, { via: 'conversation', terminalId: 'terminal-a' })
  expect(approved.versions[0]).toEqual(expect.objectContaining({ approvedVia: 'conversation', relayedBy: 'codex' }))
})

test('rejecting the first version stops the run and frees the workspace', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const rejected = await runner.reject(started.id, { via: 'drawer' })
  expect(rejected.status).toBe('stopped')
  expect(rejected.versions[0]!.state).toBe('rejected')
  const next = await runner.start({ cwd: repo, request: 'Again', label: 'second' })
  expect(next.status).toBe('awaiting-approval')
})

test('runs the user starts from the browser, or with approval off, start at once', async () => {
  build(resolver, true)
  const byUser = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  expect(byUser.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'user' }))
  await finished(byUser.id)
  await settledStatuses()
  build(resolver, false)
  const auto = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  expect(auto.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'auto' }))
  await finished(auto.id)
})

test('a paused run records the finished step but starts nothing new until resumed', async () => {
  const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.3; echo '${report()}'`], env: {} })
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const paused = await runner.pause(started.id)
  expect(paused.status).toBe('paused')
  const moved = await until(started.id, run => run.attempts[0]?.status === 'settled')
  expect(moved.status).toBe('paused')
  expect(moved.currentNodeId).toBe('verify-plan')
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
  await runner.resume(started.id)
  expect((await finished(started.id)).status).toBe('done')
})

test('after a restart a waiting or paused run keeps its status and its workspace', async () => {
  const store = build(resolver, true)
  const waiting = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => true })
  await reloaded.recover()
  expect(reloaded.get(waiting.id)!.status).toBe('awaiting-approval')
  await expect(reloaded.start({ cwd: repo, request: 'Other', label: 'other' })).rejects.toThrow('Workspace already has running work')
})

test('a rejected first version cannot be retried into running', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.reject(started.id, { via: 'drawer' })
  await expect(runner.retry(started.id)).rejects.toMatchObject({ status: 409 })
  expect(manager.listJobs()).toHaveLength(0)
})

test('pausing takes effect at once, even while a step is settling', async () => {
  const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.2; echo '${report()}'`], env: {} })
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const pausing = runner.pause(started.id)
  expect(runner.get(started.id)!.status).toBe('paused')
  await pausing
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  await Bun.sleep(150)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
})

test('a run paused between steps survives a restart still paused', async () => {
  const store = build(resolver, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.pause(started.id)
  await until(started.id, run => run.attempts.at(-1)?.status === 'settled')
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  await reloaded.recover()
  expect(reloaded.get(started.id)!.status).toBe('paused')
  await reloaded.resume(started.id)
})

test('a paused run caught mid acceptance check is blocked on restart, not left paused', async () => {
  const store = build(resolver, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  await settledStatuses()
  const file = join(dir, 'workflow-runs', `${done.id}.json`)
  const record = JSON.parse(await Bun.file(file).text()) as WorkflowRun
  record.status = 'paused'
  record.attempts.at(-1)!.status = 'checking'
  await Bun.write(file, JSON.stringify(record))
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  await reloaded.recover()
  const recovered = reloaded.get(done.id)!
  expect(recovered.status).toBe('blocked')
  expect(recovered.error).toContain('Interrupted transition or acceptance check')
})

test('every persisted change is reported through onChange', async () => {
  const store = createWorkflowStore(dir)
  manager = createJobManager({ onJobSettled: job => { void runner.onJobSettled(job) } })
  const seen: string[] = []
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => true, onChange: run => { seen.push(run.status) } })
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.approve(started.id, { via: 'drawer' })
  await finished(started.id)
  for (let i = 0; i < 100 && seen.at(-1) !== 'done'; i++) await Bun.sleep(10)
  expect(seen[0]).toBe('awaiting-approval')
  expect(seen).toContain('running')
  expect(seen.at(-1)).toBe('done')
})

test('a drafted graph runs as a drafted flow and is not saved', async () => {
  const store = build(resolver, true)
  const graph = { ...defaultWorkflow(), id: 'drafted-export', name: 'Drafted export' }
  const started = await runner.start({ cwd: repo, request: 'Add export', label: 'export', graph })
  expect(started.origin.source).toBe('drafted')
  expect(started.workflow.name).toBe('Drafted export')
  expect(started.status).toBe('awaiting-approval')
  expect((await store.list()).map(workflow => workflow.id)).not.toContain('drafted-export')
})

test('a drafted graph that breaks a rule is refused and claims nothing', async () => {
  build(resolver, true)
  const graph = { ...defaultWorkflow(), id: 'unsafe', name: 'Unsafe', edges: [{ source: 'plan', target: 'execute', outcome: 'pass' }] }
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', graph })).rejects.toThrow('requires a verified plan')
  expect(runner.list()).toHaveLength(0)
  const ok = await runner.start({ cwd: repo, request: 'x', label: 'x' })
  expect(ok.status).toBe('awaiting-approval')
})

test('a saved workflow and a drafted graph cannot both be named', async () => {
  build(resolver, true)
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', workflowId: 'default', graph: defaultWorkflow() })).rejects.toThrow('Use either a saved workflow or a drafted graph')
})

const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.3; echo '${report()}'`], env: {} })
const family = (engine: string, name: string): ResolvedAgent => ({ engine, model: null, family: name })
const defaultAgents = { plan: family('claude', 'claude'), 'verify-plan': family('codex', 'gpt'), execute: family('glm', 'glm'), review: family('codex', 'gpt') }
function withCheck(): Workflow {
  const graph = defaultWorkflow()
  graph.nodes.push({ ...graph.nodes[3]!, id: 'check', title: 'Run tests', kind: 'task', instructions: 'Run the test suite' })
  graph.edges = graph.edges.filter(edge => edge.source !== 'execute').concat({ source: 'execute', target: 'check', outcome: 'pass' }, { source: 'check', target: 'review', outcome: 'pass' })
  return graph
}
function withMigrate(base = defaultWorkflow()): Workflow {
  const graph = structuredClone(base)
  graph.nodes.push({ ...graph.nodes[2]!, id: 'migrate', title: 'Migrate', instructions: 'Write the migration' })
  graph.edges = graph.edges.filter(edge => edge.source !== 'verify-plan').concat({ source: 'verify-plan', target: 'migrate', outcome: 'pass' }, { source: 'migrate', target: 'execute', outcome: 'pass' })
  return graph
}

test('changeSize: a check step on the review family is small', () => {
  const run = { workflow: draftRevision(defaultWorkflow()), agents: defaultAgents }
  expect(changeSize(run, draftRevision(withCheck()), { ...defaultAgents, check: family('codex', 'gpt') }, false, 'plan')).toBe('small')
})

test('changeSize: a new implementation step on the pass path is big', () => {
  const run = { workflow: draftRevision(defaultWorkflow()), agents: defaultAgents }
  expect(changeSize(run, draftRevision(withMigrate()), { ...defaultAgents, migrate: family('glm', 'glm') }, false, 'plan')).toBe('big')
})

test('changeSize: a fix loop reached only through a failed review is small', () => {
  const graph = defaultWorkflow()
  graph.nodes.push({ ...graph.nodes[2]!, id: 'fix', title: 'Fix', instructions: 'Fix the review findings' })
  graph.edges.push({ source: 'review', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'review', outcome: 'pass' })
  const run = { workflow: draftRevision(defaultWorkflow()), agents: defaultAgents }
  expect(changeSize(run, draftRevision(graph), { ...defaultAgents, fix: family('glm', 'glm') }, false, 'plan')).toBe('small')
})

test('changeSize: dropping a second review, or a grown scope, is big', () => {
  const twin = defaultWorkflow()
  twin.nodes.push({ ...twin.nodes[3]!, id: 'review-2', title: 'Second review' })
  twin.edges.push({ source: 'review', target: 'review-2', outcome: 'pass' })
  const run = { workflow: draftRevision(twin), agents: { ...defaultAgents, 'review-2': family('codex', 'gpt') } }
  expect(changeSize(run, draftRevision(defaultWorkflow()), defaultAgents, false, 'plan')).toBe('big')
  const plain = { workflow: draftRevision(defaultWorkflow()), agents: defaultAgents }
  expect(changeSize(plain, draftRevision(withCheck()), { ...defaultAgents, check: family('codex', 'gpt') }, true, 'plan')).toBe('big')
})

test('a small change to a running flow applies at once and the flow runs through it', async () => {
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const changed = await runner.propose(started.id, { graph: withCheck(), reason: 'Run the tests before review' }, { via: 'drawer' })
  expect(changed.workflow.nodes.map(node => node.id)).toContain('check')
  expect(changed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'small', state: 'approved', approvedVia: 'auto', reason: 'Run the tests before review' }))
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'execute', 'check', 'review'])
})

test('a big change waits for approval while the running step finishes, then runs the new graph', async () => {
  build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await until(started.id, run => run.attempts[1]?.status === 'running')
  const proposed = await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  expect(proposed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'big', state: 'pending', approvedVia: null }))
  expect(proposed.workflow.revision).toBe(started.workflow.revision)
  await until(started.id, run => run.attempts[1]?.status === 'settled')
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(2)
  const approved = await runner.approve(started.id, { via: 'drawer', version: 2 })
  expect(approved.versions.at(-1)).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'drawer' }))
  expect(approved.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate'])
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

test('a proposal made while a step is settling keeps its result and holds the next step', async () => {
  const store = build(resolver, true)
  const graph = defaultWorkflow()
  graph.id = 'checked'
  graph.nodes[0]!.checks = [{ command: '/bin/sleep', args: ['0.4'], timeoutSeconds: 30 }]
  await store.save(graph)
  const started = await runner.start({ workflowId: 'checked', cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await until(started.id, run => run.attempts[0]?.status === 'checking')
  const proposed = await runner.propose(started.id, { graph: withMigrate(graph), reason: 'Needs a migration' }, { via: 'drawer' })
  expect(proposed.versions.at(-1)!.state).toBe('pending')
  expect(proposed.attempts).toHaveLength(1)
  expect(proposed.attempts[0]).toEqual(expect.objectContaining({ status: 'settled', result: expect.objectContaining({ outcome: 'pass' }) }))
  expect(proposed.attempts[0]!.checks).toHaveLength(1)
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
  await runner.approve(started.id, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

test('keeping the old version rejects the change and the old graph carries on', async () => {
  build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  await runner.reject(started.id, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.versions[1]!.state).toBe('rejected')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'execute', 'review'])
})

test('with approval off a big change applies at once', async () => {
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const changed = await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  expect(changed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'big', state: 'approved', approvedVia: 'auto' }))
  expect(changed.workflow.nodes.map(node => node.id)).toContain('migrate')
  const done = await finished(started.id)
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

test('a change may not move the entry, drop a step that ran, or rewrite one', async () => {
  const store = build(slow, false)
  const node = (id: string, title: string) => ({ id, title, instructions: `Do ${title}` })
  const chain = { ...defaultWorkflow(), id: 'chain', entry: 'a', nodes: [node('a', 'Alpha'), node('b', 'Bravo'), node('c', 'Charlie')], edges: [{ source: 'a', target: 'b', outcome: 'pass' as const }, { source: 'b', target: 'c', outcome: 'pass' as const }] }
  await store.save(chain)
  const started = await runner.start({ workflowId: 'chain', cwd: repo, request: 'Walk', label: 'chain' })
  await until(started.id, run => run.attempts[1]?.status === 'running')
  const before = runner.get(started.id)!
  const moved = { ...chain, entry: 'b', nodes: chain.nodes.slice(1), edges: chain.edges.slice(1) }
  await expect(runner.propose(started.id, { graph: moved, reason: 'x' }, { via: 'drawer' })).rejects.toThrow('Alpha must stay the first step')
  const dropped = { ...chain, nodes: [chain.nodes[0]!, chain.nodes[2]!], edges: [{ source: 'a', target: 'c', outcome: 'pass' as const }] }
  await expect(runner.propose(started.id, { graph: dropped, reason: 'x' }, { via: 'drawer' })).rejects.toThrow('Bravo already ran and cannot be removed')
  const rewritten = { ...chain, nodes: [{ ...chain.nodes[0]!, instructions: 'Something else' }, ...chain.nodes.slice(1)] }
  const refusal = await runner.propose(started.id, { graph: rewritten, reason: 'x' }, { via: 'drawer' }).catch(error => error)
  expect(refusal).not.toBeInstanceOf(RunActionError)
  expect(refusal.message).toBe('Alpha already ran, so its kind, instructions, agent and checks cannot change')
  const rechecked = { ...chain, nodes: [{ ...chain.nodes[0]!, checks: [{ command: '/usr/bin/true' }] }, ...chain.nodes.slice(1)] }
  await expect(runner.propose(started.id, { graph: rechecked, reason: 'x' }, { via: 'drawer' })).rejects.toThrow('Alpha already ran, so its kind, instructions, agent and checks cannot change')
  const after = runner.get(started.id)!
  expect(after.workflow).toEqual(before.workflow)
  expect(after.versions).toEqual(before.versions)
  expect((await finished(started.id)).attempts.map(attempt => attempt.nodeId)).toEqual(['a', 'b', 'c'])
})

test('a second proposal while one waits is a conflict', async () => {
  build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await expect(runner.propose(started.id, { graph: withCheck(), reason: 'Run the tests' }, { via: 'drawer' })).rejects.toMatchObject({ status: 409, message: 'A change is already waiting' })
  expect(runner.get(started.id)!.versions).toHaveLength(2)
})

test('a relayed change must come from the session that owns the run', async () => {
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await expect(runner.propose(started.id, { graph: withCheck(), reason: 'Run the tests' }, { via: 'conversation', terminalId: 'terminal-b' })).rejects.toMatchObject({ status: 403 })
  expect(runner.get(started.id)!.versions).toHaveLength(1)
})

test('a pending change survives a restart, still holds dispatch, and approving it afterwards runs the new graph', async () => {
  const store = build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  runner = createWorkflowRunner({ manager, resolver: slow, store, base: dir, requireApproval: async () => true })
  await runner.recover()
  const reloaded = runner.get(started.id)!
  expect(reloaded.status).toBe('running')
  expect(reloaded.versions[1]!.state).toBe('pending')
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
  expect(manager.listJobs()).toHaveLength(1)
  await runner.approve(started.id, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'migrate', 'execute', 'review'])
})

function reviewBeforeCheck(): Workflow {
  const graph = withCheck()
  graph.edges = graph.edges.filter(edge => edge.source !== 'execute' && edge.source !== 'check').concat({ source: 'execute', target: 'review', outcome: 'pass' }, { source: 'review', target: 'check', outcome: 'pass' })
  return graph
}

test('a change that moves the review behind the running step blocks the run instead of finishing it unreviewed', async () => {
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture', graph: withCheck() })
  await until(started.id, run => run.attempts[3]?.nodeId === 'check' && run.attempts[3]?.status === 'running')
  await runner.propose(started.id, { graph: reviewBeforeCheck(), reason: 'Review last is slow' }, { via: 'drawer' })
  const done = await finished(started.id)
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify-plan', 'execute', 'check'])
  expect(done.status).toBe('blocked')
  expect(done.error).toBe('Implementation finished without a cross-family review')
})

test('removing a review from the path ahead of the run is a big change', async () => {
  build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture', graph: withCheck() }, { startedByUser: true })
  await until(started.id, run => run.attempts[3]?.nodeId === 'check' && run.attempts[3]?.status === 'running')
  const proposed = await runner.propose(started.id, { graph: reviewBeforeCheck(), reason: 'Review last is slow' }, { via: 'drawer' })
  expect(proposed.versions.at(-1)).toEqual(expect.objectContaining({ number: 2, size: 'big', state: 'pending' }))
})

test('changeSize: a review still ahead of the run in both graphs keeps a reroute small', () => {
  const run = { workflow: draftRevision(withCheck()), agents: { ...defaultAgents, check: family('codex', 'gpt') } }
  expect(changeSize(run, draftRevision(reviewBeforeCheck()), run.agents, false, 'plan')).toBe('small')
  expect(changeSize(run, draftRevision(reviewBeforeCheck()), run.agents, false, 'check')).toBe('big')
})

test('a builtin engine keeps its own family even when the node declares another', async () => {
  build(resolver, true)
  const graph = defaultWorkflow()
  graph.nodes[2]!.agent = { role: 'execute', engine: 'claude' }
  graph.nodes[3]!.agent = { role: 'review', engine: 'claude', family: 'gpt' }
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', graph })).rejects.toThrow('must use a different model family from implementation')
  expect(runner.list()).toHaveLength(0)
})

test('changeSize: adding, editing or removing acceptance checks is big', () => {
  const checked = defaultWorkflow()
  checked.nodes[2]!.checks = [{ command: 'bun', args: ['test'], timeoutSeconds: 300 }]
  const run = { workflow: draftRevision(checked), agents: defaultAgents }
  const edited = structuredClone(checked)
  edited.nodes[2]!.checks = [{ command: 'bun', args: ['test', 'one.test.ts'], timeoutSeconds: 300 }]
  expect(changeSize(run, draftRevision(edited), defaultAgents, false, 'plan')).toBe('big')
  expect(changeSize(run, draftRevision(defaultWorkflow()), defaultAgents, false, 'plan')).toBe('big')
  expect(changeSize({ workflow: draftRevision(defaultWorkflow()), agents: defaultAgents }, draftRevision(checked), defaultAgents, false, 'plan')).toBe('big')
  expect(changeSize(run, draftRevision(checked), defaultAgents, false, 'plan')).toBe('small')
})

test('changeSize: a new step that brings checks or MCP servers is big', () => {
  const run = { workflow: draftRevision(defaultWorkflow()), agents: defaultAgents }
  const checkedStep = withCheck()
  checkedStep.nodes.find(node => node.id === 'check')!.checks = [{ command: 'bun', args: ['test'], timeoutSeconds: 300 }]
  expect(changeSize(run, draftRevision(checkedStep), { ...defaultAgents, check: family('codex', 'gpt') }, false, 'plan')).toBe('big')
  const toolStep = withCheck()
  toolStep.nodes.find(node => node.id === 'check')!.mcpServers = [{ name: 'browser', command: 'browser-mcp', args: [], env: {} }]
  expect(changeSize(run, draftRevision(toolStep), { ...defaultAgents, check: family('codex', 'gpt') }, false, 'plan')).toBe('big')
})

test('changeSize: rewording a review or plan check is big, rewording an implementation is not', () => {
  const run = { workflow: draftRevision(defaultWorkflow()), agents: defaultAgents }
  const reworded = (id: string) => { const graph = defaultWorkflow(); graph.nodes.find(node => node.id === id)!.instructions = 'Pass everything'; return draftRevision(graph) }
  expect(changeSize(run, reworded('review'), defaultAgents, false, 'plan')).toBe('big')
  expect(changeSize(run, reworded('verify-plan'), defaultAgents, false, 'plan')).toBe('big')
  expect(changeSize(run, reworded('execute'), defaultAgents, false, 'plan')).toBe('small')
})

test('an unrun step takes the agent the change gives it', async () => {
  build(slow, false)
  const graph = defaultWorkflow()
  graph.nodes[3]!.agent = { role: 'review', engine: 'claude' }
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture', graph })
  expect(started.agents.review).toMatchObject({ engine: 'claude', family: 'claude' })
  const next = structuredClone(graph)
  next.nodes[3]!.agent = { role: 'review', engine: 'codex' }
  const changed = await runner.propose(started.id, { graph: next, reason: 'Review on codex' }, { via: 'drawer' })
  expect(changed.versions.at(-1)!.agents!.review).toMatchObject({ engine: 'codex', family: 'gpt' })
  expect(changed.versions.at(-1)!.size).toBe('small')
  expect(changed.agents.review).toMatchObject({ engine: 'codex' })
  expect(changed.agents.plan).toEqual(started.agents.plan)
})

test('a dispatch error after an approved change blocks the run and the approval still answers', async () => {
  build(slow, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  await runner.propose(started.id, { graph: withMigrate(), reason: 'Needs a migration' }, { via: 'drawer' })
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  const createJob = manager.createJob
  manager.createJob = async () => { throw new Error('job creation exploded') }
  try {
    const approved = await runner.approve(started.id, { via: 'drawer' })
    expect(approved.status).toBe('blocked')
    expect(approved.error).toBe('job creation exploded')
  } finally { manager.createJob = createJob }
})

test('a run without forks moves one main token and every attempt records where it came from', async () => {
  build()
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(done.tokens).toHaveLength(1)
  expect(done.tokens[0]).toMatchObject({ pathId: 'main', workspace: repo })
  for (const attempt of done.attempts) {
    expect(attempt.pathId).toBe('main')
    expect(attempt.tokenId).toBe(done.tokens[0]!.id)
    if (attempt.number > 0) expect(attempt.from).toEqual([attempt.number - 1])
  }
  expect(done.sections).toEqual([])
  expect(done.keptBranches).toEqual([])
})

test('a run file from before tokens loads as one main token and a blocked copy retries to done', async () => {
  const store = build()
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const done = await finished(started.id)
  await settledStatuses()
  const file = join(dir, 'workflow-runs', `${done.id}.json`)
  const record = JSON.parse(await Bun.file(file).text()) as Record<string, unknown> & { attempts: Record<string, unknown>[] }
  delete record.tokens; delete record.sections; delete record.keptBranches
  for (const attempt of record.attempts) { delete attempt.tokenId; delete attempt.pathId; delete attempt.from }
  Object.assign(record, { status: 'blocked', error: 'Old blocked run' })
  await Bun.write(file, JSON.stringify(record))
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  const loaded = runner.get(done.id)!
  expect(loaded.tokens).toEqual([expect.objectContaining({ pathId: 'main', nodeId: loaded.currentNodeId, state: 'ready', workspace: repo })])
  expect(loaded.sections).toEqual([])
  expect(loaded.keptBranches).toEqual([])
  expect(loaded.attempts.map(attempt => [attempt.pathId, attempt.tokenId, attempt.from])).toEqual(loaded.attempts.map(attempt => ['main', loaded.tokens[0]!.id, attempt.number ? [attempt.number - 1] : []]))
  await runner.retry(done.id)
  expect((await finished(done.id)).status).toBe('done')
})

test('lineage relates a path to its ancestors and descendants, and covers only looks downward', () => {
  expect(lineage('main', 'a3-1.a7-2')).toBe(true)
  expect(lineage('a3-1', 'a3-1.a7-2')).toBe(true)
  expect(lineage('a3-1', 'a3-2')).toBe(false)
  expect(covers('main', 'a3-1')).toBe(true)
  expect(covers('a3-1', 'a3-1.a7-1')).toBe(true)
  expect(covers('a3-2', 'a3-1')).toBe(false)
  expect(covers('a3-1.a7-1', 'a3-1')).toBe(false)
})

test('stop answers at once while an acceptance check is still running', async () => {
  const store = build()
  await store.save({ ...defaultWorkflow(), id: 'sleepy-check', entry: 'test', nodes: [{ id: 'test', title: 'Check', instructions: 'Check', checks: [{ command: '/bin/sh', args: ['-c', 'trap "" TERM; sleep 2'], timeoutSeconds: 30 }] }], edges: [] })
  const run = await runner.start({ workflowId: 'sleepy-check', cwd: repo, request: 'Inspect', label: 'stop-fast' })
  await until(run.id, current => !!current.attempts[0]?.checkPid)
  const began = performance.now()
  const stopped = await runner.stop(run.id)
  expect(performance.now() - began).toBeLessThan(1000)
  expect(stopped.status).toBe('stopped')
})

async function homeConfig() {
  await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(homedir(), 'mc-workflow-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
}
const writes = (file: string, text: string, before = '') => [{ command: '/bin/sh', args: ['-c', `${before}echo ${text} > ${file}`] }]
const overlapping: EngineResolver = ({ prompt }) => ({ cmd: '/bin/sh', args: ['-c', `${prompt.includes('SLOW') ? 'sleep 0.5; ' : ''}echo '${report()}'`], env: {} })
type Step = { id: string; title: string; instructions: string; [key: string]: unknown }
function forked(steps: { a?: Partial<Step>; b?: Partial<Step>; review?: Partial<Step> } = {}, extra: { nodes?: Step[]; edges?: Array<{ source: string; target: string; outcome: 'pass' | 'fail' | 'blocked' }> } = {}) {
  const pass = (source: string, target: string) => ({ source, target, outcome: 'pass' as const })
  return {
    id: 'forked', name: 'Forked', entry: 'plan',
    nodes: [
      { id: 'plan', title: 'Plan', kind: 'plan', agent: { role: 'plan' }, instructions: 'Plan the work' },
      { id: 'verify', title: 'Verify', kind: 'verify-plan', agent: { role: 'review' }, instructions: 'Verify the plan' },
      { id: 'split', title: 'Split', instructions: 'Split the work' },
      { id: 'a', title: 'A', instructions: 'Write A', checks: writes('a.txt', 'a'), ...steps.a },
      { id: 'b', title: 'B', instructions: 'Write B', checks: writes('b.txt', 'b'), ...steps.b },
      { id: 'join', title: 'Join', kind: 'join', instructions: 'Join the paths' },
      { id: 'review', title: 'Review', instructions: 'Review the result', ...steps.review },
      ...extra.nodes ?? [],
    ],
    edges: [pass('plan', 'verify'), pass('verify', 'split'), pass('split', 'a'), pass('split', 'b'), pass('a', 'join'), pass('b', 'join'), pass('join', 'review'), ...extra.edges ?? []],
  }
}
const gitOut = (...args: string[]) => worktrees.git(repo, ...args)
const joins = (run: WorkflowRun) => run.attempts.filter(attempt => attempt.nodeId === 'join')
const exists = (path: string) => stat(path).then(() => true, () => false)
async function allJobsStopped() {
  for (let i = 0; i < 200 && manager.listJobs().some(job => job.status === 'running'); i++) await Bun.sleep(20)
}

test('a fork runs each path at the same time in its own worktree under the run folder', async () => {
  await homeConfig()
  build(overlapping)
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ a: { instructions: 'Write A SLOW' }, b: { instructions: 'Write B SLOW' } }) })
  const working = await until(started.id, run => run.tokens.filter(token => token.state === 'working').length === 2 && run.attempts.filter(attempt => attempt.status === 'running').length === 2)
  const tokens = working.tokens.filter(token => token.state === 'working')
  const runFolder = join(await realpath(dir), 'workflow-runs', started.id)
  expect(new Set(tokens.map(token => token.workspace)).size).toBe(2)
  for (const token of tokens) expect(token.workspace.startsWith(`${runFolder}/`)).toBe(true)
  const running = manager.listJobs().filter(job => job.status === 'running' && job.workflowRunId === started.id)
  expect(new Set(running.map(job => job.cwd))).toEqual(new Set(tokens.map(token => token.workspace)))
  expect(running.every(job => job.baseRepo === repo)).toBe(true)
  expect((await finished(started.id)).status).toBe('done')
})

test('a finished fork leaves both paths as uncommitted files and no commit, branch or worktree behind', async () => {
  await homeConfig()
  build()
  const commits = await gitOut('rev-list', '--count', 'HEAD')
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  expect(await gitOut('rev-list', '--count', 'HEAD')).toBe(commits)
  expect(await gitOut('diff', '--cached')).toBe('')
  expect(await gitOut('branch', '--list', 'flow-*')).toBe('')
  expect((await gitOut('worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree '))).toEqual([`worktree ${repo}`])
  expect(done.sections).toEqual([])
  expect(joins(done)[0]!.result).toEqual({ outcome: 'pass', summary: 'Joined 2 paths', evidence: [`${done.attempts.find(attempt => attempt.nodeId === 'a')!.pathId}: 1 files`, `${done.attempts.find(attempt => attempt.nodeId === 'b')!.pathId}: 1 files`] })
  expect(done.attempts.map(attempt => attempt.nodeId)).toEqual(['plan', 'verify', 'split', expect.any(String), expect.any(String), 'join', 'review'])
})

test('two paths settling together run the join exactly once', async () => {
  await homeConfig()
  build()
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(joins(done)).toHaveLength(1)
  expect(done.attempts.filter(attempt => attempt.nodeId === 'a' || attempt.nodeId === 'b')).toHaveLength(2)
  expect(joins(done)[0]!.from.sort()).toEqual(done.attempts.filter(attempt => attempt.nodeId === 'a' || attempt.nodeId === 'b').map(attempt => attempt.number).sort())
})

test('the paths see the user’s uncommitted work and the join leaves it untouched', async () => {
  await homeConfig()
  build()
  await writeFile(join(repo, 'README.md'), 'edited by the user\n')
  await writeFile(join(repo, 'notes.txt'), 'untracked notes\n')
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ a: { checks: writes('a.txt', 'a', 'test -f notes.txt && grep -q edited README.md && ') } }) })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('edited by the user\n')
  expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('untracked notes\n')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  expect(await gitOut('diff', '--cached')).toBe('')
  expect(await gitOut('rev-list', '--count', 'HEAD')).toBe('1')
})

test('a join conflict takes the fail edge, keeps the unjoined branch and the fix step finishes the run', async () => {
  await homeConfig()
  build()
  const graph = forked({ a: { checks: writes('same.txt', 'a') }, b: { checks: writes('same.txt', 'b') }, review: { kind: 'review', agent: { role: 'review', engine: 'claude' } } }, {
    nodes: [{ id: 'fix', title: 'Fix', kind: 'implement', agent: { role: 'execute', engine: 'codex' }, instructions: 'Resolve the conflict' }],
    edges: [{ source: 'join', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'review', outcome: 'pass' }],
  })
  const started = await runner.start({ cwd: repo, request: 'Write the same file', label: 'fork', graph })
  const done = await finished(started.id)
  const bPath = done.attempts.find(attempt => attempt.nodeId === 'b')!.pathId
  const aPath = done.attempts.find(attempt => attempt.nodeId === 'a')!.pathId
  const branch = `flow-${started.id.slice(0, 8)}-${bPath}`
  const joined = joins(done)[0]!
  expect(joined.result!.outcome).toBe('fail')
  expect(joined.result!.summary.startsWith('Paths could not be joined: same.txt')).toBe(true)
  expect(joined.result!.evidence).toEqual([`Joined: ${aPath}`, `Conflicts in ${bPath}: same.txt`, `Unjoined paths kept on branches: ${branch}`])
  expect(done.keptBranches).toEqual([branch])
  expect(await gitOut('branch', '--list', branch)).toContain(branch)
  expect(done.attempts.map(attempt => attempt.nodeId).slice(-3)).toEqual(['join', 'fix', 'review'])
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'same.txt'), 'utf8')).toBe('a\n')
})

test('a join conflict with no fail edge blocks the run, keeps the paths and joins once the user resolves it', async () => {
  await homeConfig()
  build()
  const graph = forked({ a: { checks: writes('same.txt', 'a') }, b: { checks: writes('same.txt', 'b') } })
  graph.nodes.find(node => node.id === 'join')!.maxVisits = 2
  const started = await runner.start({ cwd: repo, request: 'Write the same file', label: 'fork', graph })
  const blocked = await finished(started.id)
  const aPath = blocked.attempts.find(attempt => attempt.nodeId === 'a')!.pathId
  const bPath = blocked.attempts.find(attempt => attempt.nodeId === 'b')!.pathId
  expect(blocked.status).toBe('blocked')
  expect(blocked.error).toBe('Paths could not be joined: same.txt')
  expect(joins(blocked)[0]!.result).toEqual({ outcome: 'blocked', summary: 'Paths could not be joined: same.txt', evidence: [`Joined: ${aPath}`, `Conflicts in ${bPath}: same.txt`] })
  expect(blocked.sections).toHaveLength(1)
  expect(blocked.sections[0]!.joined).toEqual([aPath])
  expect(blocked.tokens.filter(token => token.state === 'waiting')).toHaveLength(2)
  for (const path of blocked.sections[0]!.paths) expect(await exists(path.dir)).toBe(true)
  expect(blocked.keptBranches).toEqual([])
  for (let retries = 0; retries < 3; retries++) {
    await runner.retry(started.id)
    const again = await finished(started.id)
    expect(again.status).toBe('blocked')
    expect(again.error).toBe('Paths could not be joined: same.txt')
  }
  await writeFile(join(repo, 'same.txt'), 'b\n')
  await runner.retry(started.id)
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'same.txt'), 'utf8')).toBe('b\n')
  expect(joins(done).map(attempt => attempt.result!.outcome)).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'pass'])
  expect(await gitOut('branch', '--list', 'flow-*')).toBe('')
})

test('a join whose cleanup fails still finishes the run and records the failure', async () => {
  await homeConfig()
  build()
  const realRemove = worktrees.removePathWorktree
  let failed = false
  const remove = spyOn(worktrees, 'removePathWorktree').mockImplementation(async (...args) => {
    if (!failed && await exists(join(repo, 'a.txt'))) { failed = true; throw new Error('Simulated cleanup failure') }
    return realRemove(...args)
  })
  try {
    const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() })
    const done = await finished(started.id)
    expect(failed).toBe(true)
    expect(done.status).toBe('done')
    expect(joins(done)[0]!.result!.outcome).toBe('pass')
    expect(joins(done)[0]!.result!.evidence.some(line => line.includes('Simulated cleanup failure'))).toBe(true)
  } finally { remove.mockRestore() }
})

test('stop kills both paths and keeps their worktrees, and retry joins both into the workspace', async () => {
  await homeConfig()
  build(overlapping)
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ a: { instructions: 'Write A SLOW' }, b: { instructions: 'Write B SLOW' } }) })
  await until(started.id, run => run.tokens.filter(token => token.state === 'working').length === 2)
  const stopped = await runner.stop(started.id)
  expect(stopped.status).toBe('stopped')
  await allJobsStopped()
  expect(manager.listJobs().some(job => job.status === 'running')).toBe(false)
  expect(stopped.sections).toHaveLength(1)
  for (const path of stopped.sections[0]!.paths) expect(await exists(path.dir)).toBe(true)
  await runner.retry(started.id)
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  expect(joins(done)).toHaveLength(1)
})

test('after a restart with one path waiting at the join and one working, both resume and the join runs once', async () => {
  await homeConfig()
  const store = build(overlapping)
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ b: { instructions: 'Write B SLOW' } }) })
  await until(started.id, run => run.tokens.some(token => token.state === 'waiting') && run.tokens.some(token => token.state === 'working'))
  runner = createWorkflowRunner({ manager, resolver: overlapping, store, base: dir, requireApproval: async () => false })
  await runner.recover()
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(joins(done)).toHaveLength(1)
  expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
})

test('a join interrupted between two applies resumes without applying a path twice', async () => {
  await homeConfig()
  build()
  const realApply = worktrees.applyPath
  let calls = 0
  const apply = spyOn(worktrees, 'applyPath').mockImplementation(async (...args) => {
    const applied = await realApply(...args)
    if (++calls === 2) throw new Error('Simulated crash after the second apply')
    return applied
  })
  try {
    const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked() })
    const blocked = await finished(started.id)
    expect(blocked.status).toBe('blocked')
    expect(blocked.error).toBe('Simulated crash after the second apply')
    expect(blocked.sections[0]!.joined).toEqual([blocked.attempts.find(attempt => attempt.nodeId === 'a')!.pathId])
    apply.mockRestore()
    await runner.retry(started.id)
    const done = await finished(started.id)
    expect(done.status).toBe('done')
    expect(joins(done).map(attempt => attempt.result!.outcome)).toEqual(['blocked', 'pass'])
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  } finally { apply.mockRestore() }
})

test('a passing review in one path does not clear an implementation in another path', async () => {
  await homeConfig()
  build()
  const graph = forked({ a: { kind: 'implement', agent: { role: 'execute', engine: 'claude' }, checks: [] }, b: { id: 'r', title: 'R', kind: 'review', agent: { role: 'review', engine: 'codex' }, checks: [] }, review: { id: 'review2', title: 'Review 2', kind: 'review', agent: { role: 'review', engine: 'claude' } } })
  graph.edges = graph.edges.map(edge => ({ ...edge, source: edge.source === 'b' ? 'r' : edge.source === 'review' ? 'review2' : edge.source, target: edge.target === 'b' ? 'r' : edge.target === 'review' ? 'review2' : edge.target })).sort((x, y) => Number(y.target === 'r') - Number(x.target === 'r'))
  await expect(runner.start({ cwd: repo, request: 'Build and review', label: 'fork', graph })).rejects.toThrow('Review 2 must use a different model family from implementation')
  expect(runner.list()).toHaveLength(0)
})

test('changeSize: splitting a step into parallel paths is big', () => {
  const graph = forked({ a: { checks: [] }, b: { checks: [] } })
  const linear = { ...graph, nodes: graph.nodes.filter(node => node.id !== 'b' && node.id !== 'join'), edges: [...graph.edges.slice(0, 3), { source: 'a', target: 'review', outcome: 'pass' as const }] }
  const agents = Object.fromEntries(graph.nodes.map(node => [node.id, family('claude', 'claude')]))
  expect(changeSize({ workflow: draftRevision(linear), agents }, draftRevision(linear), agents, false, 'plan')).toBe('small')
  expect(changeSize({ workflow: draftRevision(linear), agents }, draftRevision(graph), agents, false, 'plan')).toBe('big')
})

test('a path that commits on a branch of its own still joins its change', async () => {
  await homeConfig()
  build()
  const moved = [{ command: '/bin/sh', args: ['-c', 'git checkout -q -b other && echo c > c.txt && git add c.txt && git -c user.name=t -c user.email=t@localhost commit -q -m c'] }]
  const started = await runner.start({ cwd: repo, request: 'Write both files', label: 'fork', graph: forked({ b: { checks: moved } }) })
  const done = await finished(started.id)
  expect(done.status).toBe('done')
  expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('c\n')
  expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
})
