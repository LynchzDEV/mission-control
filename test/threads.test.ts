import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  TEXT_PREVIEW_CHARS,
  parseActivity,
  parseSessionId,
  parseThread,
  type ActivityEvent,
} from '../server/activity'
import type { JobRecord } from '../server/jobs'
import { engineArgs, engineSupportsResume } from '../server/jobs-engine-iface'
import {
  assembleThread,
  eventToMessage,
  jobMessages,
  replySessionId,
  threadChain,
  threadIsRunning,
  threadRootOf,
} from '../server/threads'

const CLAUDE_THREAD = join(import.meta.dir, 'fixtures', 'activity', 'claude-thread.jsonl')
const CODEX_THREAD = join(import.meta.dir, 'fixtures', 'activity', 'codex-thread.jsonl')
const CLAUDE_STREAM = join(import.meta.dir, 'fixtures', 'activity', 'claude-stream.jsonl')

const SESSION = 'ffef321c-34a3-4c15-a97a-84c221b610ff'

function read(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-root',
    engine: 'claude',
    cwd: '/Users/x/code/repo',
    label: 'thread-work',
    prompt: 'say alpha',
    pid: 1234,
    status: 'done',
    startedAt: 1_000,
    endedAt: 2_000,
    exitCode: 0,
    diffStat: null,
    reviewedAt: null,
    sessionId: SESSION,
    parentJobId: null,
    threadRoot: 'job-root',
    ...overrides,
  }
}

describe('parseSessionId', () => {
  test('reads the claude session id, which is present from the very first line', async () => {
    const log = await read(CLAUDE_THREAD)
    const firstLineOnly = log.split('\n')[0] as string

    expect(parseSessionId(log)).toBe(SESSION)
    expect(parseSessionId(firstLineOnly)).toBe(SESSION)
  })

  test('reads the id from an init event and from a result event on their own', () => {
    const init = `{"type":"system","subtype":"init","session_id":"${SESSION}"}`
    const result = `{"type":"result","subtype":"success","result":"alpha","session_id":"${SESSION}"}`

    expect(parseSessionId(init)).toBe(SESSION)
    expect(parseSessionId(result)).toBe(SESSION)
  })

  test("reads codex's thread_id off its opening thread.started event", async () => {
    expect(parseSessionId(await read(CODEX_THREAD))).toBe('01a04b70-93e7-7b21-ac23-4b270688e0f0')
  })

  test('keeps the last id seen, so a mid-run fork resumes the newest session', () => {
    const log = [
      '{"type":"system","subtype":"init","session_id":"first"}',
      '{"type":"result","subtype":"success","session_id":"second"}',
    ].join('\n')

    expect(parseSessionId(log)).toBe('second')
  })

  test('returns null for a log with no id, garbage lines, and broken json', () => {
    expect(parseSessionId('')).toBeNull()
    expect(parseSessionId('not json at all\n{"broken":"json"\n{"type":"turn.started"}')).toBeNull()
  })
})

describe('parseThread vs parseActivity', () => {
  test('thread mode keeps assistant text whole with its newlines; ticker mode truncates to one line', async () => {
    const log = await read(CLAUDE_THREAD)
    const full = parseThread(log).find((event) => event.kind === 'text') as ActivityEvent
    const ticker = parseActivity(log).find((event) => event.kind === 'text') as ActivityEvent

    expect(full.detail).toContain('\n')
    expect(full.detail).toContain('wired end to end')
    expect(ticker.detail).not.toContain('\n')
    expect(ticker.detail.length).toBe(TEXT_PREVIEW_CHARS + 1)
    expect(ticker.detail.endsWith('…')).toBe(true)
  })

  test('thread mode keeps the final result whole; ticker mode caps it', async () => {
    const log = await read(CLAUDE_THREAD)
    const full = parseThread(log).find((event) => event.kind === 'result') as ActivityEvent
    const ticker = parseActivity(log).find((event) => event.kind === 'result') as ActivityEvent

    expect(full.detail).toBe('17×23 = **391**.\nCommand ran, output `done`.')
    expect(ticker.detail).toBe('17×23 = **391**. Command ran, output `done`.')
  })

  test('ticker mode carries no thread-only fields, so the feed shape is unchanged', async () => {
    const events = parseActivity(await read(CLAUDE_THREAD))
    for (const event of events) {
      expect(event.input).toBeUndefined()
      expect(event.result).toBeUndefined()
      expect(event.toolUseId).toBeUndefined()
    }
  })
})

