import { expect, test } from 'bun:test'
import { bannerFor, edgesFor, elapsed, metaFor, pickRun, pillsFor, stepsFor } from '../client/flow-drawer'
import type { RunView } from '../server/run-view'

const base: RunView = {
  id: 'r', label: 'Add export', status: 'running', error: null, workflowName: 'Feature build', revision: 'v', entry: 'plan', currentNodeId: 'build',
  origin: { source: 'saved', by: 'codex', where: 'terminal' },
  versions: [{ number: 1, revision: 'v', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'drawer', relayedBy: null, at: Date.UTC(2026, 8, 28, 22, 41) }],
  nodes: [{ id: 'plan', title: 'Plan', kind: 'plan', engine: 'claude' }, { id: 'build', title: 'Build API', kind: 'implement', engine: 'codex' }, { id: 'test', title: 'API tests', kind: 'task', engine: 'glm' }, { id: 'fix', title: 'Fix notes', kind: 'implement', engine: 'claude' }],
  edges: [{ source: 'plan', target: 'build', outcome: 'pass' }, { source: 'build', target: 'test', outcome: 'pass' }, { source: 'test', target: 'build', outcome: 'fail' }, { source: 'test', target: 'fix', outcome: 'blocked' }],
  attempts: [
    { nodeId: 'plan', number: 0, jobId: 'a', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 0, endedAt: 130_000 },
    { nodeId: 'build', number: 1, jobId: 'b', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 130_000, endedAt: 200_000 },
    { nodeId: 'test', number: 2, jobId: 'c', status: 'settled', outcome: 'fail', summary: 'Tests failed in export_spec', startedAt: 200_000, endedAt: 260_000 },
    { nodeId: 'build', number: 3, jobId: 'd', status: 'running', outcome: null, summary: null, startedAt: 260_000, endedAt: null },
  ],
  createdAt: 0, updatedAt: 260_000, proposal: null, latestChange: null,
}

test('elapsed reads like a person would say it', () => {
  expect(elapsed(48_000)).toBe('48s')
  expect(elapsed(220_000)).toBe('3m 40s')
  expect(elapsed(3_720_000)).toBe('1h 02m')
})

test('steps show done, a second try in progress, a failed test and a conditional fix', () => {
  const steps = Object.fromEntries(stepsFor(base, 308_000).map(step => [step.id, step]))
  expect([steps.plan!.state, steps.plan!.detail]).toEqual(['done', 'Done · 2m 10s'])
  expect([steps.build!.state, steps.build!.detail, steps.build!.since]).toEqual(['active', 'Try 2 · 48s', 260_000])
  expect([steps.test!.state, steps.test!.detail]).toEqual(['failed', 'Failed · Tests failed in export_spec'])
  expect([steps.fix!.state, steps.fix!.detail]).toEqual(['conditional', 'If API tests fails'])
})

test('a run paused between steps names the step that starts on resume', () => {
  const paused: RunView = { ...base, status: 'paused', currentNodeId: 'build', attempts: base.attempts.slice(0, 1) }
  const steps = Object.fromEntries(stepsFor(paused, 0).map(step => [step.id, step]))
  expect([steps.build!.state, steps.build!.detail]).toEqual(['pending', 'Paused here'])
  expect(steps.test!.detail).toBe('Waiting')
  const between: RunView = { ...paused, status: 'running' }
  expect(stepsFor(between, 0).find(step => step.id === 'build')!.detail).toBe('Up next')
})

test('edges mark the taken retry loop and the running hand-off', () => {
  const edges = Object.fromEntries(edgesFor(base).map(edge => [`${edge.source}>${edge.target}`, edge]))
  expect(edges['plan>build']!.state).toBe('done')
  expect(edges['test>build']!).toEqual(expect.objectContaining({ state: 'failed', label: 'API tests failed · retried' }))
  expect(edges['build>test']!.state).toBe('done')
  expect(edges['test>fix']!).toEqual(expect.objectContaining({ state: 'idle', label: 'if API tests fails' }))
})

test('a flow waiting for approval asks, names the AI and greys every step', () => {
  const waiting: RunView = { ...base, status: 'awaiting-approval', attempts: [], versions: [{ ...base.versions[0]!, state: 'pending', approvedVia: null }] }
  expect(bannerFor(waiting)).toEqual({ tone: 'ask', text: 'Codex picked "Feature build" for this task. Nothing runs until you approve, or say "go" to Codex.', actions: ['reject', 'approve'] })
  expect(metaFor(waiting)).toBe('Saved workflow Feature build · picked by Codex in terminal · waiting for your approval')
  expect(stepsFor(waiting, 0).map(step => [step.state, step.detail])).toEqual([['pending', 'Claude'], ['pending', 'Codex'], ['pending', 'GLM'], ['conditional', 'If API tests fails']])
})

test('meta says how the flow was approved', () => {
  expect(metaFor({ ...base, versions: [{ ...base.versions[0]!, approvedVia: 'conversation', relayedBy: 'codex' }] })).toContain('approved in the conversation (relayed by Codex)')
  expect(metaFor({ ...base, versions: [{ ...base.versions[0]!, approvedVia: 'auto' }] })).toContain('started on its own (approval is off)')
  expect(metaFor({ ...base, status: 'stopped', versions: [{ ...base.versions[0]!, state: 'rejected', approvedVia: null }] })).toMatch(/^Saved workflow Feature build · picked by Codex in terminal · rejected, \d{1,2}:\d{2}\s?(AM|PM)$/)
  expect(metaFor({ ...base, origin: { ...base.origin, where: 'studio' }, versions: [{ ...base.versions[0]!, approvedVia: 'user' }] })).toBe('Saved workflow Feature build · started from Studio · started by you')
})

