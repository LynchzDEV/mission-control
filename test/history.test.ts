import { describe, expect, test } from 'bun:test'

import { buildHistory, createExternalSessionsCache, ownedPids } from '../server/history'
import type { JobRecord } from '../server/jobs'
import type { PastTerminal } from '../server/terminal-log'
import type { TerminalRecord } from '../server/terminals'

const job: JobRecord = { id: 'j', engine: 'claude', cwd: '/p', worktree: null, baseRepo: null, baseBranch: null, label: 'job', prompt: 'x', pid: 100, status: 'done', startedAt: 1, turns: 1, slowAt: null, lastTool: null, endedAt: 2, exitCode: 0, diffStat: null, reviewedAt: null, sessionId: null, parentJobId: null, threadRoot: 'j', terminalId: null, reviewOf: null, model: null }
const terminal: TerminalRecord = { id: 't1', engine: 'claude', cwd: '/repo', pid: 300, createdAt: 3_000, title: 'Shell work', sessionId: 'sess-terminal' }

describe('ownedPids', () => {
  test('collects every job and terminal pid', () => {
    expect(ownedPids([job, { ...job, id: 'k', pid: 101, status: 'running' }], [terminal])).toEqual(new Set([100, 101, 300]))
  })
})

describe('buildHistory', () => {
  const root: JobRecord = { ...job, id: 'c1', purpose: 'chat', threadRoot: 'c1', label: 'Fix login', startedAt: 1_000, project: '/p', pid: 110, sessionId: 'sess-chat' }
  const turn: JobRecord = { ...job, id: 'c1-2', purpose: 'chat', threadRoot: 'c1', label: 'Fix login', startedAt: 2_000, pid: 111 }
  const agent: JobRecord = { ...job, id: 'a1', label: 'Build it', status: 'running', startedAt: 1_500, chatId: 'c1', pid: 120, landedAt: undefined }
  const ended: PastTerminal = { id: 't0', engine: 'claude', cwd: '/repo', title: 'Yesterday work', sessionId: 'sess-ended', createdAt: 500, endedAt: 2_500 }
  const session = (id: string, updatedAt: number, cwd = '/repo') => ({ id, title: `about ${id}`, startedAt: 1, updatedAt, bytes: 42, cwd })
  const items = buildHistory({
    jobs: [root, turn, agent],
    terminals: [terminal],
    ended: [ended],
    sessions: [session('sess-terminal', 4_000), session('sess-ended', 2_600), session('sess-chat', 2_700), session('sess-ghostty', 3_500, '/Users/x')],
  })

  test('lists chats, live and ended terminals and the sessions a person started, newest first', () => {
    expect(items.map(item => `${item.kind}:${item.id}`)).toEqual(['claude-history:sess-ghostty', 'terminal:t1', 'terminal:t0', 'chat:c1'])
  })
  test('a chat is its root with the latest turn time, its agents and running when an agent runs', () => {
    const chat = items.find(item => item.kind === 'chat')
    expect(chat).toEqual({ kind: 'chat', id: 'c1', title: 'Fix login', updatedAt: 2_000, project: '/p', running: true, agents: [{ id: 'a1', label: 'Build it', status: 'running', chatId: 'c1', startedAt: 1_500, landedAt: null, stoppedAt: null, reviewOf: null }] })
  })
  test('live terminals are marked live; ended ones keep their own name and date from when they ended', () => {
    expect(items.find(item => item.id === 't1')).toEqual({ kind: 'terminal', id: 't1', title: 'Shell work', updatedAt: 3_000, cwd: '/repo', engine: 'claude', sessionId: 'sess-terminal', live: true })
    expect(items.find(item => item.id === 't0')).toEqual({ kind: 'terminal', id: 't0', title: 'Yesterday work', updatedAt: 2_500, cwd: '/repo', engine: 'claude', sessionId: 'sess-ended', live: false })
  })
  test('a session that belongs to a live terminal, an ended terminal or a job is not listed again', () => {
    expect(items.filter(item => item.kind === 'claude-history').map(item => item.id)).toEqual(['sess-ghostty'])
    expect(items.find(item => item.id === 'sess-ghostty')).toEqual({ kind: 'claude-history', id: 'sess-ghostty', title: 'about sess-ghostty', updatedAt: 3_500, cwd: '/Users/x', bytes: 42 })
  })
  test('an ended terminal that never ended cleanly dates from when it opened, and no sources means no items', () => {
    expect(buildHistory({ jobs: [], terminals: [], ended: [{ ...ended, endedAt: null }], sessions: [] })[0]).toMatchObject({ id: 't0', updatedAt: 500, live: false })
    expect(buildHistory({ jobs: [], terminals: [], ended: [], sessions: [] })).toEqual([])
  })
  test('a finished chat is not running', () => {
    const quiet = buildHistory({ jobs: [root, { ...agent, status: 'done' }], terminals: [], ended: [], sessions: [] })
    expect(quiet).toHaveLength(1)
    expect(quiet[0]).toMatchObject({ kind: 'chat', running: false, updatedAt: 1_000 })
  })
})

describe('createExternalSessionsCache', () => {
  test('reads the owned pids at each refresh, not once', async () => {
    let owned = new Set([1])
    const seen: number[][] = []
    let time = 0
    const cache = createExternalSessionsCache(() => owned, async pids => { seen.push([...pids]); return [] }, 60_000, () => time)
    await cache.get()
    owned = new Set([1, 2])
    await cache.get()
    time = 60_001
    await cache.get()
    expect(seen).toEqual([[1], [1, 2]])
  })
})
