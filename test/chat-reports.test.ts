import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JobManager, JobRecord } from '../server/jobs'
import { createJobManager, readLogFile } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { agentReport, createReportPoster, projectMemory } from '../server/chat-reports'
import { initScratchGitRepo } from './support/scratch-git-repo'

const base: JobRecord = { id: 'j1', engine: 'codex', cwd: '/p', worktree: null, baseRepo: null, baseBranch: null, label: 'Build it', prompt: 'x', pid: 1, status: 'done', startedAt: 1, turns: 3, slowAt: null, lastTool: null, endedAt: 2, exitCode: 0, diffStat: ' 2 files changed', reviewedAt: null, sessionId: null, parentJobId: null, threadRoot: 'j1', terminalId: null, reviewOf: null, model: null, chatId: 'root' }
const textEvent = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('agentReport', () => {
  test('a finished agent reports done with its last words and the diff', () => {
    const report = agentReport(base, `${textEvent('All tests pass.')}\n`)
    expect(report.message.startsWith('[agent Build it · codex] done')).toBe(true)
    expect(report.message).toContain('All tests pass.')
    expect(report.message).toContain('2 files changed')
    expect(report.needsYou).toBe(false)
  })
  test('a failure or a question needs you', () => {
    expect(agentReport({ ...base, status: 'failed', exitCode: 1 }, '').needsYou).toBe(true)
    expect(agentReport(base, `${textEvent('Which branch should I use?')}\n`).needsYou).toBe(true)
  })
  test('a failure names its exit code and a failed result event counts as failed', () => {
    expect(agentReport({ ...base, status: 'failed', exitCode: 2 }, '').message.startsWith('[agent Build it · codex] failed (exit 2)')).toBe(true)
    const reportedFailure = agentReport(base, `${JSON.stringify({ type: 'result', is_error: true })}\n`)
    expect(reportedFailure.needsYou).toBe(true)
    expect(reportedFailure.message).toContain('] failed')
  })
  test('long last words are clipped and a multi-line label stays on one line', () => {
    const report = agentReport({ ...base, label: 'Build\nit', diffStat: null }, `${textEvent('y'.repeat(5000))}\n`)
    expect(report.message.startsWith('[agent Build it · codex] done\n')).toBe(true)
    expect(report.message.length).toBeLessThan(1300)
    expect(report.message).not.toContain('Diff:')
  })
})

describe('projectMemory', () => {
  test('lists recent chats and agents of the same project, not this chat', async () => {
    const chats: JobRecord[] = [
      { ...base, id: 'c1', purpose: 'chat', project: '/p', label: 'Login fix', threadRoot: 'c1', chatId: undefined, startedAt: 10 },
      { ...base, id: 'c2', purpose: 'chat', project: '/p', label: 'This chat', threadRoot: 'c2', chatId: undefined, startedAt: 20 },
      { ...base, id: 'c3', purpose: 'chat', project: '/other', label: 'Other', threadRoot: 'c3', chatId: undefined, startedAt: 30 },
      { ...base, id: 'a1', label: 'Build it', status: 'done', startedAt: 15, cwd: '/p', chatId: 'c1' },
    ]
    const memory = await projectMemory(chats, '/p', 'c2', async () => `${textEvent('Fixed the redirect loop.')}\n`)
    expect(memory).toContain('Login fix')
    expect(memory).toContain('Fixed the redirect loop.')
    expect(memory).toContain('agent Build it (done)')
    expect(memory).not.toContain('This chat')
    expect(memory).not.toContain('Other')
  })
  test('an empty project has no memory', async () => {
    expect(await projectMemory([], '/p', 'c1', async () => '')).toBe('')
  })
})

const SESSION_LINE = '{"type":"system","subtype":"init","session_id":"sess-1"}'
const sessionResolver: EngineResolver = () => ({ cmd: 'echo', args: [SESSION_LINE], env: {} })
const runningSessionResolver: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `echo '${SESSION_LINE}'; sleep 30`], env: {} })
const agentResolver = (text: string): EngineResolver => () => ({ cmd: 'echo', args: [textEvent(text)], env: {} })

