import { describe, expect, test } from 'bun:test'
import { chatSignal, filterSlashCommands, historyAction, historyDay, historyLabel, historyOpen, parseAgentReport, runningLabel, slashQuery, stepText, teamRows, titleFrom, turnsFrom, workedLine } from '../client/chat-view'

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

describe('turn steps and running label', () => {
  test('stepText names the action for known tools and falls back to the tool title', () => {
    expect(stepText('Read', 'client/chat.ts')).toBe('Reading client/chat.ts')
    expect(stepText('Bash', 'bun test')).toBe('Running bun test')
    expect(stepText('Grep', 'scrollTop')).toBe('Searching scrollTop')
    expect(stepText('WebFetch', 'x.com')).toBe('WebFetch x.com')
  })
  test('turnsFrom lists one step per tool message in order', () => {
    const steps = [
      { role: 'user', kind: 'prompt', jobId: 't1', ts: 1000, text: 'Fix' },
      { role: 'assistant', kind: 'tool', jobId: 't1', title: 'Read', detail: 'a.ts', input: '', result: '', resultIsError: false },
      { role: 'assistant', kind: 'tool', jobId: 't1', title: 'Edit', detail: 'a.ts', input: '', result: '', resultIsError: false },
    ]
    expect(turnsFrom(steps as never, jobs as never)[0]?.steps).toEqual(['Reading a.ts', 'Editing a.ts'])
  })
  test('a running turn is thinking only while its last message is a partial thinking block', () => {
    const open = [
      { role: 'user', kind: 'prompt', jobId: 't2', ts: 5000, text: 'Hi' },
      { role: 'assistant', kind: 'thinking', jobId: 't2', text: '', partial: true },
    ]
    expect(turnsFrom(open as never, jobs as never)[0]?.thinking).toBe(true)
    expect(turnsFrom([...open, { role: 'assistant', kind: 'text', jobId: 't2', text: 'Hey', partial: true }] as never, jobs as never)[0]?.thinking).toBe(false)
    expect(turnsFrom([{ ...open[0], jobId: 't1' }, { ...open[1], jobId: 't1' }] as never, jobs as never)[0]?.thinking).toBe(false)
  })
  test('runningLabel reads thinking before any text and writing once text exists', () => {
    const [, running] = turnsFrom(thread as never, jobs as never)
    expect(runningLabel({ ...running!, text: '', started: 1000 }, 5000)).toBe('Thinking · 4s')
    expect(runningLabel({ ...running!, text: 'Hi', started: 1000 }, 5000)).toBe('Writing · 4s')
  })
})

describe('turn tool cards', () => {
  test('a tool with a result is done while an empty one inside the same running turn is running', () => {
    const running = [
      { role: 'user', kind: 'prompt', jobId: 't2', ts: 5000, text: 'Hi' },
      { role: 'assistant', kind: 'tool', jobId: 't2', title: 'Read', detail: 'a.ts', input: '', result: 'x', resultIsError: false },
      { role: 'assistant', kind: 'tool', jobId: 't2', title: 'Bash', detail: 'bun test', input: '', result: '', resultIsError: false },
    ]
    const cards = turnsFrom(running as never, jobs as never)[0]?.cards
    expect(cards?.map(card => [card.verb, card.status])).toEqual([['Read', 'done'], ['Bash', 'running']])
  })
})

