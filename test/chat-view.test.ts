import { describe, expect, test } from 'bun:test'
import { teamRows, titleFrom, turnsFrom, workedLine } from '../client/chat-view'

const thread = [
  { role: 'user', kind: 'prompt', jobId: 't1', ts: 1000, text: 'Fix login' },
  { role: 'assistant', kind: 'tool', jobId: 't1', title: 'Read', detail: 'a.ts', input: '', result: '', resultIsError: false },
  { role: 'assistant', kind: 'text', jobId: 't1', text: 'On it.' },
  { role: 'user', kind: 'prompt', jobId: 't2', ts: 5000, text: '[agent Build it · codex] done' },
  { role: 'assistant', kind: 'text', jobId: 't2', text: 'Landed.' },
]
const jobs = [
  { id: 't1', status: 'done', startedAt: 1000, endedAt: 19000, source: 'user' },
  { id: 't2', status: 'running', startedAt: 5000, endedAt: null, source: 'agent' },
]

describe('turnsFrom', () => {
  test('one turn per prompt with its text, tool count and source', () => {
    const turns = turnsFrom(thread as never, jobs as never)
    expect(turns.map(turn => [turn.id, turn.source, turn.tools, turn.text, turn.running])).toEqual([['t1', 'user', 1, 'On it.', false], ['t2', 'agent', 0, 'Landed.', true]])
  })
  test('a prompt whose job is unknown still renders as a user turn', () => {
    const turns = turnsFrom(thread.slice(0, 1) as never, [])
    expect(turns[0]).toMatchObject({ id: 't1', source: 'user', running: false, started: 1000 })
  })
})

describe('workedLine', () => {
  test('working while running, worked with tool count after', () => {
    const [first, second] = turnsFrom(thread as never, jobs as never)
    expect(workedLine(first!, 20000)).toBe('Worked 18s · used 1 tool')
    expect(workedLine(second!, 17000)).toBe('Working · 12s')
    expect(workedLine({ ...first!, tools: 0 }, 20000)).toBe('Answered')
    expect(workedLine({ ...first!, tools: 3, ended: 1000 + 125_000 }, 200000)).toBe('Worked 2m 5s · used 3 tools')
  })
})

describe('teamRows', () => {
  const agents = [
    { id: 'a', engine: 'codex', model: 'gpt-5.5', label: 'Build it', reason: 'many edits', status: 'done', startedAt: 1, endedAt: 2, chatTurn: 't1', reviewOf: null, reviewedAt: null, currentActivity: null, diffStat: ' 1 file' },
    { id: 'r', engine: 'claude', model: null, label: 'Review', reason: 'other family', status: 'running', startedAt: 3, endedAt: null, chatTurn: 't1', reviewOf: 'a', reviewedAt: null, currentActivity: 'Reading diff', diffStat: null },
    { id: 'f', engine: 'glm', model: null, label: 'Docs', reason: '', status: 'failed', startedAt: 3, endedAt: 4, chatTurn: 't1', reviewOf: null, reviewedAt: null, currentActivity: null, diffStat: null },
    { id: 'x', engine: 'glm', model: null, label: 'Elsewhere', reason: '', status: 'done', startedAt: 3, endedAt: 4, chatTurn: 't9', reviewOf: null, reviewedAt: null, currentActivity: null, diffStat: null },
  ]
  test('rows for the turn only, with review and failure states', () => {
    expect(teamRows(agents as never, 't1').map(row => [row.id, row.state, row.activity])).toEqual([['a', 'reviewing', ''], ['r', 'running', 'Reading diff'], ['f', 'needs-you', '']])
    expect(teamRows([{ ...agents[0], reviewedAt: 9 }] as never, 't1')[0]?.state).toBe('landed')
    expect(teamRows([agents[0]] as never, 't1')[0]?.state).toBe('done')
  })
})

describe('titleFrom', () => {
  test('first line, 60 characters', () => {
    expect(titleFrom('Fix the login bug\nplease')).toBe('Fix the login bug')
    expect(titleFrom('x'.repeat(80))).toHaveLength(60)
    expect(titleFrom('   ')).toBe('New chat')
  })
})
