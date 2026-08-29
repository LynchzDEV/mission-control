import { describe, expect, test } from 'bun:test'

import {
  MINI_ROW_LIMIT,
  NO_OUTPUT_TEXT,
  RESULT_EXCERPT_LINES,
  WAITING_TEXT,
  engineClass,
  excerpt,
  firstLine,
  fullRows,
  isPendingTool,
  miniFooter,
  miniRows,
  oneLine,
  rowSignature,
  threadCounts,
  toThreadModel,
  toThreadRows,
  type ThreadModel,
  type ThreadRow,
} from '../client/thread-view'
import {
  NO_SESSION_NOTE,
  SINGLE_TURN_NOTE,
  headerStats,
  optimisticRow,
  replyNote,
  statusLabel,
} from '../client/thread-drawer'

function row(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    key: 'a#0',
    jobId: 'a',
    role: 'assistant',
    kind: 'text',
    text: '',
    title: '',
    detail: '',
    input: '',
    result: '',
    isError: false,
    ...overrides,
  }
}

function model(rows: ThreadRow[], running = false): ThreadModel {
  return { rows, running, canReply: true, engine: 'claude' }
}

const EXCHANGE: ThreadRow[] = [
  row({ key: 'a#0', kind: 'prompt', role: 'user', text: 'read notes.txt and append world' }),
  row({ key: 'a#1', kind: 'thinking', text: 'the file holds hello\nso append a second line' }),
  row({ key: 'a#2', kind: 'tool', title: 'Read', detail: 'notes.txt', result: '1\thello' }),
  row({
    key: 'a#3',
    kind: 'tool',
    title: 'Bash',
    detail: "Append 'world' to notes.txt",
    result: 'Output redirection was blocked',
    isError: true,
  }),
  row({ key: 'a#4', kind: 'text', text: 'I read notes.txt, then appended world.' }),
  row({ key: 'a#5', kind: 'result', text: 'I read notes.txt, then appended world.' }),
]

describe('toThreadRows', () => {
  test('maps the wire shapes into rows, keyed per job by position', () => {
    const rows = toThreadRows([
      { role: 'user', kind: 'prompt', jobId: 'a', text: 'say alpha' },
      { role: 'assistant', kind: 'thinking', jobId: 'a', text: 'work it out' },
      {
        role: 'assistant',
        kind: 'tool',
        jobId: 'a',
        title: 'Bash',
        detail: 'Echo done',
        input: '{"command":"echo done"}',
        result: 'done',
        resultIsError: false,
      },
      { role: 'result', kind: 'result', jobId: 'a', text: 'finished', isError: false },
      { role: 'user', kind: 'prompt', jobId: 'b', text: 'and again?' },
    ])

    expect(rows.map((entry) => entry.key)).toEqual(['a#0', 'a#1', 'a#2', 'a#3', 'b#0'])
    expect(rows[2]).toEqual({
      key: 'a#2',
      jobId: 'a',
      role: 'assistant',
      kind: 'tool',
      text: '',
      title: 'Bash',
      detail: 'Echo done',
      input: '{"command":"echo done"}',
      result: 'done',
      isError: false,
    })
  })

  test('keys stay stable as later messages arrive, so a poll appends instead of reshuffling', () => {
    const first = toThreadRows([
      { role: 'user', kind: 'prompt', jobId: 'a', text: 'one' },
      { role: 'assistant', kind: 'text', jobId: 'a', text: 'two' },
    ])
    const second = toThreadRows([
      { role: 'user', kind: 'prompt', jobId: 'a', text: 'one' },
      { role: 'assistant', kind: 'text', jobId: 'a', text: 'two' },
      { role: 'assistant', kind: 'text', jobId: 'a', text: 'three' },
    ])

    expect(second.slice(0, 2).map((entry) => entry.key)).toEqual(first.map((entry) => entry.key))
    expect(second[2]?.key).toBe('a#2')
  })

  test('marks a failed result and a failed tool alike', () => {
    const rows = toThreadRows([
      { role: 'result', kind: 'result', jobId: 'a', text: 'boom', isError: true },
      { role: 'assistant', kind: 'tool', jobId: 'a', title: 'Bash', resultIsError: true },
    ])
    expect(rows.map((entry) => entry.isError)).toEqual([true, true])
  })

  test('survives a malformed message with defaults rather than throwing', () => {
    const rows = toThreadRows([{}, { jobId: 7, kind: 12 }])
    expect(rows.map((entry) => `${entry.jobId}/${entry.kind}`)).toEqual(['?/text', '?/text'])
    expect(rows.map((entry) => entry.key)).toEqual(['?#0', '?#1'])
  })
})

describe('toThreadModel', () => {
  test('reads the envelope flags the drawer gates on', () => {
    const parsed = toThreadModel({
      engine: 'claude',
      running: true,
      canReply: true,
      messages: [{ role: 'user', kind: 'prompt', jobId: 'a', text: 'hi' }],
    })

    expect(parsed).toMatchObject({ engine: 'claude', running: true, canReply: true })
    expect(parsed.rows).toHaveLength(1)
  })

  test('defaults to a closed, non-running thread when the payload is empty', () => {
    expect(toThreadModel({})).toEqual({ rows: [], running: false, canReply: false, engine: '?' })
  })
})