test('a blocked run offers a retry with the reason', () => {
  expect(bannerFor({ ...base, status: 'blocked', error: 'Engine out of quota' })).toEqual({ tone: 'problem', text: 'Blocked: Engine out of quota', actions: ['retry'] })
  expect(bannerFor(base)).toEqual({ tone: null, text: '', actions: [] })
})

test('pills count running, done and waiting steps', () => {
  expect(pillsFor(base)).toEqual({ running: 1, done: 1, waiting: 1 })
})

test('pickRun keeps a run the user picked, else follows the newest live run, else the newest', () => {
  const done = { ...base, id: 'done', status: 'done', createdAt: 5 }
  const blocked = { ...base, id: 'blocked', status: 'blocked', createdAt: 1 }
  const live = { ...base, id: 'live', createdAt: 3 }
  const newerLive = { ...base, id: 'newer', status: 'awaiting-approval', createdAt: 4 }
  expect(pickRun([done, live], 'done')!.id).toBe('done')
  expect(pickRun([done, live], 'gone')!.id).toBe('live')
  expect(pickRun([blocked, live], null)!.id).toBe('live')
  expect(pickRun([live, newerLive], null)!.id).toBe('newer')
  expect(pickRun([blocked, done], null)!.id).toBe('done')
  expect(pickRun([], null)).toBeNull()
})

const change = { number: 2, revision: 'v2', reason: 'The export needs a new column.', size: 'big' as const, state: 'pending' as const, approvedVia: null, relayedBy: null, at: 0 }
const proposing: RunView = {
  ...base,
  versions: [base.versions[0]!, change],
  proposal: {
    number: 2, reason: 'The export needs a new column.',
    nodes: [...base.nodes, { id: 'migrate', title: 'DB migration', kind: 'implement', engine: 'claude' }],
    edges: [{ source: 'plan', target: 'build', outcome: 'pass' }, { source: 'build', target: 'migrate', outcome: 'pass' }, { source: 'migrate', target: 'test', outcome: 'pass' }, { source: 'test', target: 'build', outcome: 'fail' }, { source: 'test', target: 'fix', outcome: 'blocked' }, { source: 'migrate', target: 'fix', outcome: 'fail' }],
  },
  latestChange: { number: 2, reason: 'The export needs a new column.', size: 'big', approvedVia: null, state: 'pending' },
}

test('a proposed change adds ghost steps and keeps the real states of existing steps', () => {
  const steps = Object.fromEntries(stepsFor(proposing, 308_000).map(step => [step.id, step]))
  expect(Object.keys(steps)).toEqual(['plan', 'build', 'test', 'fix', 'migrate'])
  expect(steps.migrate).toEqual({ id: 'migrate', title: 'DB migration', engine: 'claude', kind: 'implement', state: 'proposed', detail: 'Proposed' })
  expect([steps.plan!.state, steps.build!.state, steps.test!.state]).toEqual(['done', 'active', 'failed'])
  expect(pillsFor(proposing)).toEqual({ running: 1, done: 1, waiting: 1 })
})

test('a proposed change draws new routes as proposed and routes it drops as idle', () => {
  const edges = Object.fromEntries(edgesFor(proposing).map(edge => [`${edge.source}>${edge.target}`, edge]))
  expect(Object.keys(edges)).toEqual(['plan>build', 'build>test', 'test>build', 'test>fix', 'build>migrate', 'migrate>test', 'migrate>fix'])
  expect(edges['build>migrate']!.state).toBe('proposed')
  expect(edges['migrate>test']!.state).toBe('proposed')
  expect(edges['migrate>fix']!).toEqual(expect.objectContaining({ state: 'proposed', label: 'if DB migration fails' }))
  expect(edges['build>test']!.state).toBe('idle')
  expect(edges['plan>build']!.state).toBe('done')
  expect(edges['test>build']!).toEqual(expect.objectContaining({ state: 'failed', label: 'API tests failed · retried' }))
})

test('a proposed change asks to keep the current version or approve the new one', () => {
  expect(bannerFor(proposing)).toEqual({ tone: 'ask', text: 'Codex wants to change the flow. The export needs a new column.', actions: ['keep', 'approve'] })
})

test('a big change applied because approval is off says so and offers to turn approval on', () => {
  const auto: RunView = { ...base, versions: [base.versions[0]!, { ...change, reason: 'Added a DB migration because the scope grew.', state: 'approved', approvedVia: 'auto' }], latestChange: { number: 2, reason: 'Added a DB migration because the scope grew.', size: 'big', approvedVia: 'auto', state: 'approved' } }
  expect(bannerFor(auto)).toEqual({ tone: 'notice', text: 'v2 applied automatically. Added a DB migration because the scope grew. Approval is off, so it did not wait.', actions: ['approval-on'] })
  expect(bannerFor({ ...auto, status: 'done' })).toEqual({ tone: null, text: '', actions: [] })
  expect(bannerFor({ ...auto, latestChange: { ...auto.latestChange!, size: 'small' } })).toEqual({ tone: null, text: '', actions: [] })
  expect(bannerFor({ ...auto, latestChange: { ...auto.latestChange!, approvedVia: 'drawer' } })).toEqual({ tone: null, text: '', actions: [] })
})

test('a drafted flow waiting for approval says the AI drafted it', () => {
  const drafted: RunView = { ...base, status: 'awaiting-approval', attempts: [], origin: { ...base.origin, source: 'drafted' }, versions: [{ ...base.versions[0]!, state: 'pending', approvedVia: null }] }
  expect(bannerFor(drafted)).toEqual({ tone: 'ask', text: 'Codex drafted a flow for this task. Nothing runs until you approve, or say "go" to Codex.', actions: ['reject', 'approve'] })
})
