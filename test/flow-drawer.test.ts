import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_FLOWS, bannerFor, collapseSections, drawerView, edgesFor, elapsed, metaFor, needsYou, pickRun, pillsFor, rowDetail, rowRuns, runMenu, stepsFor } from '../client/flow-drawer'
import { STEP_H, STEP_W, layoutRun, type GraphEdge, type GraphStep } from '../client/flow-graph'
import { forkSections, workflowSchema } from '../server/workflows'
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
  tokens: [{ nodeId: 'build', pathId: 'main', state: 'working', from: [2] }], sections: [], keptBranches: [], dismissed: false,
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

test('a working step counts its sub-agents, after the try number when it was retried', () => {
  const withAgents = (count: number, attempts = base.attempts): RunView => ({ ...base, attempts: attempts.map(attempt => attempt.status === 'running' ? { ...attempt, subAgents: count } : attempt) })
  const working = (run: RunView) => stepsFor(run, 308_000).find(step => step.id === 'build')!.detail
  const firstTry = base.attempts.slice(0, 1).concat({ ...base.attempts[3]!, number: 1 })
  expect(working(withAgents(3, firstTry))).toBe('3 sub-agents · 48s')
  expect(working(withAgents(1, firstTry))).toBe('1 sub-agent · 48s')
  expect(working(withAgents(3))).toBe('Try 2 · 3 sub-agents · 48s')
  expect(working(withAgents(0))).toBe('Try 2 · 48s')
})