describe('text helpers', () => {
  test('firstLine takes the first non-blank line', () => {
    expect(firstLine('\n\n  first  \nsecond')).toBe('first')
    expect(firstLine('   ')).toBe('')
  })

  test('oneLine marks that a multi-line row was cut', () => {
    expect(oneLine('only one line')).toBe('only one line')
    expect(oneLine('first\nsecond')).toBe('first…')
    expect(oneLine('')).toBe('')
  })

  test('excerpt keeps short output whole and truncates long output with a count', () => {
    const short = 'a\nb\nc'
    expect(excerpt(short)).toBe(short)

    const long = Array.from({ length: RESULT_EXCERPT_LINES + 3 }, (_, index) => `line ${index}`).join('\n')
    const cut = excerpt(long)
    expect(cut.split('\n')).toHaveLength(RESULT_EXCERPT_LINES + 1)
    expect(cut.endsWith('… +3 more lines')).toBe(true)
  })

  test('a signature changes only when the row content changes', () => {
    const base = row({ kind: 'tool', title: 'Bash', detail: 'Echo done' })
    expect(rowSignature(base)).toBe(rowSignature({ ...base, key: 'other' }))
    expect(rowSignature(base)).not.toBe(rowSignature({ ...base, result: 'done' }))
    expect(rowSignature(base)).not.toBe(rowSignature({ ...base, isError: true }))
  })

  test('engineClass maps each engine to its theme colour class', () => {
    expect(engineClass('claude')).toBe('c-claude')
    expect(engineClass('glm')).toBe('c-glm')
    expect(engineClass('codex')).toBe('c-white')
    expect(engineClass('mystery')).toBe('c-white')
  })
})

describe('running detection', () => {
  test('a resultless tool in a live thread is the step happening now', () => {
    expect(isPendingTool(row({ kind: 'tool' }), true)).toBe(true)
  })

  test('a finished tool, or any tool in a settled thread, is not pending', () => {
    expect(isPendingTool(row({ kind: 'tool', result: 'done' }), true)).toBe(false)
    expect(isPendingTool(row({ kind: 'tool' }), false)).toBe(false)
    expect(isPendingTool(row({ kind: 'text' }), true)).toBe(false)
  })
})

describe('miniRows', () => {
  test('renders the finished exchange in the card grammar', () => {
    const rows = miniRows(model(EXCHANGE), 10)
    expect(rows.map((entry) => `${entry.glyph} ${entry.cls}`.trim())).toEqual([
      '› req',
      '✻ think',
      '⏺',
      '⏺',
      '⎿ err',
      '✓ resp',
    ])
    expect(rows[0]?.text).toBe('read notes.txt and append world')
    expect(rows[1]?.text).toBe('the file holds hello…')
    expect(rows[2]).toMatchObject({ title: 'Read', text: 'notes.txt' })
  })

  test('collapses the duplicated assistant text and final result into one response row', () => {
    expect(miniRows(model(EXCHANGE), 10).filter((entry) => entry.cls === 'resp')).toHaveLength(1)
  })

  test('marks the tool with no result yet as the live step while the job runs', () => {
    const rows = miniRows(
      model([...EXCHANGE.slice(0, 3), row({ key: 'a#3', kind: 'tool', title: 'Bash', detail: 'Run tests' })], true),
      10,
    )
    const live = rows[rows.length - 2]
    expect(live).toMatchObject({ cls: 'live', glyph: '●', title: 'Bash', text: 'Run tests' })
  })

  test('waits for the response while the newest job runs without one', () => {
    const rows = miniRows(model(EXCHANGE.slice(0, 3), true), 10)
    expect(rows[rows.length - 1]).toMatchObject({ cls: 'resp wait', glyph: '…', text: WAITING_TEXT })
  })

  test('drops the waiting row once the running job has answered', () => {
    const rows = miniRows(model(EXCHANGE, true), 10)
    expect(rows.some((entry) => entry.text === WAITING_TEXT)).toBe(false)
  })

  test('waits again on a reply turn even though the first turn answered', () => {
    const rows = miniRows(
      model([...EXCHANGE, row({ key: 'b#0', jobId: 'b', kind: 'prompt', role: 'user', text: 'what word?' })], true),
      10,
    )
    expect(rows[rows.length - 2]).toMatchObject({ cls: 'req', text: 'what word?' })
    expect(rows[rows.length - 1]?.text).toBe(WAITING_TEXT)
  })

  test('shows a reply turn as its own request and response pair', () => {
    const rows = miniRows(
      model([
        ...EXCHANGE,
        row({ key: 'b#0', jobId: 'b', kind: 'prompt', role: 'user', text: 'what word did you say?' }),
        row({ key: 'b#1', jobId: 'b', kind: 'result', text: 'world' }),
      ]),
      10,
    )
    expect(rows.slice(-2).map((entry) => [entry.cls, entry.text])).toEqual([
      ['req', 'what word did you say?'],
      ['resp', 'world'],
    ])
  })

  test('keeps the newest rows when the card limit trims the list', () => {
    const rows = miniRows(
      model([
        ...EXCHANGE,
        row({ key: 'b#0', jobId: 'b', kind: 'prompt', role: 'user', text: 'what word did you say?' }),
        row({ key: 'b#1', jobId: 'b', kind: 'result', text: 'world' }),
      ]),
    )
    expect(rows).toHaveLength(MINI_ROW_LIMIT)
    expect(rows[rows.length - 1]).toMatchObject({ cls: 'resp', text: 'world' })
    expect(rows.some((entry) => entry.cls === 'think')).toBe(false)
  })

  test('keys are unique and stable as a later poll appends rows', () => {
    const first = miniRows(model(EXCHANGE.slice(0, 3), true), -1)
    const second = miniRows(model(EXCHANGE, true), -1)
    const keys = second.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.slice(0, 3)).toEqual(first.slice(0, 3).map((entry) => entry.key))
  })

  test('an empty thread renders nothing at all', () => {
    expect(miniRows(model([]))).toEqual([])
  })
})

