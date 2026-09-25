import { describe, expect, test } from 'bun:test'

import { buildHistory, createExternalSessionsCache, etimeMs, ownedPids } from '../server/history'
import type { JobRecord } from '../server/jobs'
import type { ExternalSession } from '../server/quota'
import type { TerminalRecord } from '../server/terminals'

const job: JobRecord = { id: 'j', engine: 'claude', cwd: '/p', worktree: null, baseRepo: null, baseBranch: null, label: 'job', prompt: 'x', pid: 100, status: 'done', startedAt: 1, turns: 1, slowAt: null, lastTool: null, endedAt: 2, exitCode: 0, diffStat: null, reviewedAt: null, sessionId: null, parentJobId: null, threadRoot: 'j', terminalId: null, reviewOf: null, model: null }
const terminal: TerminalRecord = { id: 't1', engine: 'claude', cwd: '/repo', pid: 300, createdAt: 3_000, title: 'Shell work', sessionId: 'sess-terminal' }

describe('etimeMs', () => {
  test('reads MM:SS, HH:MM:SS and D-HH:MM:SS', () => {
    expect(etimeMs('05:30')).toBe(330_000)
    expect(etimeMs('01:02:03')).toBe(3_723_000)
    expect(etimeMs('2-00:00:10')).toBe(172_810_000)
  })
  test('an unreadable etime counts as zero', () => {
    expect(etimeMs('')).toBe(0)
    expect(etimeMs('abc')).toBe(0)
  })
})

describe('ownedPids', () => {
  test('collects every job and terminal pid', () => {
    expect(ownedPids([job, { ...job, id: 'k', pid: 101, status: 'running' }], [terminal])).toEqual(new Set([100, 101, 300]))
  })
})

describe('buildHistory', () => {
  const now = 10_000_000
  const root: JobRecord = { ...job, id: 'c1', purpose: 'chat', threadRoot: 'c1', label: 'Fix login', startedAt: 1_000, project: '/p', pid: 110 }
  const turn: JobRecord = { ...job, id: 'c1-2', purpose: 'chat', threadRoot: 'c1', label: 'Fix login', startedAt: 2_000, pid: 111 }
  const agent: JobRecord = { ...job, id: 'a1', label: 'Build it', status: 'running', startedAt: 1_500, chatId: 'c1', pid: 120, landedAt: undefined }
  const outside: ExternalSession[] = [
    { pid: 999, engine: 'codex', etime: '05:30', cwdHint: '/Users/x/elsewhere' },
    { pid: 998, engine: 'claude', etime: '1-00:00:00', cwdHint: null },
  ]
  const items = buildHistory({
    jobs: [root, turn, agent],
    terminals: [terminal],
    transcripts: [{ cwd: '/repo', sessions: [
      { id: 'sess-terminal', title: 'dup', startedAt: 1, updatedAt: 4_000, bytes: 10 },
      { id: 'sess-free', title: 'Old question', startedAt: 1, updatedAt: 500, bytes: 42 },
    ] }],
    outside,
    now,
  })

  test('lists every kind newest first', () => {
    expect(items.map(item => `${item.kind}:${item.id}`)).toEqual(['outside:999', 'terminal:t1', 'chat:c1', 'claude-history:sess-free', 'outside:998'])
  })
  test('a chat is its root with the latest turn time, its agents and running when an agent runs', () => {
    const chat = items.find(item => item.kind === 'chat')
    expect(chat).toEqual({ kind: 'chat', id: 'c1', title: 'Fix login', updatedAt: 2_000, project: '/p', running: true, agents: [{ id: 'a1', label: 'Build it', status: 'running', chatId: 'c1', startedAt: 1_500, landedAt: null, stoppedAt: null }] })
  })
  test('a transcript owned by a terminal or job is not repeated', () => {
    expect(items.some(item => item.kind === 'claude-history' && item.id === 'sess-terminal')).toBe(false)
    expect(items.find(item => item.id === 'sess-free')).toEqual({ kind: 'claude-history', id: 'sess-free', title: 'Old question', updatedAt: 500, cwd: '/repo', bytes: 42 })
  })
  test('outside sessions are titled by engine and folder and dated by elapsed time', () => {
    expect(items.find(item => item.id === '999')).toEqual({ kind: 'outside', id: '999', title: 'codex · elsewhere', updatedAt: now - 330_000, engine: 'codex', pid: 999, cwdHint: '/Users/x/elsewhere', etime: '05:30' })
    expect(items.find(item => item.id === '998')?.title).toBe('claude · unknown folder')
  })
  test('a finished chat is not running and outside sessions with our pids are dropped', () => {
    const quiet = buildHistory({ jobs: [root, { ...agent, status: 'done' }], terminals: [], transcripts: [], outside: [{ pid: 120, engine: 'claude', etime: '00:10', cwdHint: null }], now })
    expect(quiet).toHaveLength(1)
    expect(quiet[0]).toMatchObject({ kind: 'chat', running: false, updatedAt: 1_000 })
  })
  test('the same transcript seen from two folders appears once and no sources means no items', () => {
    const session = { id: 's', title: 't', startedAt: 1, updatedAt: 1, bytes: 1 }
    expect(buildHistory({ jobs: [], terminals: [], transcripts: [{ cwd: '/a', sessions: [session] }, { cwd: '/a', sessions: [session] }], outside: [], now })).toHaveLength(1)
    expect(buildHistory({ jobs: [], terminals: [], transcripts: [], outside: [], now })).toEqual([])
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
