import { expect, test } from 'bun:test'
import { defaultWorkflow } from '../server/workflows'
import { runView, scopeSnapshot } from '../server/run-view'
import type { WorkflowRun } from '../server/workflow-runner'
import type { JobRecord } from '../server/jobs'

const workflow = { ...defaultWorkflow(), revision: 'r1', createdAt: 0 }
const run = (patch: Partial<WorkflowRun>): WorkflowRun => ({ id: 'run-1', label: 'Add export', cwd: '/x', request: 'secret request text', workflow, policy: { revision: 'p', template: 't', coreRules: 'c', implementationRules: 'i', createdAt: 0 }, agents: Object.fromEntries(workflow.nodes.map(node => [node.id, { engine: node.id === 'review' ? 'codex' : 'claude', model: null, family: null }])), skills: {}, status: 'running', error: null, currentNodeId: 'execute', attempts: [{ nodeId: 'plan', number: 0, jobId: 'j1', status: 'settled', prompt: 'long prompt', startedAt: 1, endedAt: 2, result: { outcome: 'pass', summary: 'Planned', evidence: ['e'] }, checks: [], output: 'long output', workspace: null }], createdAt: 0, updatedAt: 3, origin: { source: 'saved', by: 'codex', where: 'terminal' }, versions: [], terminalId: 't1', ...patch })
const job = (patch: Partial<JobRecord>) => ({ id: 'j', label: 'Fix badge', engine: 'codex', status: 'done', startedAt: 1, endedAt: 2, cwd: '/x', ...patch }) as JobRecord

test('run view keeps what the drawer draws and drops prompts, outputs and policy', () => {
  const view = runView(run({}))
  expect(view.nodes.map(node => [node.id, node.engine])).toEqual([['plan', 'claude'], ['verify-plan', 'claude'], ['execute', 'claude'], ['review', 'codex']])
  expect(view.attempts[0]).toEqual({ nodeId: 'plan', number: 0, jobId: 'j1', status: 'settled', outcome: 'pass', summary: 'Planned', startedAt: 1, endedAt: 2 })
  expect(JSON.stringify(view)).not.toContain('long prompt')
  expect(JSON.stringify(view)).not.toContain('long output')
  expect(JSON.stringify(view)).not.toContain('secret request text')
})

test('scope snapshot picks the terminal or chat runs, newest first, and flow-less jobs', () => {
  const snapshot = scopeSnapshot([run({ id: 'old', createdAt: 1 }), run({ id: 'new', createdAt: 5 }), run({ id: 'other', terminalId: 't2' })], [job({ id: 'quick', terminalId: 't1' }), job({ id: 'step', terminalId: 't1', workflowRunId: 'new' }), job({ id: 'elsewhere', terminalId: 't2' })], { terminal: 't1' })
  expect(snapshot.runs.map(view => view.id)).toEqual(['new', 'old'])
  expect(snapshot.jobs.map(view => view.id)).toEqual(['quick'])
})

test('chat scope matches runs by chat id and skips the chat turns themselves', () => {
  const snapshot = scopeSnapshot([run({ id: 'c', terminalId: undefined, chatId: 'chat-1' })], [job({ id: 'turn', chatId: 'chat-1', purpose: 'chat' }), job({ id: 'agent', chatId: 'chat-1' })], { chat: 'chat-1' })
  expect(snapshot.runs.map(view => view.id)).toEqual(['c'])
  expect(snapshot.jobs.map(view => view.id)).toEqual(['agent'])
})

test('an empty scope sees nothing', () => {
  expect(scopeSnapshot([run({})], [job({ terminalId: 't1' })], {})).toEqual({ runs: [], jobs: [] })
})

test('a pending change shows as a proposal with engines resolved, and versions travel without graphs', () => {
  const graph = { ...workflow, revision: 'r2', nodes: [...workflow.nodes, { id: 'check', title: 'API check', kind: 'task' as const, instructions: 'Run the API tests' }], edges: [...workflow.edges.filter(edge => !(edge.source === 'execute' && edge.target === 'review')), { source: 'execute', target: 'check', outcome: 'pass' as const }, { source: 'check', target: 'review', outcome: 'pass' as const }] }
  const agents = { ...run({}).agents, check: { engine: 'glm', model: null, family: null } }
  const versions: WorkflowRun['versions'] = [
    { number: 1, revision: 'r1', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'drawer', relayedBy: null, at: 1 },
    { number: 2, revision: 'r2', reason: 'Tests first', size: 'big', state: 'pending', approvedVia: null, relayedBy: null, at: 2, graph, agents, skills: { check: [{ path: 'SKILL.md', content: 'skill body' }] } },
  ]
  const view = runView(run({ versions }))
  expect(view.proposal!.number).toBe(2)
  expect(view.proposal!.reason).toBe('Tests first')
  expect(view.proposal!.nodes.find(node => node.id === 'check')).toEqual({ id: 'check', title: 'API check', kind: 'task', engine: 'glm' })
  expect(view.proposal!.edges).toContainEqual({ source: 'execute', target: 'check', outcome: 'pass' })
  expect(view.latestChange).toEqual({ number: 2, reason: 'Tests first', size: 'big', approvedVia: null, state: 'pending' })
  expect(view.versions.map(version => Object.keys(version).filter(key => ['graph', 'agents', 'skills'].includes(key)))).toEqual([[], []])
  expect(JSON.stringify(view)).not.toContain('skill body')
  expect(JSON.stringify(view)).not.toContain('Run the API tests')
})

test('an applied change leaves no proposal but is still the latest change; a first version alone is neither', () => {
  const applied = runView(run({ versions: [
    { number: 1, revision: 'r1', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'auto', relayedBy: null, at: 1 },
    { number: 2, revision: 'r2', reason: 'Added a check', size: 'big', state: 'approved', approvedVia: 'auto', relayedBy: null, at: 2, graph: workflow, agents: run({}).agents, skills: {} },
  ] }))
  expect(applied.proposal).toBeNull()
  expect(applied.latestChange).toEqual({ number: 2, reason: 'Added a check', size: 'big', approvedVia: 'auto', state: 'approved' })
  const first = runView(run({ versions: [{ number: 1, revision: 'r1', reason: 'Initial flow', size: 'initial', state: 'pending', approvedVia: null, relayedBy: null, at: 1 }] }))
  expect([first.proposal, first.latestChange]).toEqual([null, null])
})