describe('miniFooter', () => {
  test('counts the rows a running card cannot show', () => {
    expect(miniFooter(model(EXCHANGE, true), 2)).toBe('▸ OPEN FULL TRANSCRIPT · 4 more')
  })

  test('summarises tools and thoughts once the job is done', () => {
    expect(miniFooter(model(EXCHANGE))).toBe('▸ OPEN FULL TRANSCRIPT · 2 tools · 1 thoughts')
  })

  test('never reports a negative overflow', () => {
    expect(miniFooter(model(EXCHANGE.slice(0, 1), true))).toBe('▸ OPEN FULL TRANSCRIPT · 0 more')
  })
})

describe('fullRows', () => {
  test('gives every kind its gutter glyph and collapse flag', () => {
    const rows = fullRows(model(EXCHANGE))
    expect(rows.map((entry) => [entry.cls, entry.glyph, entry.collapsible])).toEqual([
      ['user', '›', false],
      ['think', '✻', true],
      ['tool', '⏺', true],
      ['tool', '⏺', true],
      ['text', '⏺', false],
      ['final', '✓', false],
    ])
  })

  test('carries the tool result and its error flag', () => {
    const tool = fullRows(model(EXCHANGE))[3]
    expect(tool).toMatchObject({
      title: 'Bash',
      detail: "Append 'world' to notes.txt",
      result: 'Output redirection was blocked',
      isError: true,
    })
  })

  test('names an empty tool result rather than rendering a blank line', () => {
    expect(fullRows(model([row({ kind: 'tool', title: 'Bash' })]))[0]?.result).toBe(NO_OUTPUT_TEXT)
  })

  test('keeps the whole prompt text, unlike the one-line card view', () => {
    const rows = fullRows(model([row({ kind: 'prompt', role: 'user', text: 'first\nsecond' })]))
    expect(rows[0]?.text).toBe('first\nsecond')
  })
})

describe('thread counts', () => {
  test('counts tool calls and thoughts for the drawer header', () => {
    expect(threadCounts(model(EXCHANGE))).toEqual({ tools: 2, thoughts: 1 })
    expect(headerStats(model(EXCHANGE))).toBe('2 TOOLS · 1 THOUGHTS · ESC CLOSE')
    expect(headerStats(null)).toBe('ESC CLOSE')
  })

  test('reports the live status word', () => {
    expect(statusLabel(model([], true))).toBe('RUNNING')
    expect(statusLabel(model([]))).toBe('DONE')
    expect(statusLabel(null)).toBe('…')
  })
})

describe('reply gating', () => {
  test('says nothing while the thread can be replied to', () => {
    expect(replyNote({ rows: [], running: false, canReply: true, engine: 'claude' })).toBe('')
  })

  test('explains a resumable engine that has not reported a session id yet', () => {
    expect(replyNote({ rows: [], running: true, canReply: false, engine: 'claude' })).toBe(NO_SESSION_NOTE)
    expect(replyNote({ rows: [], running: true, canReply: false, engine: 'codex' })).toBe(NO_SESSION_NOTE)
  })

  test('calls out an engine with no resume path at all', () => {
    expect(replyNote({ rows: [], running: false, canReply: false, engine: 'mystery' })).toBe(SINGLE_TURN_NOTE)
  })

  test('an unloaded thread offers no note and no reply', () => {
    expect(replyNote(null)).toBe('')
  })

  test('an optimistic row renders as the user turn it will become', () => {
    const pending = optimisticRow('a', 'what word did you say?', 1)
    expect(pending).toMatchObject({ key: 'pending#1', jobId: 'a', role: 'user', kind: 'prompt' })
    expect(pending.text).toBe('what word did you say?')
  })
})