describe('createReportPoster', () => {
  let configDir: string
  let repo: string

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mc-chat-reports-config-'))
    process.env.MISSION_CONTROL_CONFIG_DIR = configDir
    repo = await mkdtemp(join(homedir(), 'mc-chat-reports-scratch-'))
    await initScratchGitRepo(repo)
  })

  afterEach(async () => {
    delete process.env.MISSION_CONTROL_CONFIG_DIR
    await rm(configDir, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  async function settled(manager: JobManager, id: string): Promise<JobRecord> {
    const deadline = Date.now() + 5000
    for (;;) {
      const job = manager.getJob(id)
      if (job !== undefined && job.status !== 'running' && (job.purpose !== 'chat' || job.sessionId !== null || job.status === 'failed')) return job
      if (Date.now() > deadline) throw new Error(`job ${id} did not settle`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }

  async function chatRoot(manager: JobManager, resolver = sessionResolver): Promise<JobRecord> {
    const result = await manager.createJob({ engine: 'claude', cwd: repo, prompt: 'Fix the login bug', label: 'Login fix', purpose: 'chat', project: repo }, resolver)
    if (!result.ok) throw new Error(result.error)
    return result.job
  }

  async function agent(manager: JobManager, chatId: string, text: string): Promise<JobRecord> {
    const result = await manager.createJob({ engine: 'codex', cwd: repo, prompt: 'p', label: 'Build it', chatId }, agentResolver(text))
    if (!result.ok) throw new Error(result.error)
    return settled(manager, result.job.id)
  }

  const readLog = (manager: JobManager) => (id: string) => readLogFile(manager.logPath(id))

  test('a settled agent posts an agent turn into its idle chat', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'All tests pass.')
    const notes: string[] = []
    const poster = createReportPoster(manager, sessionResolver, { readLog: readLog(manager), notify: async (title, body) => { notes.push(`${title}|${body}`) } })
    await poster(worker)
    const turn = manager.listJobs().find((job) => job.source === 'agent')
    expect(turn?.prompt.startsWith('[agent Build it · codex] done')).toBe(true)
    expect(turn?.prompt).toContain('All tests pass.')
    expect(turn?.threadRoot).toBe(root.id)
    expect(turn?.parentJobId).toBe(root.id)
    expect(turn?.purpose).toBe('chat')
    expect(notes).toEqual([])
    await settled(manager, turn!.id)
  })

  test('an agent that asks a question notifies that it needs you', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'Which branch should I use?')
    const notes: string[] = []
    await createReportPoster(manager, sessionResolver, { readLog: readLog(manager), notify: async (title, body) => { notes.push(`${title}|${body}`) } })(worker)
    expect(notes).toEqual(['Needs you|Login fix · Build it'])
    await settled(manager, manager.listJobs().find((job) => job.source === 'agent')!.id)
  })

  test('the report waits until the chat stops running, then posts', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    const deadline = Date.now() + 5000
    while (manager.getJob(root.id)?.sessionId === null) {
      if (Date.now() > deadline) throw new Error('no session id')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    const worker = await agent(manager, root.id, 'Done.')
    const queued: Array<() => Promise<void>> = []
    const poster = createReportPoster(manager, sessionResolver, { readLog: readLog(manager), schedule: (retry) => { queued.push(retry) } })
    await poster(worker)
    expect(queued).toHaveLength(1)
    expect(manager.listJobs().some((job) => job.source === 'agent')).toBe(false)
    await manager.killJob(root.id)
    await settled(manager, root.id)
    await queued[0]!()
    const turn = manager.listJobs().find((job) => job.source === 'agent')
    expect(turn?.prompt.startsWith('[agent Build it · codex] done')).toBe(true)
    await settled(manager, turn!.id)
  })

  test('a job with no chat, or a chat id that is not a chat root, posts nothing', async () => {
    const manager = createJobManager({ home: homedir() })
    const worker = await agent(manager, 'missing', 'x')
    const poster = createReportPoster(manager, sessionResolver, { readLog: readLog(manager), schedule: () => { throw new Error('should not retry') } })
    await poster(worker)
    await poster({ ...worker, chatId: undefined })
    await poster({ ...worker, chatId: worker.id })
    expect(manager.listJobs()).toHaveLength(1)
  })
})
