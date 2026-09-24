import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobManager, type JobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { createWorkflowStore, defaultWorkflow } from '../server/workflows'
import { createWorkflowRunner, type WorkflowRunner } from '../server/workflow-runner'
import { initScratchGitRepo } from './support/scratch-git-repo'
import type { TerminalRecord } from '../server/terminals'

let dir: string, repo: string, manager: JobManager, runner: WorkflowRunner
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
function build(agent: EngineResolver = resolver) {
  const store = createWorkflowStore(dir)
  manager = createJobManager({ onJobSettled: job => { void runner.onJobSettled(job) } })
  runner = createWorkflowRunner({ manager, resolver: agent, store, base: dir })
  return store
}
async function finished(id: string) {
  for (let i = 0; i < 200; i++) { const run = runner.get(id)!; if (run.status !== 'running') return run; await Bun.sleep(20) }
  throw new Error('Run did not settle')
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

test('terminal runs use their pinned workflow and reject conflicting or unknown terminal selections', async () => {
  const store = build()
  const first = await store.save({ ...defaultWorkflow(), id: 'terminal-workflow', name: 'Original terminal workflow' })
  const terminal: TerminalRecord = { id: 'terminal-a', engine: 'claude', cwd: repo, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, workflow: { id: first.id, name: first.name, revision: first.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, terminals: { get: id => id === terminal.id ? terminal : undefined } })
  const next = await store.save({ ...first, name: 'Changed after terminal opened' }, first.revision)
  await store.setDefault(next.id, next.revision)
  const input = { terminalId: terminal.id, cwd: repo, request: 'Inspect this project', label: 'terminal task' }
  await expect(runner.start({ ...input, terminalId: 'unknown' })).rejects.toThrow('Terminal not found')
  await expect(runner.start({ ...input, revision: next.revision })).rejects.toThrow('pinned workflow')
  await expect(runner.start({ ...input, workflowId: 'default' })).rejects.toThrow('pinned workflow')
  expect(manager.listJobs()).toHaveLength(0)
  const started = await runner.start(input)
  expect(started.workflow.revision).toBe(first.revision)
  expect(started.terminalId).toBe(terminal.id)
  expect((await finished(started.id)).status).toBe('done')
  expect(manager.listJobs().every(job => job.terminalId === terminal.id)).toBe(true)
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
