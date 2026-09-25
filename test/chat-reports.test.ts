import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JobManager, JobRecord } from '../server/jobs'
import { createJobManager, JOBS_FILE, LOGS_DIR, readLogFile } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { agentReport, createChatFlusher, projectMemory, RESTART_CATCH_UP } from '../server/chat-reports'
import type { ChatFlusherOptions } from '../server/chat-reports'
import { createChatQueue } from '../server/chat-queue'
import type { ChatQueue } from '../server/chat-queue'
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

describe('createChatFlusher', () => {
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
  const chatTurnsAfterRoot = (manager: JobManager, rootId: string) => manager.listJobs().filter((job) => job.threadRoot === rootId && job.id !== rootId)
  const queueFile = () => join(configDir, 'chat-queue.json')

  function flusherFor(manager: JobManager, opts: Partial<ChatFlusherOptions> = {}, queue: ChatQueue = createChatQueue(queueFile())) {
    return createChatFlusher(manager, sessionResolver, { logReader: logReader(manager), queue, ...opts })
  }

  async function waitForSession(manager: JobManager, id: string): Promise<void> {
    const deadline = Date.now() + 5000
    while (manager.getJob(id)?.sessionId === null) {
      if (Date.now() > deadline) throw new Error('no session id')
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }

  test('a settled agent posts an agent turn into its idle chat and is marked reported', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'All tests pass.')
    expect(worker.reportedAt).toBeNull()
    const notes: string[] = []
    const flusher = flusherFor(manager, { notify: async (title, body) => { notes.push(`${title}|${body}`) } })
    await flusher.onAgentSettled(worker)
    const turn = agentTurns(manager)[0]
    expect(turn?.prompt.startsWith('[agent Build it · codex] done')).toBe(true)
    expect(turn?.prompt).toContain('All tests pass.')
    expect(turn?.threadRoot).toBe(root.id)
    expect(turn?.parentJobId).toBe(root.id)
    expect(turn?.purpose).toBe('chat')
    expect(notes).toEqual([])
    expect(typeof manager.getJob(worker.id)?.reportedAt).toBe('number')
    await settled(manager, turn!.id)
    await flusher.kick(root.id)
    expect(agentTurns(manager)).toHaveLength(1)
  })

  test('an agent that asks a question notifies that it needs you', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const worker = await agent(manager, root.id, 'Which branch should I use?')
    const notes: string[] = []
    await flusherFor(manager, { notify: async (title, body) => { notes.push(`${title}|${body}`) } }).onAgentSettled(worker)
    expect(notes).toEqual(['Needs you|Login fix · Build it'])
    await settled(manager, agentTurns(manager)[0]!.id)
  })

  test('two agents settling together fold into one chat turn', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const first = await agent(manager, root.id, 'First done.')
    const second = await agent(manager, root.id, 'Second done.')
    const flusher = flusherFor(manager, { schedule: () => {} })
    await Promise.all([flusher.onAgentSettled(first), flusher.onAgentSettled(second)])
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toContain('First done.')
    expect(turns[0]?.prompt).toContain('Second done.')
    expect(turns[0]?.prompt).toContain('\n\n[agent Build it · codex] done')
    expect(turns[0]?.prompt).not.toContain(RESTART_CATCH_UP)
    await settled(manager, turns[0]!.id)
  })

  test('the report waits until the chat stops running, then posts', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const worker = await agent(manager, root.id, 'Done.')
    const queued: Array<() => Promise<void>> = []
    const flusher = flusherFor(manager, { schedule: (retry) => { queued.push(retry) } })
    await flusher.onAgentSettled(worker)
    await flusher.onAgentSettled(worker)
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

  test('a report past the retry limit keeps waiting, logs, and goes out when the chat is next idle', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const worker = await agent(manager, root.id, 'Which branch should I use?')
    const queued: Array<() => Promise<void>> = []
    const flusher = flusherFor(manager, { retryLimit: 1, schedule: (retry) => { queued.push(retry) } })
    await flusher.onAgentSettled(worker)
    await queued[0]!()
    expect(queued).toHaveLength(1)
    expect(agentTurns(manager)).toHaveLength(0)
    expect(manager.getJob(worker.id)?.reportedAt).toBeNull()
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id) && String(call[0]).includes('Build it'))).toBe(true)
    await manager.killJob(root.id)
    await settled(manager, root.id)
    await flusher.kick(root.id)
    const turns = agentTurns(manager)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toContain('Which branch should I use?')
    await settled(manager, turns[0]!.id)
  })

  test('a chat without a session marks the report with a log line and a needs-you notice', async () => {
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
    const flusher = flusherFor(manager, { notify: async (title, body) => { notes.push(`${title}|${body}`) } })
    await flusher.onAgentSettled(worker)
    await flusher.kick(root.id)
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
    await flusherFor(manager, { notify: async (title, body) => { notes.push(`${title}|${body}`) } }).onAgentSettled(worker)
    expect(agentTurns(manager)).toHaveLength(12)
    expect(notes).toEqual(['Needs you|Login fix · waiting for you after 12 agent rounds'])
    expect(errors.mock.calls.some((call) => String(call[0]).includes(root.id))).toBe(true)
  })

  test('a queued user message goes out even after twelve agent rounds, with the held report after it', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    for (let round = 0; round < 12; round += 1) {
      const turn = await manager.createJob({ engine: 'claude', cwd: repo, prompt: `[agent round ${round}]`, label: root.label, threadRoot: root.id, parentJobId: root.id, resumeSessionId: 'sess-1', purpose: 'chat', source: 'agent' }, sessionResolver)
      if (!turn.ok) throw new Error(turn.error)
      await settled(manager, turn.job.id)
    }
    const worker = await agent(manager, root.id, 'Held report.')
    const queue = createChatQueue(queueFile())
    const flusher = flusherFor(manager, {}, queue)
    await flusher.onAgentSettled(worker)
    await queue.add(root.id, 'keep going')
    await flusher.kick(root.id)
    const turn = manager.listJobs().find((job) => job.source === 'user' && job.threadRoot === root.id && job.id !== root.id)
    expect(turn?.prompt.startsWith('keep going\n\n[agent Build it · codex] done')).toBe(true)
    await settled(manager, turn!.id)
  })

  test('queued messages become the next turn in order when the running turn settles, with a settled agent after them', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await chatRoot(manager, runningSessionResolver)
    await waitForSession(manager, root.id)
    const queue = createChatQueue(queueFile())
    const flusher = flusherFor(manager, { schedule: () => {} }, queue)
    await queue.add(root.id, 'first thing')
    await queue.add(root.id, 'second thing')
    const worker = await agent(manager, root.id, 'Agent finished.')
    await flusher.onAgentSettled(worker)
    await flusher.kick(root.id)
    expect(chatTurnsAfterRoot(manager, root.id)).toHaveLength(0)
    await manager.killJob(root.id)
    await settled(manager, root.id)
    await flusher.kick(root.id)
    const turns = chatTurnsAfterRoot(manager, root.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.source).toBe('user')
    expect(turns[0]?.prompt.startsWith('first thing\n\nsecond thing\n\n[agent Build it · codex] done')).toBe(true)
    expect(queue.list(root.id)).toEqual([])
    expect(createChatQueue(queueFile()).list(root.id)).toEqual([])
    expect(typeof manager.getJob(worker.id)?.reportedAt).toBe('number')
    await settled(manager, turns[0]!.id)
    await flusher.kick(root.id)
    expect(chatTurnsAfterRoot(manager, root.id)).toHaveLength(1)
  })

  test('recovery after a restart catches the chat up in one turn and leaves legacy agents alone', async () => {
    const rootId = 'root-1'
    const record = (fields: Record<string, unknown>) => JSON.stringify({ ...base, cwd: repo, pid: 999_999, startedAt: 1, endedAt: 2, diffStat: null, ...fields })
    await mkdir(join(configDir, LOGS_DIR), { recursive: true })
    await writeFile(join(configDir, JOBS_FILE), [
      record({ id: rootId, engine: 'claude', label: 'Login fix', purpose: 'chat', project: repo, threadRoot: rootId, chatId: undefined, sessionId: 'sess-1', source: 'user', edit: false }),
      record({ id: 'agent-1', label: 'Build it', chatId: rootId, threadRoot: 'agent-1', reportedAt: null, startedAt: 3, endedAt: 4 }),
      record({ id: 'legacy', label: 'Old work', chatId: rootId, threadRoot: 'legacy', startedAt: 5, endedAt: 6 }),
      '',
    ].join('\n'))
    await writeFile(join(configDir, LOGS_DIR, 'agent-1.log'), `${textEvent('Finished while you were away.')}\n`)
    const manager = createJobManager({ home: homedir() })
    const flusher = flusherFor(manager)
    await flusher.recoverAll()
    const turns = chatTurnsAfterRoot(manager, rootId)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt.startsWith(`${RESTART_CATCH_UP}\n[agent Build it · codex] done`)).toBe(true)
    expect(turns[0]?.prompt).toContain('Finished while you were away.')
    expect(turns[0]?.prompt).not.toContain('Old work')
    expect(turns[0]?.source).toBe('agent')
    expect(typeof manager.getJob('agent-1')?.reportedAt).toBe('number')
    await settled(manager, turns[0]!.id)
  })

  test('recovery sends messages that were queued before the restart', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    await createChatQueue(queueFile()).add(root.id, 'did you finish?')
    const flusher = flusherFor(manager)
    await flusher.recoverAll()
    const turns = chatTurnsAfterRoot(manager, root.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).toBe('did you finish?')
    expect(turns[0]?.source).toBe('user')
    await settled(manager, turns[0]!.id)
  })

  test('a job with no chat, a workflow step, or a chat id that is not a chat root posts nothing', async () => {
    const manager = createJobManager({ home: homedir() })
    const worker = await agent(manager, 'missing', 'x')
    const flusher = flusherFor(manager, { schedule: () => { throw new Error('should not retry') } })
    await flusher.onAgentSettled(worker)
    await flusher.onAgentSettled({ ...worker, chatId: undefined })
    await flusher.onAgentSettled({ ...worker, chatId: worker.id })
    await flusher.kick('missing')
    expect(manager.listJobs()).toHaveLength(1)
  })

  test('a workflow step in a chat is not reported', async () => {
    const manager = createJobManager({ home: homedir() })
    const root = await settled(manager, (await chatRoot(manager)).id)
    const step = await manager.createJob({ engine: 'codex', cwd: repo, prompt: 'p', label: 'Step', chatId: root.id, workflowRunId: 'run-1', workflowNodeId: 'n1', workflowAttempt: 1 }, agentResolver('step done'))
    if (!step.ok) throw new Error(step.error)
    const done = await settled(manager, step.job.id)
    expect(done.reportedAt).toBeUndefined()
    const flusher = flusherFor(manager)
    await flusher.onAgentSettled(done)
    await flusher.recoverAll()
    expect(agentTurns(manager)).toHaveLength(0)
  })
})
