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
  tokens: [{ nodeId: 'build', pathId: 'main', state: 'working', from: [2] }], sections: [], keptBranches: [],
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
  const paused: RunView = { ...base, status: 'paused', currentNodeId: 'build', attempts: base.attempts.slice(0, 1), tokens: [{ nodeId: 'build', pathId: 'main', state: 'ready', from: [0] }] }
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

test('meta keeps how the flow started and names the active and waiting versions', () => {
  const started = { ...base.versions[0]!, approvedVia: 'drawer' as const, at: 0 }
  const small = { ...started, number: 2, size: 'small' as const, approvedVia: 'auto' as const }
  const big = { ...started, number: 3, size: 'big' as const, state: 'pending' as const, approvedVia: null }
  expect(metaFor({ ...base, versions: [started, small] })).toMatch(/approved by you in the drawer, .+ · now on v2$/)
  expect(metaFor({ ...base, versions: [started, small, big] })).toMatch(/approved by you in the drawer, .+ · now on v2 · v3 waiting for your approval$/)
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
    removed: [], changed: [],
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

test('a proposed change draws new routes as proposed and keeps a dropped route it already took', () => {
  const edges = Object.fromEntries(edgesFor(proposing).map(edge => [`${edge.source}>${edge.target}`, edge]))
  expect(Object.keys(edges)).toEqual(['plan>build', 'build>test', 'test>build', 'test>fix', 'build>migrate', 'migrate>test', 'migrate>fix'])
  expect(edges['build>migrate']!.state).toBe('proposed')
  expect(edges['migrate>test']!.state).toBe('proposed')
  expect(edges['migrate>fix']!).toEqual(expect.objectContaining({ state: 'proposed', label: 'if DB migration fails' }))
  expect(edges['build>test']!.state).toBe('done')
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

test('a route the proposal drops turns idle only if the run never took it', () => {
  const dropping: RunView = { ...proposing, proposal: { ...proposing.proposal!, edges: proposing.proposal!.edges.filter(edge => !(edge.source === 'test' && edge.target === 'fix')) } }
  const edges = Object.fromEntries(edgesFor(dropping).map(edge => [`${edge.source}>${edge.target}`, edge]))
  expect(edges['test>fix']!.state).toBe('idle')
  expect(edges['test>build']!.state).toBe('failed')
  expect(edges['build>test']!.state).toBe('done')
})

test('a proposal strikes the steps it removes and marks the unstarted steps it edits', () => {
  const removing: RunView = { ...proposing, proposal: { ...proposing.proposal!, nodes: proposing.proposal!.nodes.filter(node => node.id !== 'fix'), removed: ['fix'], changed: [] } }
  const removed = stepsFor(removing, 308_000).find(step => step.id === 'fix')!
  expect([removed.state, removed.detail]).toEqual(['removed', 'Removed in v2'])
  expect(pillsFor(removing).waiting).toBe(0)
  const editing: RunView = { ...proposing, proposal: { ...proposing.proposal!, changed: ['fix', 'test'] } }
  const steps = Object.fromEntries(stepsFor(editing, 308_000).map(step => [step.id, step]))
  expect([steps.fix!.state, steps.fix!.detail]).toEqual(['conditional', 'Changed in v2'])
  expect([steps.test!.state, steps.test!.detail]).toEqual(['failed', 'Failed · Tests failed in export_spec'])
})

const forked: RunView = {
  ...base, entry: 'plan', currentNodeId: 'a',
  nodes: [{ id: 'plan', title: 'Plan', kind: 'plan', engine: 'claude' }, { id: 'verify', title: 'Check plan', kind: 'verify-plan', engine: 'codex' }, { id: 'split', title: 'Split', kind: 'task', engine: 'claude' }, { id: 'a', title: 'Build API', kind: 'task', engine: 'claude' }, { id: 'b', title: 'Build UI', kind: 'task', engine: 'glm' }, { id: 'join', title: 'Join', kind: 'join', engine: '' }, { id: 'review', title: 'Review', kind: 'review', engine: 'codex' }],
  edges: [{ source: 'plan', target: 'verify', outcome: 'pass' }, { source: 'verify', target: 'split', outcome: 'pass' }, { source: 'split', target: 'a', outcome: 'pass' }, { source: 'split', target: 'b', outcome: 'pass' }, { source: 'a', target: 'join', outcome: 'pass' }, { source: 'b', target: 'join', outcome: 'pass' }, { source: 'join', target: 'review', outcome: 'pass' }],
  attempts: [
    { nodeId: 'plan', number: 1, jobId: 'p', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 0, endedAt: 10, pathId: 'main', from: [] },
    { nodeId: 'verify', number: 2, jobId: 'v', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 10, endedAt: 20, pathId: 'main', from: [1] },
    { nodeId: 'split', number: 3, jobId: 's', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 20, endedAt: 30, pathId: 'main', from: [2] },
    { nodeId: 'b', number: 4, jobId: 'b', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 30, endedAt: 40, pathId: 'a3-2', from: [3] },
    { nodeId: 'a', number: 5, jobId: 'a', status: 'running', outcome: null, summary: null, startedAt: 30, endedAt: null, pathId: 'a3-1', from: [3] },
  ],
  tokens: [{ nodeId: 'a', pathId: 'a3-1', state: 'working', from: [3] }, { nodeId: 'join', pathId: 'a3-2', state: 'waiting', from: [4] }],
  sections: [{ fork: 'split', join: 'join', paths: [{ pathId: 'a3-1', branch: 'flow-r-a3-1', firstNodeId: 'a' }, { pathId: 'a3-2', branch: 'flow-r-a3-2', firstNodeId: 'b' }], joined: [] }],
}

test('a run mid-fork shows the working path, the join waiting for the other path and the step after it', () => {
  const steps = Object.fromEntries(stepsFor(forked, 50).map(step => [step.id, step]))
  expect(steps.a!.state).toBe('active')
  expect([steps.b!.state, steps.join!.state, steps.join!.detail, steps.join!.engine]).toEqual(['done', 'pending', 'Waiting for 1 of 2 paths', ''])
  expect([steps.review!.state, steps.review!.detail]).toEqual(['pending', 'Waiting'])
})

test('a run mid-fork marks each path hand-off by where its attempt came from', () => {
  const edges = Object.fromEntries(edgesFor(forked).map(edge => [`${edge.source}>${edge.target}`, edge.state]))
  expect(edges).toEqual(expect.objectContaining({ 'split>a': 'flowing', 'split>b': 'done', 'b>join': 'done', 'a>join': 'idle', 'join>review': 'idle' }))
})

test('a join says how many paths it joined, or that they could not be joined', () => {
  const joinAttempt = (outcome: 'pass' | 'fail', summary: string) => ({ nodeId: 'join', number: 6, jobId: null, status: 'settled', outcome, summary, startedAt: 40, endedAt: 41, pathId: 'main', from: [4, 5] })
  const settledA = { ...forked.attempts[4]!, status: 'settled', outcome: 'pass' as const, endedAt: 40 }
  const joined: RunView = { ...forked, attempts: [...forked.attempts.slice(0, 4), settledA, joinAttempt('pass', 'Joined 2 paths')], tokens: [{ nodeId: 'review', pathId: 'main', state: 'ready', from: [6] }], sections: [] }
  const step = (run: RunView) => stepsFor(run, 50).find(item => item.id === 'join')!
  expect([step(joined).state, step(joined).detail]).toEqual(['done', 'Joined 2 paths'])
  expect(stepsFor(joined, 50).find(item => item.id === 'review')!.detail).toBe('Up next')
  expect(edgesFor(joined).find(edge => edge.source === 'a' && edge.target === 'join')!.state).toBe('done')
  const conflict: RunView = { ...joined, attempts: [...joined.attempts.slice(0, 5), joinAttempt('fail', 'Paths could not be joined: same.txt')] }
  expect([step(conflict).state, step(conflict).detail]).toEqual(['failed', 'Paths could not be joined'])
})

test('every working path counts as running and the steps after them are up next', () => {
  const both: RunView = { ...forked, attempts: [...forked.attempts.slice(0, 3), { ...forked.attempts[3]!, status: 'running', outcome: null, summary: null, endedAt: null }, forked.attempts[4]!], tokens: [{ nodeId: 'a', pathId: 'a3-1', state: 'working', from: [3] }, { nodeId: 'b', pathId: 'a3-2', state: 'working', from: [3] }] }
  const steps = Object.fromEntries(stepsFor(both, 50).map(step => [step.id, step]))
  expect([steps.a!.state, steps.b!.state]).toEqual(['active', 'active'])
  expect(steps.join!.detail).toBe('Waiting for 2 of 2 paths')
  expect(pillsFor(both).running).toBe(2)
})