test('a step carries the job of its latest attempt; a step that never ran has none', () => {
  const steps = Object.fromEntries(stepsFor(base, 308_000).map(step => [step.id, step]))
  expect([steps.plan!.jobId, steps.build!.jobId, steps.test!.jobId, steps.fix!.jobId]).toEqual(['a', 'd', 'c', undefined])
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

const inSession: RunView = {
  ...base, currentNodeId: 'plan',
  attempts: [{ nodeId: 'plan', number: 0, jobId: null, status: 'running', outcome: null, summary: null, startedAt: 0, endedAt: null, pathId: 'main', from: [], subAgents: 0, inSession: true }],
  tokens: [{ nodeId: 'plan', pathId: 'main', state: 'working', from: [] }],
}

test('a step waiting In Session names the AI doing it, ticks like a working step and keeps its engine', () => {
  const plan = stepsFor(inSession, 90_000).find(step => step.id === 'plan')!
  expect([plan.state, plan.detail, plan.engine, plan.since]).toEqual(['session', 'In Session · 1m 30s', 'claude', 0])
  expect(plan.jobId).toBeUndefined()
  expect(stepsFor({ ...inSession, attempts: [{ ...inSession.attempts[0]!, startedAt: 30_000 }] }, 42_000).find(step => step.id === 'plan')!.detail).toBe('In Session · 12s')
})

test('a step waiting In Session counts as running', () => {
  expect(pillsFor(inSession).running).toBe(1)
})

test('a step waiting In Session gets a notice banner that can remind the AI, unless a problem or an approval comes first', () => {
  expect(bannerFor(inSession)).toEqual({ tone: 'notice', text: 'Plan is being done In Session by Claude. Talk to it here; the flow continues when it reports the step.', actions: ['remind'] })
  expect(bannerFor({ ...inSession, status: 'paused' }).text).toBe('Plan is being done In Session by Claude. Talk to it here; the flow continues when it reports the step.')
  expect(bannerFor({ ...inSession, status: 'blocked', error: 'limit' }).tone).toBe('problem')
  expect(bannerFor({ ...inSession, status: 'stopped' })).toEqual({ tone: null, text: '', actions: [] })
  expect(bannerFor({ ...inSession, attempts: [{ ...inSession.attempts[0]!, status: 'settled', outcome: 'pass', endedAt: 1 }] })).toEqual({ tone: null, text: '', actions: [] })
})

test('pills count running, done and waiting steps', () => {
  expect(pillsFor(base)).toEqual({ running: 1, done: 1, waiting: 1 })
})

test('a finished flow counts no step as waiting', () => {
  const done: RunView = { ...base, status: 'done', attempts: base.attempts.map(attempt => ({ ...attempt, status: 'settled', outcome: 'pass', endedAt: attempt.startedAt + 1000 })) }
  expect(pillsFor(done).waiting).toBe(0)
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

test('a run needs you while it is blocked or failed and not dismissed', () => {
  expect(needsYou({ ...base, status: 'blocked' })).toBe(true)
  expect(needsYou({ ...base, status: 'failed' })).toBe(true)
  expect(needsYou({ ...base, status: 'failed', dismissed: true })).toBe(false)
  for (const status of ['running', 'paused', 'awaiting-approval', 'done', 'stopped']) expect(needsYou({ ...base, status })).toBe(false)
})

const flows = {
  old: { ...base, id: 'old', status: 'running', createdAt: 1 },
  fresh: { ...base, id: 'fresh', status: 'paused', createdAt: 9 },
  stuck: { ...base, id: 'stuck', status: 'blocked', error: 'Fix reached its visit limit', createdAt: 2 },
  broke: { ...base, id: 'broke', status: 'failed', createdAt: 5 },
  asking: { ...base, id: 'asking', status: 'awaiting-approval', createdAt: 7 },
  done: { ...base, id: 'done', status: 'done', createdAt: 8 },
  stopped: { ...base, id: 'stopped', status: 'stopped', createdAt: 6 },
  waved: { ...base, id: 'waved', status: 'failed', dismissed: true, createdAt: 10 },
} satisfies Record<string, RunView>
const runIds = (runs: RunView[]): string[] => runs.map(run => run.id)

test('rows hold live runs and runs that need you, those that need you first, newest first within each', () => {
  expect(runIds(rowRuns(Object.values(flows)))).toEqual(['broke', 'stuck', 'fresh', 'asking', 'old'])
  expect(rowRuns([flows.done, flows.waved, flows.stopped])).toEqual([])
})

test('All flows is the default once two runs are live or need you, and a picked run shows alone', () => {
  const two = [flows.old, flows.stuck, flows.done]
  expect(drawerView(two, null)).toEqual({ kind: 'all', runs: [flows.stuck, flows.old] })
  expect(drawerView(two, ALL_FLOWS)).toEqual({ kind: 'all', runs: [flows.stuck, flows.old] })
  expect(drawerView(two, 'done')).toEqual({ kind: 'one', run: flows.done })
  expect(drawerView(two, 'old')).toEqual({ kind: 'one', run: flows.old })
  expect(drawerView([flows.old, flows.done], null)).toEqual({ kind: 'one', run: flows.old })
  expect(drawerView([flows.old, flows.done], ALL_FLOWS)).toEqual({ kind: 'one', run: flows.old })
  expect(drawerView([flows.done, flows.waved], 'gone')).toEqual({ kind: 'one', run: flows.waved })
  expect(drawerView([], null)).toEqual({ kind: 'none' })
})

test('the menu offers All flows with the row count, then each row run, then the finished runs', () => {
  expect(runMenu(Object.values(flows))).toEqual({
    all: { value: ALL_FLOWS, label: 'All flows · 5 live' },
    live: ['broke', 'stuck', 'fresh', 'asking', 'old'].map(id => ({ value: id, label: `Add export · ${flows[id as keyof typeof flows].status}` })),
    finished: [{ value: 'waved', label: 'Add export · failed' }, { value: 'done', label: 'Add export · done' }, { value: 'stopped', label: 'Add export · stopped' }],
  })
  expect(runMenu([flows.old, flows.done])).toEqual({ all: null, live: [{ value: 'old', label: 'Add export · running' }], finished: [{ value: 'done', label: 'Add export · done' }] })
})

test('a row says what is stuck, what is working and for how long, or that the run waits', () => {
  expect(rowDetail({ ...flows.stuck }, 0)).toEqual({ text: 'Blocked: Fix reached its visit limit', problem: true })
  expect(rowDetail({ ...flows.broke, error: null }, 0)).toEqual({ text: 'Failed', problem: true })
  expect(rowDetail(base, 308_000)).toEqual({ text: 'Build API · 48s', problem: false, label: 'Build API', since: 260_000 })
  expect(rowDetail(flows.fresh, 308_000)).toEqual({ text: 'Paused', problem: false })
  expect(rowDetail(flows.asking, 308_000)).toEqual({ text: 'Waiting for approval', problem: false })
  const between: RunView = { ...base, attempts: base.attempts.slice(0, 3), currentNodeId: 'fix' }
  expect(rowDetail(between, 308_000)).toEqual({ text: 'Fix notes', problem: false })
  const parallel: RunView = { ...base, attempts: [...base.attempts, { ...base.attempts[3]!, nodeId: 'fix', number: 4, startedAt: 290_000 }] }
  expect(rowDetail(parallel, 308_000)).toEqual({ text: 'Build API + Fix notes · 48s', problem: false, label: 'Build API + Fix notes', since: 260_000 })
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
  sections: [{ fork: 'split', join: 'join', state: 'open', joined: [], paths: [{ nodes: ['a'], title: 'Build API', firstNodeId: 'a', pathId: 'a3-1', branch: 'flow-r-a3-1' }, { nodes: ['b'], title: 'Build UI', firstNodeId: 'b', pathId: 'a3-2', branch: 'flow-r-a3-2' }] }],
}

test('a run mid-fork shows the working path, the join waiting for the other path and the step after it', () => {
  const steps = Object.fromEntries(stepsFor(forked, 50).map(step => [step.id, step]))
  expect(steps.a!.state).toBe('active')
  expect([steps.b!.state, steps.join!.state, steps.join!.detail, steps.join!.engine]).toEqual(['done', 'pending', 'Waiting for 1 of 2', ''])
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
  expect(steps.join!.detail).toBe('Waiting for 2 of 2')
  expect(pillsFor(both).running).toBe(2)
})

const bigFlow = workflowSchema.parse(JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/big-flow.json'), 'utf8')))
const bigSteps: GraphStep[] = bigFlow.nodes.map(node => ({ id: node.id, title: node.title, detail: '', state: 'done', engine: node.kind === 'join' ? '' : 'claude', kind: node.kind }))
const bigEdges: GraphEdge[] = bigFlow.edges.map(edge => ({ ...edge, state: 'done' }))
const bigSections = (states: Record<string, RunView['sections'][number]['state']>): RunView['sections'] => forkSections(bigFlow).map(section => ({
  fork: section.fork, join: section.join, state: states[section.fork] ?? 'waiting', joined: [],
  paths: section.paths.map(nodes => ({ nodes, title: bigFlow.nodes.find(node => node.id === nodes[0])!.title, firstNodeId: nodes[0]!, pathId: null, branch: null })),
}))
const attempt = (nodeId: string, number: number, startedAt: number, endedAt: number, outcome: 'pass' | 'fail' = 'pass') => ({ nodeId, number, jobId: null, status: 'settled', outcome, summary: null, startedAt, endedAt, pathId: 'main', from: [] })
const bigAttempts = [attempt('split', 1, 0, 10_000), attempt('ui', 2, 12_000, 20_000), attempt('api', 3, 13_000, 30_000), attempt('join', 4, 190_000, 192_000)]
const ids = (steps: GraphStep[]) => steps.map(step => step.id)

test('a joined section collapses to one Parallel box that replaces its paths and join, with the edges rewired to it', () => {
  const composed = collapseSections(bigSteps, bigEdges, bigSections({ split: 'joined', 'ui-split': 'joined' }), new Set(), bigAttempts, 200_000)
  const box = composed.steps.find(step => step.id === 'section:split')!
  expect(box).toEqual({ id: 'section:split', title: 'Parallel · Api + Ui', detail: 'Done · 3m 00s', state: 'done', kind: 'join', engine: '' })
  for (const gone of ['api', 'api-tests', 'api-fix', 'ui', 'ui-split', 'ui-copy', 'ui-style', 'ui-join', 'ui-check', 'join', 'section:ui-split']) expect(ids(composed.steps)).not.toContain(gone)
  const touching = (id: string) => composed.edges.filter(edge => edge.source === id || edge.target === id).map(edge => `${edge.source}>${edge.target}:${edge.outcome}:${edge.state}`)
  expect(touching('section:split')).toEqual(['split>section:split:pass:done', 'section:split>review:pass:done', 'section:split>merge-fix:fail:done'])
  const kept = new Set(ids(composed.steps))
  expect(composed.edges.every(edge => kept.has(edge.source) && kept.has(edge.target))).toBe(true)
  expect(composed.bands.map(section => section.fork)).toEqual(['split2'])
})

test('with the outer section expanded, its joined inner section collapses to a box inside the outer path band', () => {
  const composed = collapseSections(bigSteps, bigEdges, bigSections({ split: 'joined', 'ui-split': 'joined' }), new Set(['split']), bigAttempts, 200_000)
  expect(composed.steps.find(step => step.id === 'section:ui-split')!.title).toBe('Parallel · Ui copy + Ui style')
  expect(ids(composed.steps)).not.toContain('ui-copy')
  expect(ids(composed.steps)).toContain('join')
  const outer = composed.bands.find(section => section.fork === 'split')!
  expect(outer.paths[1]!.nodes).toEqual(['ui', 'ui-split', 'section:ui-split', 'ui-check'])
  expect(composed.bands.map(section => section.fork)).toEqual(['split', 'split2'])
  const layout = layoutRun(composed.steps, composed.edges, bigFlow.entry, composed.bands)
  const band = layout.bands.find(item => item.key === 'split:1')!
  const box = layout.placed.find(place => place.id === 'section:ui-split')!
  expect(box.x >= band.x && box.y >= band.y && box.x + STEP_W <= band.x + band.width && box.y + STEP_H <= band.y + band.height).toBe(true)
})

test('an open section stays expanded even when an earlier pass through it was joined', () => {
  const composed = collapseSections(bigSteps, bigEdges, bigSections({ split: 'open', 'ui-split': 'joined' }), new Set(), bigAttempts, 200_000)
  expect(ids(composed.steps)).not.toContain('section:split')
  expect(ids(composed.steps)).toEqual(expect.arrayContaining(['api', 'ui', 'join', 'section:ui-split']))
  expect(composed.bands.map(section => section.fork)).toEqual(['split', 'split2'])
})

test('waiting and conflict sections are never collapsed', () => {
  const composed = collapseSections(bigSteps, bigEdges, bigSections({ split: 'conflict' }), new Set(), bigAttempts, 200_000)
  expect(composed.steps).toEqual(bigSteps)
  expect(composed.edges).toEqual(bigEdges)
  expect(composed.bands.map(section => section.fork)).toEqual(['split', 'split2', 'ui-split'])
})
