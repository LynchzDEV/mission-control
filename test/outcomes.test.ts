import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Actor, OutcomeDraft } from '../server/outcome-sources'
import { createOutcomeLedger, sessionFileStem, type SessionSources } from '../server/outcomes'

const line = (value: unknown) => `${JSON.stringify(value)}\n`
const MAIN: Actor = { by: 'main', label: 'Main agent', engine: 'claude' }
const bash = (id: string, command: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
const done = (id: string, content: string, isError = false, extra: Record<string, unknown> = {}) => line({ type: 'user', timestamp: '2026-09-28T10:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra })

let root: string
let transcript: string
let clock: number
let sources: SessionSources | null

const ledger = (overrides: Record<string, unknown> = {}) => createOutcomeLedger({ base: join(root, 'outcomes'), resolve: async () => sources, secrets: async () => ['sk-secret-token-123'], now: () => clock, throttleMs: 0, ...overrides })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mc-outcomes-'))
  transcript = join(root, 'session.jsonl')
  await writeFile(transcript, '')
  clock = 1_000
  sources = { files: [{ id: 'main', parser: 'claude', path: transcript, actor: MAIN, subagents: true }], records: [] }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('outcome ledger', () => {
  test('appends new outcomes with increasing seq and survives a reload', async () => {
    await appendFile(transcript, bash('a', 'bin/ci') + done('a', 'ok') + bash('b', 'git push') + done('b', 'Exit code 1\nrejected', true))
    const first = await ledger().read('terminal:t1', 0, 50)
    expect(first?.items.map((item) => [item.seq, item.ok, item.target])).toEqual([[1, true, 'bin/ci'], [2, false, 'git push']])
    expect(first?.totals).toEqual({ passed: 1, failed: 1 })
    await appendFile(transcript, bash('c', 'bin/ci') + done('c', 'ok'))
    const reloaded = await ledger().read('terminal:t1', 2, 50)
    expect(reloaded?.items.map((item) => [item.seq, item.target])).toEqual([[3, 'bin/ci']])
    expect(reloaded).toMatchObject({ last: 3, totals: { passed: 2, failed: 1 } })
  })

  test('a use and its result split across syncs, and a half-written line, still pair once', async () => {
    const store = ledger()
    const result = done('x', 'boom', true)
    await appendFile(transcript, bash('x', 'make') + result.slice(0, 20))
    expect((await store.read('terminal:t1', 0, 50))?.items).toEqual([])
    await appendFile(transcript, result.slice(20))
    expect((await store.read('terminal:t1', 0, 50))?.items.map((item) => [item.target, item.ok])).toEqual([['make', false]])
  })

  test('a crash after appending but before saving cursors does not duplicate on the next run', async () => {
    await appendFile(transcript, bash('a', 'bin/ci') + done('a', 'ok'))
    await ledger().read('terminal:t1', 0, 50)
    await rm(join(root, 'outcomes', `${sessionFileStem('terminal:t1')}.state.json`))
    const again = await ledger().read('terminal:t1', 0, 50)
    expect(again?.items.map((item) => item.seq)).toEqual([1])
    expect(again?.totals).toEqual({ passed: 1, failed: 0 })
  })

  test('a truncated source rescans from the start without duplicates', async () => {
    const store = ledger()
    await appendFile(transcript, bash('a', 'bin/ci') + done('a', 'ok') + bash('b', 'ls') + done('b', 'ok'))
    await store.read('terminal:t1', 0, 50)
    await writeFile(transcript, bash('c', 'pwd') + done('c', 'ok'))
    expect((await store.read('terminal:t1', 0, 50))?.items.map((item) => item.target)).toEqual(['bin/ci', 'ls', 'pwd'])
  })

  test('sub-agent transcripts are found and attributed to the agent the parent launched', async () => {
    await appendFile(transcript, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'review the bump' } }] } }) + done('ag', 'launched', false, { toolUseResult: { agentId: 'a1', status: 'async_launched' } }))
    await mkdir(join(root, 'session', 'subagents'), { recursive: true })
    await writeFile(join(root, 'session', 'subagents', 'agent-a1.jsonl'), bash('s1', 'bin/ci spec/x') + done('s1', 'Exit code 1\nfail', true))
    const page = await ledger().read('terminal:t1', 0, 50)
    expect(page?.items.map((item) => [item.actor.by, item.actor.label, item.target, item.ok])).toEqual([['spawned', 'Sub-agent · review the bump', 'bin/ci spec/x', false]])
  })

  test('record drafts (settled jobs, checks) are added once, and a closed final source is not re-read', async () => {
    const job: OutcomeDraft = { at: 5, ok: false, kind: 'job', tool: 'Job', target: 'export', result: 'Failed · exit 1', detail: '', actor: { by: 'spawned', label: 'Job · export', engine: 'codex' }, key: 'job:j1' }
    const log = join(root, 'job.log')
    await writeFile(log, line({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'make', exit_code: 0, status: 'completed' } }))
    sources = { files: [{ id: 'job:j1', parser: 'codex-exec', path: log, actor: job.actor, final: true }], records: [job] }
    const store = ledger()
    expect((await store.read('chat:c1', 0, 50))?.items.map((item) => item.key)).toEqual(['job:j1', 'job:j1:i1'])
    await appendFile(log, line({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'late', exit_code: 0, status: 'completed' } }))
    expect((await store.read('chat:c1', 0, 50))?.items).toHaveLength(2)
  })

  test('undated log lines take the log time, so a finished job lands after its own actions', async () => {
    const log = join(root, 'job.log')
    await writeFile(log, line({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'make', exit_code: 1, status: 'failed' } }))
    const written = new Date(1_000_000)
    await utimes(log, written, written)
    const actor: Actor = { by: 'spawned', label: 'Job · build', engine: 'codex' }
    const settled: OutcomeDraft = { at: 1_000_000, ok: true, kind: 'job', tool: 'Job', target: 'build', result: 'Done', detail: '', actor, key: 'job:j1' }
    sources = { files: [{ id: 'job:j1', parser: 'codex-exec', path: log, actor, final: true }], records: [settled] }
    clock = 5_000_000
    const page = await ledger().read('chat:c1', 0, 50)
    expect(page?.items.map((item) => [item.key, item.at])).toEqual([['job:j1:i1', 1_000_000], ['job:j1', 1_000_000]])
  })

  test('secrets in commands and details are redacted before they are stored', async () => {
    await appendFile(transcript, bash('a', 'curl -H "Authorization: sk-secret-token-123" x') + done('a', 'Exit code 1\ntoken sk-secret-token-123 rejected', true))
    const page = await ledger().read('terminal:t1', 0, 50)
    expect(page?.items[0]?.target).not.toContain('sk-secret-token-123')
    expect(page?.items[0]?.detail).not.toContain('sk-secret-token-123')
    const stored = await readFile(join(root, 'outcomes', `${sessionFileStem('terminal:t1')}.jsonl`), 'utf8')
    expect(stored).not.toContain('sk-secret-token-123')
  })

  test('first page returns the newest items; after pages come oldest first up to the limit', async () => {
    await appendFile(transcript, Array.from({ length: 6 }, (_, index) => bash(`c${index}`, `cmd ${index}`) + done(`c${index}`, 'ok')).join(''))
    const store = ledger()
    expect((await store.read('terminal:t1', 0, 2))?.items.map((item) => item.seq)).toEqual([5, 6])
    expect((await store.read('terminal:t1', 1, 2))?.items.map((item) => item.seq)).toEqual([2, 3])
  })

  test('an unknown session with no stored ledger is null; an ended one still serves its history', async () => {
    await appendFile(transcript, bash('a', 'ls') + done('a', 'ok'))
    await ledger().read('terminal:t1', 0, 50)
    sources = null
    expect(await ledger().read('terminal:nope', 0, 50)).toBeNull()
    expect((await ledger().read('terminal:t1', 0, 50))?.items).toHaveLength(1)
  })

  test('throttle skips re-reading within the window', async () => {
    const store = ledger({ throttleMs: 2_000 })
    await store.read('terminal:t1', 0, 50)
    await appendFile(transcript, bash('a', 'ls') + done('a', 'ok'))
    clock += 1_000
    expect((await store.read('terminal:t1', 0, 50))?.items).toHaveLength(0)
    clock += 1_500
    expect((await store.read('terminal:t1', 0, 50))?.items).toHaveLength(1)
  })

  test('prune removes ledgers untouched for longer than the window', async () => {
    await appendFile(transcript, bash('a', 'ls') + done('a', 'ok'))
    await ledger().read('terminal:old', 0, 50)
    const file = join(root, 'outcomes', `${sessionFileStem('terminal:old')}.jsonl`)
    const past = new Date(Date.now() - 40 * 86_400_000)
    await utimes(file, past, past)
    clock = Date.now()
    expect(await ledger().prune(30 * 86_400_000)).toBe(1)
    expect(await readFile(file, 'utf8').catch(() => null)).toBeNull()
  })
})