describe('turn failure and stop states', () => {
  test('an error result fails the turn with its first line as the reason', () => {
    const turn = turnsFrom([
      { role: 'user', kind: 'prompt', jobId: 't1', ts: 1000, text: 'Go' },
      { role: 'result', kind: 'result', jobId: 't1', text: 'API Error: overloaded\nmore', isError: true },
    ] as never, [{ id: 't1', status: 'done', startedAt: 1000, endedAt: 9000 }] as never)[0]!
    expect(turn).toMatchObject({ failed: true, stopped: false, error: 'API Error: overloaded', errorDetail: 'API Error: overloaded\nmore' })
    expect(workedLine(turn, 10_000).startsWith('Failed after')).toBe(true)
  })

  test('a stopped job reads stopped, never failed, even when its status says failed', () => {
    const turn = turnsFrom([
      { role: 'user', kind: 'prompt', jobId: 't1', ts: 1000, text: 'Go' },
    ] as never, [{ id: 't1', status: 'failed', startedAt: 1000, endedAt: 6000, stoppedAt: 5000 }] as never)[0]!
    expect(turn).toMatchObject({ failed: false, stopped: true })
    expect(workedLine(turn, 10_000).startsWith('Stopped after')).toBe(true)
  })

  test('a failed job status without an error result keeps the last result text as the reason', () => {
    const turn = turnsFrom([
      { role: 'user', kind: 'prompt', jobId: 't1', ts: 1000, text: 'Go' },
      { role: 'result', kind: 'result', jobId: 't1', text: 'done', isError: false },
    ] as never, [{ id: 't1', status: 'failed', startedAt: 1000, endedAt: 9000 }] as never)[0]!
    expect(turn).toMatchObject({ failed: true, error: 'done', errorDetail: 'done' })
  })

  test('a failed job status with no result at all gets a fallback reason', () => {
    const turn = turnsFrom([
      { role: 'user', kind: 'prompt', jobId: 't1', ts: 1000, text: 'Go' },
    ] as never, [{ id: 't1', status: 'failed', startedAt: 1000, endedAt: 9000 }] as never)[0]!
    expect(turn).toMatchObject({ failed: true, error: 'The reply ended unexpectedly', errorDetail: '' })
  })
})

describe('workedLine', () => {
  test('working while running, worked with tool count after', () => {
    const [first, second] = turnsFrom(thread as never, jobs as never)
    expect(workedLine(first!, 20000)).toBe('Worked 18s · used 1 tool')
    expect(workedLine(second!, 17000)).toBe('Writing · 12s')
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
    expect(teamRows([{ ...agents[0], landedAt: 9 }] as never, 't1')[0]?.state).toBe('landed')
    expect(teamRows([{ ...agents[0], reviewedAt: 9 }] as never, 't1')[0]?.state).toBe('done')
    expect(teamRows([agents[0]] as never, 't1')[0]?.state).toBe('done')
  })
  test('a failed attempt followed by a later attempt with the same step reads retried; a stopped job reads stopped', () => {
    const failed = { ...agents[2], chatId: 'c' }
    const retry = { ...agents[2], id: 'f2', status: 'done', startedAt: 9, chatId: 'c' }
    expect(teamRows([failed, retry] as never, 't1').map(row => row.state)).toEqual(['retried', 'done'])
    expect(teamRows([{ ...failed, stoppedAt: 5 }] as never, 't1')[0]?.state).toBe('stopped')
  })
  test('chatSignal reads running, then needs-you, then landed, with counts', () => {
    expect(chatSignal(false, [agents[0], agents[1]] as never)).toEqual({ state: 'running', count: 1 })
    expect(chatSignal(true, [] as never)).toEqual({ state: 'running', count: 0 })
    expect(chatSignal(false, [agents[2], { ...agents[2], id: 'g' }] as never)).toEqual({ state: 'needs-you', count: 2 })
    expect(chatSignal(false, [{ ...agents[0], landedAt: 1 }] as never)).toEqual({ state: 'landed', count: 1 })
    expect(chatSignal(false, [agents[0]] as never)).toEqual({ state: null, count: 0 })
  })
})

describe('titleFrom', () => {
  test('first line, 60 characters', () => {
    expect(titleFrom('Fix the login bug\nplease')).toBe('Fix the login bug')
    expect(titleFrom('x'.repeat(80))).toHaveLength(60)
    expect(titleFrom('   ')).toBe('New chat')
  })
})

describe('historyDay', () => {
  test('today, yesterday, then a short date', () => {
    const now = new Date(2026, 8, 24, 15).getTime()
    expect(historyDay(new Date(2026, 8, 24, 1).getTime(), now)).toBe('Today')
    expect(historyDay(new Date(2026, 8, 23, 23).getTime(), now)).toBe('Yesterday')
    expect(historyDay(new Date(2026, 8, 20, 9).getTime(), now)).toBe(new Date(2026, 8, 20).toLocaleDateString([], { month: 'short', day: 'numeric' }))
  })
})

