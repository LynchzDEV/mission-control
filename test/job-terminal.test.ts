import { afterAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import type { ThreadMessage } from '../client/chat-view'

const { window } = new JSDOM('<body><div id="host"></div></body>', { url: 'http://127.0.0.1:7777/' })
const doc = window.document
const ESC = String.fromCharCode(27)
const plain = (text: string) => text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '')

class FakeSource {
  static all: FakeSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeSource.all.push(this) }
  close() { this.closed = true }
}

const threads = new Map<string, () => Response>()
const fetched: string[] = []
const realFetch = globalThis.fetch
Object.assign(globalThis, { window, document: doc, EventSource: FakeSource, HTMLElement: window.HTMLElement })
globalThis.fetch = (async (url: string) => { fetched.push(String(url)); return threads.get(String(url))?.() ?? Response.json({ error: 'job not found' }, { status: 404 }) }) as typeof fetch
afterAll(() => { globalThis.fetch = realFetch; window.close(); for (const key of ['window', 'document', 'EventSource', 'HTMLElement']) Reflect.deleteProperty(globalThis, key) })

const { createJobTerminal, jobTranscript } = await import('../client/job-terminal')

const flush = async (times = 4) => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const prompt = (jobId = 'j1'): ThreadMessage => ({ role: 'user', kind: 'prompt', jobId, ts: 1, text: 'line one\nline two\nline three' })
const text = (body: string, jobId = 'j1'): ThreadMessage => ({ role: 'assistant', kind: 'text', jobId, text: body })
const tool = (title: string, detail: string, input: unknown, result: string, resultIsError = false): ThreadMessage => ({ role: 'assistant', kind: 'tool', jobId: 'j1', title, detail, input: JSON.stringify(input), result, resultIsError, toolUseId: `${title}-${detail}` })

type Screen = { written: string; resets: number; disposed: boolean }
let screens: Screen[] = []
const makeScreen = () => {
  const screen: Screen = { written: '', resets: 0, disposed: false }
  screens.push(screen)
  return { write: (chunk: string) => { screen.written += chunk }, reset: () => { screen.resets += 1; screen.written = '' }, fit: () => {}, dispose: () => { screen.disposed = true } }
}
const host = () => doc.getElementById('host') as HTMLElement
const thread = (messages: ThreadMessage[], running: boolean) => () => Response.json({ rootId: 'j1', running, canReply: false, messages })

beforeEach(() => { screens = []; FakeSource.all = []; fetched.length = 0; threads.clear(); host().replaceChildren() })

test('the transcript reads like a terminal: agent text, each tool with what it touched, results folded to a few lines', () => {
  const output = plain(jobTranscript([
    prompt(),
    { role: 'assistant', kind: 'thinking', jobId: 'j1', text: 'private musing' },
    text('I will look at the queue first.'),
    tool('Read', '/repo/server/queue.ts', { file_path: '/repo/server/queue.ts' }, 'a\nb'),
    tool('Bash', 'Run the queue tests', { command: 'bun test test/queue-engine.test.ts', description: 'Run the queue tests' }, 'one\ntwo\nthree\nfour\nfive\nsix'),
    tool('Edit', '/repo/server/queue.ts', { file_path: '/repo/server/queue.ts', old_string: 'a', new_string: 'b' }, 'The file was updated'),
    { role: 'result', kind: 'result', jobId: 'j1', text: 'All done', isError: false },
  ]))
  expect(output).toContain('Instructions sent to the agent · 3 lines')
  expect(output).not.toContain('private musing')
  expect(output).toContain('I will look at the queue first.')
  expect(output).toContain('● Read /repo/server/queue.ts')
  expect(output).toContain('● Bash Run the queue tests')
  expect(output).toContain('$ bun test test/queue-engine.test.ts')
  expect(output).toContain('⎿  one')
  expect(output).toContain('three')
  expect(output).not.toContain('four')
  expect(output).toContain('… 3 more lines')
  expect(output).toContain('● Edit /repo/server/queue.ts')
  expect(output).toContain('Finished · All done')
  expect(output).not.toContain('\n\n\n')
  expect(output.split('\n').every(line => line === '' || line.endsWith('\r'))).toBe(true)
})

test('a failing tool and a failed job are shown in red', () => {
  const output = jobTranscript([prompt(), tool('Bash', 'npm test', { command: 'npm test' }, 'Exit code 1\nboom', true), { role: 'result', kind: 'result', jobId: 'j1', text: 'Agent crashed', isError: true }])
  expect(output).toContain(`${ESC}[31m`)
  expect(plain(output)).toContain('Stopped with an error · Agent crashed')
})

