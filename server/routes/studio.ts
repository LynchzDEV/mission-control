import { Elysia } from 'elysia'
import { z } from 'zod'
import { requireLocal } from '../auth'
import { BUILTIN_AGENTS, CONNECTION_PRESETS, createConnectionStore } from '../agent-connections'
import { listModels } from '../models'
import { modelsCache } from './models'
import { composeWorkflowPrompt, identifier, type WorkflowStore } from '../workflows'
import type { WorkflowBuilder } from '../workflow-builder'
import type { WorkflowRunner } from '../workflow-runner'
import { readConfig } from '../secrets'
import { join } from 'node:path'

export function studioRoutes(store: WorkflowStore, runner: WorkflowRunner, builder?: WorkflowBuilder) {
  const connections = createConnectionStore()
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .onError(({ error, set }) => {
      set.status = 400
      return { error: error instanceof Error ? error.message : 'Studio request failed' }
    })
    .get('/api/studio/drafts', () => ({ draft: builder?.current() ?? null }))
    .post('/api/studio/drafts', ({ body }) => { if (!builder) throw new Error('Workflow designer unavailable'); return builder.start(body) })
    .get('/api/studio/drafts/:id', ({ params }) => { if (!builder) throw new Error('Workflow designer unavailable'); return builder.get(params.id) })
    .post('/api/studio/drafts/:id/stop', ({ params }) => { if (!builder) throw new Error('Workflow designer unavailable'); return builder.stop(params.id) })
    .get('/api/studio/workflows', async () => ({ workflows: await store.list(), selected: await store.selected() }))
    .post('/api/studio/workflows', async ({ body }) => {
      const input = z.object({ workflow: z.unknown(), expectedRevision: z.string().optional() }).parse(body)
      return store.save(input.workflow, input.expectedRevision)
    })
    .get('/api/studio/workflows/:id/revisions', async ({ params }) => ({ revisions: await store.revisions(params.id) }))
    .post('/api/studio/default', async ({ body }) => {
      const input = z.object({ id: identifier, revision: identifier }).parse(body)
      await store.setDefault(input.id, input.revision)
      return { ok: true }
    })
    .get('/api/studio/policy', () => store.policy())
    .get('/api/studio/policy/revisions', async () => ({ revisions: await store.policyRevisions() }))
    .post('/api/studio/policy', async ({ body }) => store.savePolicy(z.object({ template: z.string() }).parse(body).template))
    .post('/api/studio/preview', async ({ body }) => {
      const input = z.object({ id: identifier, revision: identifier, nodeId: identifier, request: z.string().max(32000) }).parse(body)
      const graph = await store.get(input.id, input.revision)
      const node = graph.nodes.find(node => node.id === input.nodeId)
      if (!node) throw new Error('Node not found')
      return { prompt: composeWorkflowPrompt(await store.policy(), graph, node, input.request, []) }
    })
    .get('/api/studio/connections', async () => ({ builtins: BUILTIN_AGENTS, connections: await connections.list(), presets: CONNECTION_PRESETS, models: await listModels(), roles: (await readConfig()).roles }))
    .post('/api/studio/connections', async ({ body }) => { const saved = await connections.save(body); modelsCache.invalidate(); return saved })
    .post('/api/studio/connections/:id/probe', async ({ params }) => {
      const connection = await connections.get(params.id)
      if (connection.adapter === 'cli') throw new Error('CLI connections do not advertise protocol capabilities')
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../agent-bridge.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
      const timer = setTimeout(() => proc.kill('SIGTERM'), 35000)
      try {
        proc.stdin.write(JSON.stringify({ connection, prompt: '', probe: true }))
        proc.stdin.end()
        const [log, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        const events = log.split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (code !== 0) throw new Error(events.at(-1)?.result ?? 'Agent probe failed')
        return events.find(event => event.type === 'mc_capabilities') ?? { error: 'Agent did not advertise capabilities' }
      } finally { clearTimeout(timer) }
    })
    .get('/api/studio/runs', () => ({ runs: runner.list().map(run => ({ id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision, currentNodeId: run.currentNodeId, createdAt: run.createdAt })) }))
    .post('/api/studio/runs', ({ body }) => runner.start(body))
    .get('/api/studio/runs/:id', ({ params, set }) => {
      const run = runner.get(params.id)
      if (!run) { set.status = 404; return { error: 'Run not found' } }
      return run
    })
    .post('/api/studio/runs/:id/stop', ({ params }) => runner.stop(params.id))
    .post('/api/studio/runs/:id/retry', ({ params }) => runner.retry(params.id))
}