describe('thinking blocks', () => {
  test('renders a thinking block with text, in stream position', async () => {
    const events = parseThread(await read(CLAUDE_THREAD))
    const kinds = events.map((event) => event.kind)

    expect(kinds).toEqual(['thinking', 'text', 'tool', 'tool', 'text', 'result'])
    expect(events[0]?.detail).toContain('17*20 = 340')
  })

  // The installed claude emits thinking blocks whose text is empty (signature only) — an empty
  // block must render nothing rather than an empty row. See docs/decisions/threads.md.
  test('skips a signature-only thinking block with no text', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"sig"}]}}'

    expect(parseThread(line)).toEqual([])
  })
})

describe('tool rows in thread mode', () => {
  test('carries the pretty-printed input and the tool_result that follows it', async () => {
    const events = parseThread(await read(CLAUDE_THREAD))
    const bash = events.find((event) => event.title === 'Bash') as ActivityEvent

    expect(bash.detail).toBe('Echo done')
    expect(bash.toolUseId).toBe('toolu_01QXsY4FRUv52EJDVpXBKgyE')
    expect(bash.input).toBe('{\n  "command": "echo done",\n  "description": "Echo done"\n}')
    expect(bash.result).toContain('line one')
    expect(bash.result).toContain('line seven')
    expect(bash.resultIsError).toBe(false)
  })

  test('leaves a tool with no matching result unresolved, which is how a live call renders', async () => {
    const events = parseThread(await read(CLAUDE_THREAD))
    const read2 = events.find((event) => event.title === 'Read') as ActivityEvent

    expect(read2.toolUseId).toBe('toolu_02')
    expect(read2.result).toBeUndefined()
  })

  test('marks a failed tool_result as an error', () => {
    const log = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"false"}}]}}',
      '{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"exit 1","is_error":true}]}}',
    ].join('\n')

    const tool = parseThread(log)[0] as ActivityEvent
    expect(tool.result).toBe('exit 1')
    expect(tool.resultIsError).toBe(true)
  })

  test('flattens a block-array tool_result into text', () => {
    const log = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/a"}}]}}',
      '{"type":"user","message":{"content":[{"tool_use_id":"t2","type":"tool_result","content":[{"type":"text","text":"first"},{"type":"text","text":"second"}]}]}}',
    ].join('\n')

    expect((parseThread(log)[0] as ActivityEvent).result).toBe('first\nsecond')
  })
})

describe('codex stream shapes', () => {
  test('parses the item.completed envelope the installed codex actually emits', async () => {
    const events = parseThread(await read(CODEX_THREAD))

    expect(events.map((event) => `${event.kind}:${event.detail}`)).toEqual([
      'error:Skill descriptions were shortened to fit the skills context budget.',
      'text:bravo',
    ])
  })

  test('still parses the legacy msg envelope', async () => {
    const events = parseActivity(await read(CLAUDE_STREAM))
    expect(events.some((event) => event.detail.startsWith('codex-style line'))).toBe(true)
  })
})

