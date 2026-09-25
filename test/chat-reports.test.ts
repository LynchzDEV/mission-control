import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
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
  test('a stopped agent reports stopped and does not need you', () => {
    const report = agentReport({ ...base, status: 'failed', exitCode: 143, stoppedAt: 5 }, `${textEvent('Should I go on?')}\n`)
    expect(report.message.startsWith('[agent Build it · codex] stopped')).toBe(true)
    expect(report.needsYou).toBe(false)
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
  test('keeps at most eight chats and eight agents, and leaves out this chat\'s own agents', async () => {
    const jobs: JobRecord[] = [
      ...Array.from({ length: 10 }, (_, index) => ({ ...base, id: `c${index}`, purpose: 'chat' as const, project: '/p', label: `Chat ${index}`, threadRoot: `c${index}`, chatId: undefined, startedAt: 100 + index })),
      ...Array.from({ length: 10 }, (_, index) => ({ ...base, id: `a${index}`, label: `Agent ${index}`, cwd: '/p', chatId: 'c0', startedAt: 200 + index })),
      { ...base, id: 'own', label: 'Own agent', cwd: '/p', chatId: 'here', startedAt: 999 },
    ]
    const lines = (await projectMemory(jobs, '/p', 'here', async () => '')).split('\n')
    expect(lines.filter((line) => line.startsWith('- Chat '))).toHaveLength(8)
    expect(lines.filter((line) => line.startsWith('- agent '))).toHaveLength(8)
    expect(lines.join('\n')).toContain('Chat 9')
    expect(lines.join('\n')).not.toContain('Chat 1 ')
    expect(lines.join('\n')).not.toContain('Own agent')
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
    mock.restore()
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

  const logReader = (manager: JobManager) => async () => (id: string) => readLogFile(manager.logPath(id))
  const agentTurns = (manager: JobManager) => manager.listJobs().filter((job) => job.source === 'agent')

  async function waitForSession(manager: JobManager, id: string): Promise<void> {
    const deadline = Date.now() + 5000
    while (manager.getJob(id)?.sessionId === null) {
      if (Date.now() > deadline) throw new Error('no session id')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }

  test('a settled agent posts an agent turn into its idle chat', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'All tests pass.')
    const notes: string[] = []
    const poster = createReportPoster(manager, sessionResolver, { logReader: logReader(manager), notify: async (title, body) => { notes.push(`${title}|${body}`) } })
    await poster(worker)
    const turn = agentTurns(manager)[0]
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
    await createReportPoster(manager, sessionResolver, { logReader: logReader(manager), notify: async (title, body) => { notes.push(`${title}|${body}`) } })(worker)
    expect(notes).toEqual(['Needs you|Login fix · Build it'])
    await settled(manager, agentTurns(manager)[0]!.id)
  })

  test('two agents settling together fold into one chat turn', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const first = await agent(manager, root.id, 'First done.')
    const second = await agent(manager, root.id, 'Second done.')
    const poster = createReportPoster(manager, sessionResolver, { logReader: logReader(manager), schedule: () => {} })
    await Promise.all([poster(first), poster(second)])
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toContain('First done.')
    expect(turns[0]?.prompt).toContain('Second done.')
    expect(turns[0]?.prompt).toContain('\n\n[agent Build it · codex] done')
    await settled(manager, turns[0]!.id)
  })

  test('the report waits until the chat stops running, then posts', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const worker = await agent(manager, root.id, 'Done.')
    const queued: Array<() => Promise<void>> = []
    const poster = createReportPoster(manager, sessionResolver, { logReader: logReader(manager), schedule: (retry) => { queued.push(retry) } })
    await poster(worker)
    await poster(worker)
    expect(queued).toHaveLength(1)
    expect(agentTurns(manager)).toHaveLength(0)
    await manager.killJob(root.id)
    await settled(manager, root.id)
    await queued[0]!()
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt.startsWith('[agent Build it · codex] done')).toBe(true)
    await settled(manager, turns[0]!.id)
  })

  test('a report dropped at the retry limit is logged and still notifies when it needs you', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const worker = await agent(manager, root.id, 'Which branch should I use?')
    const notes: string[] = []
    const queued: Array<() => Promise<void>> = []
    const poster = createReportPoster(manager, sessionResolver, { logReader: logReader(manager), retryLimit: 1, schedule: (retry) => { queued.push(retry) }, notify: async (title, body) => { notes.push(`${title}|${body}`) } })
    await poster(worker)
    await queued[0]!()
    expect(queued).toHaveLength(1)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(notes).toEqual(['Needs you|Login fix · Build it'])
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id) && String(call[0]).includes('Build it'))).toBe(true)
    await manager.killJob(root.id)
    await settled(manager, root.id)
  })

  test('a chat without a session drops the report with a log line and a needs-you notice', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, () => ({ cmd: 'echo', args: ['no session'], env: {} }))
    const deadline = Date.now() + 5000
    while (manager.getJob(root.id)?.status === 'running') {
      if (Date.now() > deadline) throw new Error('root did not settle')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    const worker = await agent(manager, root.id, 'Should I land it?')
    const notes: string[] = []
    await createReportPoster(manager, sessionResolver, { logReader: logReader(manager), notify: async (title, body) => { notes.push(`${title}|${body}`) } })(worker)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(notes).toEqual(['Needs you|Login fix · Build it'])
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id))).toBe(true)
  })

  test('after twelve agent rounds in a row the chat waits for you instead of replying', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    for (let round = 0; round < 12; round += 1) {
      const turn = await manager.createJob({ engine: 'claude', cwd: repo, prompt: `[agent round ${round}]`, label: root.label, threadRoot: root.id, parentJobId: root.id, resumeSessionId: 'sess-1', purpose: 'chat', source: 'agent' }, sessionResolver)
      if (!turn.ok) throw new Error(turn.error)
      await settled(manager, turn.job.id)
    }
    const worker = await agent(manager, root.id, 'Done again.')
    const notes: string[] = []
    await createReportPoster(manager, sessionResolver, { logReader: logReader(manager), notify: async (title, body) => { notes.push(`${title}|${body}`) } })(worker)
    expect(agentTurns(manager)).toHaveLength(12)
    expect(notes).toEqual(['Needs you|Login fix · waiting for you after 12 agent rounds'])
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id))).toBe(true)
  })

  test('a job with no chat, or a chat id that is not a chat root, posts nothing', async () => {
    const manager = createJobManager({ home: homedir() })
    const worker = await agent(manager, 'missing', 'x')
    const poster = createReportPoster(manager, sessionResolver, { logReader: logReader(manager), schedule: () => { throw new Error('should not retry') } })
    await poster(worker)
    await poster({ ...worker, chatId: undefined })
    await poster({ ...worker, chatId: worker.id })
    expect(manager.listJobs()).toHaveLength(1)
  })
})
