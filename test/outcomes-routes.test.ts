import { describe, expect, test } from 'bun:test'

import { Elysia } from 'elysia'

import type { JobRecord } from '../server/jobs'
import { createSessionResolver, type OutcomeRun } from '../server/outcome-session'
import type { OutcomeLedger, OutcomePage } from '../server/outcomes'
import { MAX_OUTCOME_LIMIT, outcomeQuery, outcomesRoutes } from '../server/routes/outcomes'

const job = (fields: Partial<JobRecord> & Pick<JobRecord, 'id'>): JobRecord => ({ engine: 'claude', label: fields.id, status: 'running', threadRoot: fields.id, terminalId: null, exitCode: null, endedAt: null, diffStat: null, ...fields }) as JobRecord

function resolver(jobs: JobRecord[], runs: OutcomeRun[] = [], engine = 'claude') {
  return createSessionResolver({
    terminals: { get: (id) => (id === 't1' ? { engine } : undefined), transcriptPath: async (id) => (id === 't1' ? '/tmp/t1.jsonl' : null) },
    jobs: { listJobs: () => jobs, logPath: (id) => `/logs/${id}.log` },
    runs: { list: () => runs },
    reported: async () => null,
  })
}

describe('session resolver', () => {
  test('a terminal reads its transcript (with sub-agents), its jobs and its workflow checks', async () => {
    const jobs = [job({ id: 'j1', terminalId: 't1', status: 'done', exitCode: 0, endedAt: 7, engine: 'codex' }), job({ id: 'j2', workflowRunId: 'r1' }), job({ id: 'other', terminalId: 't9' })]
    const runs: OutcomeRun[] = [{ id: 'r1', label: 'build', terminalId: 't1', attempts: [{ number: 0, endedAt: 8, checks: [{ command: 'bun', args: ['test'], exitCode: 1, output: 'fail', timedOut: false }] }] }]
    const sources = await resolver(jobs, runs)('terminal:t1')
    expect(sources?.files.map((file) => [file.id, file.parser, file.actor.by, file.final ?? false, file.subagents ?? false])).toEqual([
      ['main', 'claude', 'main', false, true],
      ['job:j1', 'codex-exec', 'spawned', true, false],
      ['job:j2', 'claude', 'spawned', false, false],
    ])
    expect(sources?.records.map((item) => [item.key, item.ok])).toEqual([['job:j1', true], ['run:r1#0#0', false]])
  })

  test('a codex terminal reads its rollout and has no sub-agents', async () => {
    const sources = await resolver([], [], 'codex')('terminal:t1')
    expect(sources?.files.map((file) => [file.parser, file.subagents])).toEqual([['codex-rollout', false]])
  })

  test('a chat splits its own turns (main, no settle square) from the agents it dispatched', async () => {
    const jobs = [
      job({ id: 'root', purpose: 'chat', threadRoot: 'root', status: 'done', chatId: 'root' }),
      job({ id: 'turn2', purpose: 'chat', threadRoot: 'root', status: 'done' }),
      job({ id: 'agent', chatId: 'root', status: 'failed', exitCode: 1, endedAt: 3, label: 'export button' }),
    ]
    const sources = await resolver(jobs)('chat:root')
    expect(sources?.files.map((file) => [file.id, file.actor.by, file.actor.label])).toEqual([
      ['job:root', 'main', 'Main agent'],
      ['job:turn2', 'main', 'Main agent'],
      ['job:agent', 'spawned', 'Job · export button'],
    ])
    expect(sources?.records.map((item) => [item.key, item.result])).toEqual([['job:agent', 'Failed · exit 1']])
  })

  test('unknown terminals, non-chat roots and bad keys resolve to null', async () => {
    const resolve = resolver([job({ id: 'plain' })])
    expect(await resolve('terminal:nope')).toBeNull()
    expect(await resolve('chat:plain')).toBeNull()
    expect(await resolve('bogus:x')).toBeNull()
    expect(await resolve('terminal')).toBeNull()
  })
})

describe('outcomeQuery', () => {
  test('builds the session key and clamps the limit', () => {
    expect(outcomeQuery({ terminal: 'abc-1', after: '4' })).toEqual({ key: 'terminal:abc-1', after: 4, limit: 200 })
    expect(outcomeQuery({ chat: 'c1', limit: '9999' })).toEqual({ key: 'chat:c1', after: 0, limit: MAX_OUTCOME_LIMIT })
  })
  test('rejects both or neither session, odd ids and non-numeric cursors', () => {
    for (const query of [{}, { terminal: 'a', chat: 'b' }, { terminal: '../x' }, { chat: 'c', after: '-1' }, { chat: 'c', limit: '0' }, { chat: 'c', after: '1.5' }]) expect('error' in outcomeQuery(query)).toBe(true)
  })
})

describe('GET /api/outcomes', () => {
  const page: OutcomePage = { items: [], totals: { passed: 2, failed: 1 }, last: 3 }
  const calls: unknown[] = []
  const ledger: OutcomeLedger = { read: async (key, after, limit) => { calls.push([key, after, limit]); return key === 'terminal:t1' ? page : null }, prune: async () => 0 }
  const app = new Elysia().use(outcomesRoutes(ledger))
  const get = (query: string) => app.handle(new Request(`http://localhost/api/outcomes${query}`))

  test('returns the page for a known session with the parsed cursor', async () => {
    const response = await get('?terminal=t1&after=2&limit=10')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(page)
    expect(calls.at(-1)).toEqual(['terminal:t1', 2, 10])
  })
  test('404 for an unknown session, 400 for a bad query', async () => {
    expect((await get('?terminal=t9')).status).toBe(404)
    expect((await get('?after=1')).status).toBe(400)
  })
  test('refuses a foreign host, a cross-site read and a proxied localhost request', async () => {
    expect((await app.handle(new Request('http://rebind.example/api/outcomes?terminal=t1'))).status).toBe(403)
    expect((await app.handle(new Request('http://localhost/api/outcomes?terminal=t1', { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403)
    expect((await app.handle(new Request('http://localhost/api/outcomes?terminal=t1', { headers: { 'x-forwarded-for': '100.64.0.2' } }))).status).toBe(403)
  })
})