describe('threadChain', () => {
  const root = job({ id: 'a', startedAt: 100, threadRoot: 'a', prompt: 'first' })
  const second = job({ id: 'b', startedAt: 200, threadRoot: 'a', parentJobId: 'a', prompt: 'second' })
  const third = job({ id: 'c', startedAt: 300, threadRoot: 'a', parentJobId: 'b', prompt: 'third' })
  const other = job({ id: 'z', startedAt: 150, threadRoot: 'z', prompt: 'unrelated' })

  test('collects the whole chain in startedAt order, ignoring other threads', () => {
    const chain = threadChain([third, other, root, second], 'a')
    expect(chain.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  test('a reply whose parent record is missing still renders in the chain', () => {
    const chain = threadChain([root, third], 'a')
    expect(chain.map((entry) => entry.id)).toEqual(['a', 'c'])
  })

  test('treats a record with a blank threadRoot as its own root', () => {
    expect(threadRootOf(job({ id: 'legacy', threadRoot: '' }))).toBe('legacy')
  })

  test('reports the thread as running while any job in it runs', () => {
    expect(threadIsRunning([root, second])).toBe(false)
    expect(threadIsRunning([root, job({ id: 'd', status: 'running' })])).toBe(true)
  })

  test('resolves the reply session id from the newest job that has one', () => {
    expect(replySessionId([job({ sessionId: 'old' }), job({ id: 'b', sessionId: 'new' })])).toBe('new')
    expect(replySessionId([job({ sessionId: 'old' }), job({ id: 'b', sessionId: null })])).toBe('old')
    expect(replySessionId([job({ sessionId: null })])).toBeNull()
  })
})

describe('assembleThread', () => {
  test('emits each turn as prompt then that job log in stream order', async () => {
    const log = await read(CLAUDE_THREAD)
    const chain = [
      job({ id: 'a', startedAt: 100, prompt: 'say alpha' }),
      job({ id: 'b', startedAt: 200, parentJobId: 'a', prompt: 'what word did you say?' }),
    ]

    const messages = await assembleThread(chain, async () => log)
    const shape = messages.map((message) => `${message.jobId}:${message.role}/${message.kind}`)

    expect(shape).toEqual([
      'a:user/prompt',
      'a:assistant/thinking',
      'a:assistant/text',
      'a:assistant/tool',
      'a:assistant/tool',
      'a:assistant/text',
      'a:result/result',
      'b:user/prompt',
      'b:assistant/thinking',
      'b:assistant/text',
      'b:assistant/tool',
      'b:assistant/tool',
      'b:assistant/text',
      'b:result/result',
    ])
    expect(messages[0]).toEqual({
      role: 'user',
      kind: 'prompt',
      jobId: 'a',
      ts: 100,
      text: 'say alpha',
    })
    expect(messages[7]?.text).toBe('what word did you say?')
  })

  test('a job with an empty log contributes only its user turn', async () => {
    const messages = await assembleThread([job({ id: 'a', prompt: 'hi' })], async () => '')
    expect(messages).toEqual([{ role: 'user', kind: 'prompt', jobId: 'a', ts: 1_000, text: 'hi' }])
  })

  test('a tool message carries its input and result through to the client', async () => {
    const messages = jobMessages(job({ id: 'a' }), await read(CLAUDE_THREAD))
    const tool = messages.find((message) => message.kind === 'tool')

    expect(tool).toMatchObject({
      role: 'assistant',
      kind: 'tool',
      title: 'Bash',
      detail: 'Echo done',
      resultIsError: false,
    })
  })

  test('maps an error event to a failed result message', () => {
    const message = eventToMessage({ kind: 'error', title: 'ERROR', detail: 'boom' }, 'a')
    expect(message).toEqual({ role: 'result', kind: 'result', jobId: 'a', text: 'boom', isError: true })
  })
})

describe('engineArgs', () => {
  test('claude and glm take --resume ahead of -p, leaving the stream flags intact', () => {
    expect(engineArgs('claude', 'hello')).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
    expect(engineArgs('glm', 'hello', 'sess-1')).toEqual([
      '--resume',
      'sess-1',
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
  })

  test('codex uses its resume subcommand with the flag before the positionals', () => {
    expect(engineArgs('codex', 'hello')).toEqual(['exec', '--json', 'hello'])
    expect(engineArgs('codex', 'hello', 'thread-1')).toEqual([
      'exec',
      'resume',
      '--json',
      'thread-1',
      'hello',
    ])
  })

  test('every known engine resumes; an unknown one does not', () => {
    expect(engineSupportsResume('claude')).toBe(true)
    expect(engineSupportsResume('glm')).toBe(true)
    expect(engineSupportsResume('codex')).toBe(true)
    expect(engineSupportsResume('mystery')).toBe(false)
  })
})
