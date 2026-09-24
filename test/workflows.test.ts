import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowStore, defaultWorkflow, validateWorkflow, composeWorkflowPrompt } from '../server/workflows'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-workflows-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('saving a blueprint preserves older revisions and default selection across restart', async () => {
  const store = createWorkflowStore(dir)
  const first = await store.save({ ...defaultWorkflow(), id: 'custom', name: 'My workflow' })
  const second = await store.save({ ...first, name: 'Revised workflow' }, first.revision)
  await store.setDefault('custom', first.revision)
  const restarted = createWorkflowStore(dir)
  expect((await restarted.get('custom', first.revision)).name).toBe('My workflow')
  expect((await restarted.get('custom')).revision).toBe(second.revision)
  expect((await restarted.selected()).revision).toBe(first.revision)
  await expect(store.save(first, first.revision)).rejects.toThrow('changed')
})

test('implementation cannot skip plan verification or finish without review on any success path', () => {
  const graph = defaultWorkflow()
  expect(validateWorkflow(graph)).toEqual([])
  expect(validateWorkflow({ ...graph, entry: 'execute' }).join(' ')).toContain('verified plan')
  expect(validateWorkflow({ ...graph, edges: graph.edges.filter(edge => edge.source !== 'execute') }).join(' ')).toContain('review')
})

test('arbitrary test tasks need no implementation checkpoints, ambiguous edges are rejected', () => {
  const node = { ...defaultWorkflow().nodes[0]!, id: 'e2e', kind: 'task', title: 'E2E with Jev' }
  const graph = { ...defaultWorkflow(), id: 'e2e', entry: 'e2e', nodes: [node], edges: [] }
  expect(validateWorkflow(graph)).toEqual([])
  expect(validateWorkflow({ ...graph, edges: [{ source: 'e2e', target: 'e2e', outcome: 'fail' }, { source: 'e2e', target: 'e2e', outcome: 'fail' }] }).join(' ')).toContain('one edge')
})

test('prompt composition keeps mandatory rules, resolved workflow and task separate', async () => {
  const store = createWorkflowStore(dir)
  const policy = await store.policy()
  const graph = defaultWorkflow()
  const rendered = composeWorkflowPrompt(policy, graph, graph.nodes[0]!, 'Inspect project', [])
  expect(rendered).toContain('Never dispatch')
  expect(rendered).toContain('MC_RESULT')
  expect(rendered).toContain('Inspect project')
  expect(rendered).not.toContain('{{workflow}}')
  await expect(store.savePolicy('Only {{assignment}}')).rejects.toThrow('core_rules')
})

test('policy revisions retain implementation rules without requiring them for research tasks', async () => {
  const store = createWorkflowStore(dir)
  const policy = await store.policy()
  const graph = defaultWorkflow()
  expect(composeWorkflowPrompt(policy, graph, graph.nodes[2]!, 'Implement', [])).toContain('framework generator')
  expect(composeWorkflowPrompt(policy, graph, graph.nodes[0]!, 'Research', [])).not.toContain('framework generator')
  const next = await store.savePolicy('Team instructions\n{{core_rules}}\n{{workflow}}\n{{assignment}}')
  expect(next.revision).not.toBe(policy.revision)
  expect((await store.policy(policy.revision)).template).toBe(policy.template)
  expect((await store.policyRevisions()).map(item => item.revision)).toContain(next.revision)
})

test('graph validation rejects stale verification after replanning and unreachable nodes', () => {
  const graph = defaultWorkflow()
  graph.edges.push({ source: 'execute', target: 'plan', outcome: 'fail' })
  expect(validateWorkflow(graph)).toEqual([])
  graph.edges.push({ source: 'plan', target: 'execute', outcome: 'fail' })
  expect(validateWorkflow(graph).join(' ')).toContain('verified plan')
  expect(validateWorkflow({ ...defaultWorkflow(), nodes: [...defaultWorkflow().nodes, { id: 'lost', title: 'Lost', instructions: 'Inspect' }] }).join(' ')).toContain('reachable')
})