test('a tool still running says so instead of a result', () => {
  expect(plain(jobTranscript([prompt(), tool('Bash', 'sleep', { command: 'sleep 5' }, '')], true))).toContain('⎿  running…')
})

test('showing a finished job draws its transcript once and opens no live stream', async () => {
  threads.set('/api/jobs/j1/thread', thread([prompt(), text('Done here.')], false))
  const view = createJobTerminal(host(), makeScreen)
  view.show({ jobId: 'j1', title: 'Execute · attempt 1', engine: 'codex' })
  await flush()
  expect(plain(screens[0]!.written)).toContain('Done here.')
  expect(FakeSource.all).toEqual([])
  expect(host().querySelector('.term-bar-name')?.textContent).toBe('Execute · attempt 1')
  expect(host().querySelector('.term-bar-status')?.textContent).toBe('Finished')
  expect(host().querySelector('img')?.getAttribute('src')).toBe('/providers/codex.svg')
  expect(host().querySelector('textarea, input, form')).toBeNull()
})

test('a running job streams live: each log line refreshes the transcript and only the new part is written', async () => {
  let messages: ThreadMessage[] = [prompt(), text('Starting.')]
  let running = true
  threads.set('/api/jobs/j1/thread', () => thread(messages, running)())
  const view = createJobTerminal(host(), makeScreen)
  view.show({ jobId: 'j1', title: 'Plan', engine: 'claude' })
  await flush()
  expect(host().querySelector('.term-bar-status')?.textContent).toBe('Live')
  const stream = FakeSource.all[0]!
  expect(stream.url).toBe('/api/jobs/j1/stream')
  const before = screens[0]!.written
  messages = [...messages, tool('Read', '/repo/a.ts', { file_path: '/repo/a.ts' }, 'x')]
  stream.onmessage?.({ data: '{"type":"assistant"}' })
  stream.onmessage?.({ data: '{"type":"user"}' })
  await wait(400)
  await flush()
  expect(fetched.filter(url => url === '/api/jobs/j1/thread')).toHaveLength(2)
  expect(screens[0]!.written.startsWith(before)).toBe(true)
  expect(plain(screens[0]!.written)).toContain('● Read /repo/a.ts')
  expect(screens[0]!.resets).toBe(1)
  running = false
  messages = [...messages, { role: 'result', kind: 'result', jobId: 'j1', text: 'ok', isError: false }]
  stream.onerror?.()
  await flush()
  expect(stream.closed).toBe(true)
  expect(plain(screens[0]!.written)).toContain('Finished · ok')
  expect(host().querySelector('.term-bar-status')?.textContent).toBe('Finished')
})

test('switching to another step closes the old stream and starts a fresh screen', async () => {
  threads.set('/api/jobs/j1/thread', thread([prompt(), text('first job')], true))
  threads.set('/api/jobs/j2/thread', thread([prompt('j2'), text('second job', 'j2')], false))
  const view = createJobTerminal(host(), makeScreen)
  view.show({ jobId: 'j1', title: 'Plan', engine: 'claude' })
  await flush()
  view.show({ jobId: 'j2', title: 'Review', engine: 'codex' })
  await flush()
  expect(FakeSource.all[0]!.closed).toBe(true)
  expect(plain(screens[0]!.written)).toContain('second job')
  expect(plain(screens[0]!.written)).not.toContain('first job')
  view.show({ jobId: 'j2', title: 'Review', engine: 'codex' })
  await flush()
  expect(fetched.filter(url => url === '/api/jobs/j2/thread')).toHaveLength(1)
})

test('a step with no job yet, and a job that cannot be read, say so plainly', async () => {
  const view = createJobTerminal(host(), makeScreen)
  view.show({ jobId: null, title: 'Review', engine: 'codex' })
  await flush()
  expect(plain(screens[0]!.written)).toContain('This step has not started yet.')
  expect(host().querySelector('.term-bar-status')?.textContent).toBe('Waiting')
  view.show({ jobId: 'gone', title: 'Plan', engine: 'claude' })
  await flush()
  expect(plain(screens[0]!.written)).toContain('Could not load this step’s output: job not found')
  view.dispose()
  expect(screens[0]!.disposed).toBe(true)
})
