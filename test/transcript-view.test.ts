import { expect, test } from 'bun:test'
import { STATE_LABEL, lastTool, pasteSequence, rowKey, sessionState, transcriptRows } from '../client/transcript-view'

const row = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, text: '', title: '', detail: '', input: '', result: '', isError: false, ...extra })

test('session state follows the last row: tools and prompts mean working, assistant text means waiting for you', () => {
  expect(sessionState([], false)).toBe('idle')
  expect(sessionState([], true)).toBe('ready')
  expect(sessionState([row('prompt')], true)).toBe('working')
  expect(sessionState([row('prompt'), row('tool', { title: 'Read' })], true)).toBe('working')
  expect(sessionState([row('prompt'), row('tool', { title: 'Read', result: 'ok' })], true)).toBe('working')
  expect(sessionState([row('prompt'), row('thinking')], true)).toBe('working')
  expect(sessionState([row('prompt'), row('text', { text: 'done' })], true)).toBe('waiting')
  expect(sessionState([row('result')], true)).toBe('waiting')
  expect(STATE_LABEL.waiting).toBe('Waiting for you')
})

test('lastTool names the newest tool of the current turn only', () => {
  expect(lastTool([row('prompt'), row('tool', { title: 'Read', detail: 'a.ts' }), row('tool', { title: 'Bash', input: 'bun test' })])).toBe('Bash bun test')
  expect(lastTool([row('tool', { title: 'Read', detail: 'a.ts' }), row('prompt')])).toBe('')
  expect(lastTool([])).toBe('')
})

test('rows normalise loosely, keys change when results attach, and input is sent as a bracketed paste', () => {
  const rows = transcriptRows([{ kind: 'tool', title: 'Read', isError: 'yes' }, { text: 'hi' }, 'junk'])
  expect(rows).toEqual([row('tool', { title: 'Read' }), row('text', { text: 'hi' })])
  expect(rowKey(rows[0]!)).not.toBe(rowKey({ ...rows[0]!, result: 'out' }))
  expect(pasteSequence('ls\nls')).toBe('\x1b[200~ls\nls\x1b[201~\r')
})
