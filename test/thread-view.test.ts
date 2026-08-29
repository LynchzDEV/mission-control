import { describe, expect, test } from 'bun:test'

import {
  RESULT_EXCERPT_LINES,
  excerpt,
  firstLine,
  isPendingTool,
  rowGlyph,
  rowSignature,
  toThreadModel,
  toThreadRows,
  type ThreadRow,
} from '../client/thread-view'
import {
  NO_SESSION_NOTE,
  SINGLE_TURN_NOTE,
  optimisticRow,
  replyNote,
} from '../client/thread-panel'

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
  test('reads the envelope flags the panel gates on', () => {
    const model = toThreadModel({
      engine: 'claude',
      running: true,
      canReply: true,
      messages: [{ role: 'user', kind: 'prompt', jobId: 'a', text: 'hi' }],
    })

    expect(model).toMatchObject({ engine: 'claude', running: true, canReply: true })
    expect(model.rows).toHaveLength(1)
  })

  test('defaults to a closed, non-running thread when the payload is empty', () => {
    expect(toThreadModel({})).toEqual({ rows: [], running: false, canReply: false, engine: '?' })
  })
})

describe('row presentation', () => {
  test('picks a glyph per kind, and the error glyph for a failed result', () => {
    expect(rowGlyph(row({ kind: 'prompt' }))).toBe('›')
    expect(rowGlyph(row({ kind: 'thinking' }))).toBe('◦')
    expect(rowGlyph(row({ kind: 'tool' }))).toBe('▸')
    expect(rowGlyph(row({ kind: 'result' }))).toBe('✓')
    expect(rowGlyph(row({ kind: 'result', isError: true }))).toBe('✕')
  })

  test('firstLine takes the first non-blank line for a collapsed row', () => {
    expect(firstLine('\n\n  first  \nsecond')).toBe('first')
    expect(firstLine('   ')).toBe('')
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
