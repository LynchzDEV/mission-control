import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DETAIL_PREVIEW_CHARS,
  TEXT_PREVIEW_CHARS,
  createActivityThrottle,
  currentActivity,
  formatActivity,
  parseActivity,
  toolDetail,
  type ActivityEvent,
} from '../server/activity'

const FIXTURE = join(import.meta.dir, 'fixtures', 'activity', 'claude-stream.jsonl')

async function fixtureEvents(max?: number): Promise<ActivityEvent[]> {
  const log = await readFile(FIXTURE, 'utf8')
  return max === undefined ? parseActivity(log) : parseActivity(log, max)
}

function line(text: string): string {
  return `${text}\n`
}

describe('parseActivity', () => {
  test('reads the whole fixture stream in order, skipping garbage and non-activity events', async () => {
    const events = await fixtureEvents()

    expect(events.map((event) => `${event.kind}:${event.title}`)).toEqual([
      'text:TEXT',
      'tool:Read',
      'tool:Edit',
      'tool:Bash',
      'tool:Bash',
      'text:TEXT',
      'tool:Bash',
      'result:RESULT',
    ])
  })

  test('humanises tool inputs to a single line', async () => {
    const events = await fixtureEvents()

    expect(events[1]).toEqual({ kind: 'tool', title: 'Read', detail: '/home/dev/code/server/flow.ts' })
    expect(events[2]).toEqual({ kind: 'tool', title: 'Edit', detail: '/home/dev/code/server/flow.ts' })
    expect(events[3]).toEqual({ kind: 'tool', title: 'Bash', detail: 'Run the flow unit tests' })
  })

  test('falls back to the command for a Bash block with no description, capped at the preview length', async () => {
    const events = await fixtureEvents()
    const long = events[4] as ActivityEvent

    expect(long.title).toBe('Bash')
    expect(long.detail.startsWith('git -C /home/dev/code diff --stat HEAD')).toBe(true)
    expect(long.detail.length).toBe(DETAIL_PREVIEW_CHARS + 1)
    expect(long.detail.endsWith('…')).toBe(true)
  })

  test('truncates assistant text to the text preview length', async () => {
    const events = await fixtureEvents()
    const text = events[0] as ActivityEvent

    expect(text.kind).toBe('text')
    expect(text.detail.startsWith('Reading the flow derivation module first')).toBe(true)
    expect(text.detail.length).toBe(TEXT_PREVIEW_CHARS + 1)
  })

  test('reads codex --json lines for agent messages and exec commands', async () => {
    const events = await fixtureEvents()

    expect(events[5]).toEqual({
      kind: 'text',
      title: 'TEXT',
      detail: 'codex-style line: reviewing the diff for the flow module',
    })
    expect(parseActivity(line('{"id":"1","msg":{"type":"exec_command_begin","command":["bash","-lc","ls -la"]}}'))).toEqual([
      { kind: 'tool', title: 'Bash', detail: 'bash -lc ls -la' },
    ])
  })

  test('marks a failed result as an error event', () => {
    const failed = parseActivity(
      line('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'),
    )
    expect(failed).toEqual([{ kind: 'error', title: 'ERROR', detail: 'boom' }])
  })

  test('survives an empty log, plain text output, and truncated leading lines', () => {
    expect(parseActivity('')).toEqual([])
    expect(parseActivity('hello world\nnothing structured here\n')).toEqual([])
    expect(
      parseActivity(
        `e":"assistant","message":{"content":[{"type":"text","text":"half a line"}]}}\n${line('{"type":"result","subtype":"success","result":"ok"}')}`,
      ),
    ).toEqual([{ kind: 'result', title: 'RESULT', detail: 'ok' }])
  })

  test('keeps a timestamp when the line carries one', () => {
    const withNumber = parseActivity(
      line('{"ts":1756300000000,"type":"result","subtype":"success","result":"ok"}'),
    )
    const withIso = parseActivity(
      line('{"timestamp":"2026-08-28T12:00:00.000Z","type":"result","subtype":"success","result":"ok"}'),
    )

    expect(withNumber[0]?.ts).toBe(1756300000000)
    expect(withIso[0]?.ts).toBe(Date.parse('2026-08-28T12:00:00.000Z'))
  })

  test('caps the feed at max, keeping the newest events', () => {
    const log = Array.from({ length: 8 }, (_unused, index) =>
      line(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"f${index}"}}]}}`),
    ).join('')

    const capped = parseActivity(log, 3)
    expect(capped.map((event) => event.detail)).toEqual(['f5', 'f6', 'f7'])
    expect(parseActivity(log).length).toBe(8)
  })
})

describe('toolDetail', () => {
  test('picks the first useful string for an unmapped tool', () => {
    expect(toolDetail('SomeNewTool', { url: 'https://example.test/page' })).toBe('https://example.test/page')
    expect(toolDetail('SomeNewTool', { weird: 'value' })).toBe('value')
    expect(toolDetail('SomeNewTool', { todos: [] })).toBe('')
    expect(toolDetail('Edit', null)).toBe('')
  })
})

describe('currentActivity', () => {
  test('returns the last meaningful event as one line', async () => {
    const events = await fixtureEvents()
    expect(currentActivity(events)).toBe('RESULT · Updated the flow derivation and added tests.')
  })

  test('renders a tool event as title · detail and text as the text itself', () => {
    expect(formatActivity({ kind: 'tool', title: 'Edit', detail: 'server/flow.ts' })).toBe('Edit · server/flow.ts')
    expect(formatActivity({ kind: 'text', title: 'TEXT', detail: 'thinking' })).toBe('thinking')
    expect(formatActivity({ kind: 'tool', title: 'TodoWrite', detail: '' })).toBe('TodoWrite')
  })

  test('skips trailing events with nothing to show and returns null for an empty feed', () => {
    expect(currentActivity([])).toBeNull()
    expect(
      currentActivity([
        { kind: 'tool', title: 'Edit', detail: 'a.ts' },
        { kind: 'text', title: '', detail: '' },
      ]),
    ).toBe('Edit · a.ts')
  })
})

describe('createActivityThrottle', () => {
  test('allows the first call and then only once per interval', () => {
    let clock = 1_000
    const throttle = createActivityThrottle(2_000, () => clock)

    expect(throttle.ready()).toBe(true)
    expect(throttle.ready()).toBe(false)

    clock += 1_999
    expect(throttle.ready()).toBe(false)

    clock += 1
    expect(throttle.ready()).toBe(true)
    expect(throttle.ready()).toBe(false)

    clock += 10_000
    expect(throttle.ready()).toBe(true)
  })

  test('remainingMs is zero before the first call, since a first call always passes', () => {
    const throttle = createActivityThrottle(2_000, () => 1_000)
    expect(throttle.remainingMs()).toBe(0)
  })

  test('remainingMs counts down to zero across the window, then resets on the next pass', () => {
    let clock = 1_000
    const throttle = createActivityThrottle(2_000, () => clock)

    expect(throttle.ready()).toBe(true)
    expect(throttle.remainingMs()).toBe(2_000)

    clock += 500
    expect(throttle.remainingMs()).toBe(1_500)

    clock += 1_500
    expect(throttle.remainingMs()).toBe(0)
    expect(throttle.ready()).toBe(true)
    expect(throttle.remainingMs()).toBe(2_000)
  })

  test('remainingMs never goes negative once the window has long passed', () => {
    let clock = 1_000
    const throttle = createActivityThrottle(2_000, () => clock)
    throttle.ready()
    clock += 100_000
    expect(throttle.remainingMs()).toBe(0)
  })
})