describe('historyLabel, historyAction and historyOpen', () => {
  const liveTerminal = { kind: 'terminal' as const, id: 't', title: 'api work', updatedAt: 1, cwd: '/Users/me/app/', engine: 'claude', sessionId: 's1', live: true }
  const endedTerminal = { ...liveTerminal, live: false }
  const session = { kind: 'claude-history' as const, id: 's', title: 'fix specs', updatedAt: 1, cwd: '/Users/me/app', bytes: 3000 }
  test('labels say what each item is and where it ran', () => {
    expect(historyLabel({ kind: 'chat', id: 'c', title: 't', updatedAt: 1, project: '/Users/me/app', running: false, agents: [] })).toBe('Chat · app')
    expect(historyLabel(liveTerminal)).toBe('Terminal · live · app · claude')
    expect(historyLabel(endedTerminal)).toBe('Terminal · ended · app · claude')
    expect(historyLabel(session)).toBe('Claude Code · app · 3 KB')
  })
  test('a chat continues, a live terminal opens, ended terminals and sessions resume with their own engine and title', () => {
    expect(historyAction(liveTerminal)).toBe('Open terminal')
    expect(historyAction(endedTerminal)).toBe('Resume in a terminal')
    expect(historyAction(session)).toBe('Resume in a terminal')
    expect(historyOpen({ kind: 'chat', id: 'c', title: 't', updatedAt: 1, project: null, running: false, agents: [] })).toEqual({ chat: 'c' })
    expect(historyOpen(liveTerminal)).toEqual({ terminal: { id: 't' } })
    expect(historyOpen({ ...endedTerminal, engine: 'glm' })).toEqual({ terminal: { resume: { sessionId: 's1', cwd: '/Users/me/app/', title: 'api work', engine: 'glm' } } })
    expect(historyOpen(session)).toEqual({ terminal: { resume: { sessionId: 's', cwd: '/Users/me/app', title: 'fix specs', engine: 'claude' } } })
  })
  test('an ended terminal with no resumable session has no action', () => {
    expect(historyAction({ ...endedTerminal, sessionId: null })).toBeNull()
    expect(historyOpen({ ...endedTerminal, engine: 'codex' })).toBeNull()
  })
})

describe('parseAgentReport', () => {
  test('splits the agent head line into label, engine and outcome with the rest as body', () => {
    expect(parseAgentReport('[agent say-hi html · glm] done\nall good')).toEqual({ label: 'say-hi html', engine: 'glm', outcome: 'done', body: 'all good' })
  })

  test('a prompt without the agent head is not a report', () => {
    expect(parseAgentReport('hello')).toBeNull()
  })

  test('an In Session nudge reads as the step and workflow waiting on your turn', () => {
    const nudge = '[workflow Plan, verify, execute, review · your turn] Plan is In Session. Read it with GET /api/studio/runs/r1/steps/plan, do it here with the user, then report it: POST /api/studio/runs/r1/steps/plan.'
    expect(parseAgentReport(nudge)).toEqual({ label: 'Plan · Plan, verify, execute, review', engine: 'workflow', outcome: 'your turn', body: 'Plan is In Session. Read it with GET /api/studio/runs/r1/steps/plan, do it here with the user, then report it: POST /api/studio/runs/r1/steps/plan.' })
  })

  test('a finished workflow report keeps its step lines as the body', () => {
    expect(parseAgentReport('[workflow Ship it · blocked]\nPlan · pass · ok\nReason: no owner')).toEqual({ label: 'Ship it', engine: 'workflow', outcome: 'blocked', body: 'Plan · pass · ok\nReason: no owner' })
  })
})

describe('slash command menu helpers', () => {
  const commands = [
    { name: 'review', description: 'Review the current changes', argumentHint: '' },
    { name: 'resume', description: 'Pick up an earlier session', argumentHint: '' },
    { name: 'release-notes', description: 'Draft release notes', argumentHint: '' },
  ]

  test('the menu opens only while the whole box is one slash token', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/re')).toBe('re')
    expect(slashQuery('hello /re')).toBeNull()
    expect(slashQuery('/two words')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })

  test('rows filter by name prefix, case-insensitively', () => {
    expect(filterSlashCommands(commands, 'rev').map(command => command.name)).toEqual(['review'])
    expect(filterSlashCommands(commands, 'RE').map(command => command.name)).toEqual(['review', 'resume', 'release-notes'])
    expect(filterSlashCommands(commands, '/re').map(command => command.name)).toEqual([])
    expect(filterSlashCommands(commands, '')).toHaveLength(3)
  })
})
