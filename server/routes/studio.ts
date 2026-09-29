import { Elysia } from 'elysia'
import { z } from 'zod'
import { requireLocal } from '../auth'
import { fromBrowser } from '../local-access'
import { BUILTIN_AGENTS, CONNECTION_PRESETS, createConnectionStore } from '../agent-connections'
import { listModels } from '../models'
import { modelsCache } from './models'
import { composeWorkflowPrompt, identifier, type WorkflowStore } from '../workflows'
import type { WorkflowBuilder } from '../workflow-builder'
import { RunActionError, type ApprovalContext, type WorkflowRun, type WorkflowRunner } from '../workflow-runner'
import { readConfig } from '../secrets'
import { eventStreamResponse, type RunEvents } from '../run-events'
import { scopeSnapshot, versionView } from '../run-view'
import type { JobRecord } from '../jobs'
import { join } from 'node:path'

const changeBody = z.object({ graph: z.unknown(), reason: z.string().trim().min(1).max(500), scopeGrew: z.boolean().optional() })
const sessionBody = z.object({ chat: z.string().min(1).max(200).optional(), terminalId: identifier.optional(), version: z.number().int().min(1).optional() }).default({})
function approvalContext(request: Request, body: unknown): ApprovalContext {
  const { version, ...session } = sessionBody.parse(body ?? {})
  return fromBrowser(request) ? { via: 'drawer', ...(version ? { version } : {}) } : { via: 'conversation', ...session, ...(version ? { version } : {}) }
}

const publicRun = (run: WorkflowRun) => ({ ...run, versions: run.versions.map(versionView) })

function workflowIdFor(label: string, runId: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const prefixed = !slug ? `flow-${runId.slice(0, 8)}` : /^[0-9]/.test(slug) ? `flow-${slug}` : slug
  return prefixed.slice(0, 64).replace(/-+$/, '')
}

async function workflowExists(store: WorkflowStore, id: string): Promise<boolean> {
  try { await store.get(id); return true }
  catch (error) { if ((error as Error).message === 'Workflow not found') return false; throw error }
}

export function studioRoutes(store: WorkflowStore, runner: WorkflowRunner, builder?: WorkflowBuilder, events?: RunEvents, jobs?: () => JobRecord[]) {
  const connections = createConnectionStore()
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .onError(({ error, set }) => {
      set.status = error instanceof RunActionError ? error.status : 400
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
    .delete('/api/studio/connections/:id', async ({ params }) => { await connections.remove(params.id); modelsCache.invalidate(); return { ok: true } })
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
    .get('/api/studio/events', ({ query, request }) => {
      if (!events || !jobs) throw new Error('Live updates unavailable')
      const scope = { chat: query.chat || undefined, terminal: query.terminal || undefined }
      return eventStreamResponse(events, () => scopeSnapshot(runner.list(), jobs(), scope), request.signal)
    })
    .get('/api/studio/runs', ({ query }) => ({ runs: runner.list()
      .filter(run => (!query.chat || run.chatId === query.chat) && (!query.terminal || run.terminalId === query.terminal))
      .map(run => ({ id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision, currentNodeId: run.currentNodeId, workingNodeIds: run.tokens.filter(token => token.state === 'working').map(token => token.nodeId), createdAt: run.createdAt, origin: run.origin, pending: run.versions.some(version => version.state === 'pending') })) }))
    .post('/api/studio/runs', ({ body, request }) => runner.start(body, { startedByUser: fromBrowser(request) }).then(publicRun))
    .get('/api/studio/runs/:id', ({ params, set }) => {
      const run = runner.get(params.id)
      if (!run) { set.status = 404; return { error: 'Run not found' } }
      return publicRun(run)
    })
    .post('/api/studio/runs/:id/approve', ({ params, body, request }) => runner.approve(params.id, approvalContext(request, body)).then(publicRun))
    .post('/api/studio/runs/:id/reject', ({ params, body, request }) => runner.reject(params.id, approvalContext(request, body)).then(publicRun))
    .get('/api/studio/runs/:id/steps/:nodeId', ({ params }) => runner.waitingStep(params.id, params.nodeId))
    .post('/api/studio/runs/:id/steps/:nodeId', ({ params, body, request }) => runner.report(params.id, params.nodeId, body, approvalContext(request, body)).then(publicRun))
    .post('/api/studio/runs/:id/changes',({ params, body, request }) => runner.propose(params.id, changeBody.parse(body), approvalContext(request, body)).then(publicRun))
    .post('/api/studio/runs/:id/save', async ({ params, request }) => {
      if (!fromBrowser(request)) throw new RunActionError('Save from the drawer', 403)
      const run = runner.get(params.id)
      if (!run) throw new RunActionError('Run not found', 404)
      const id = workflowIdFor(run.label, run.id)
      if (await workflowExists(store, id)) throw new RunActionError('A workflow with that name exists', 409)
      const { revision: _revision, createdAt: _createdAt, ...graph } = run.workflow
      return store.save({ ...graph, id, name: run.label })
    })
    .post('/api/studio/runs/:id/pause', ({ params }) => runner.pause(params.id).then(publicRun))
    .post('/api/studio/runs/:id/resume', ({ params }) => runner.resume(params.id).then(publicRun))
    .post('/api/studio/runs/:id/stop', ({ params }) => runner.stop(params.id).then(publicRun))
    .post('/api/studio/runs/:id/retry', ({ params }) => runner.retry(params.id).then(publicRun))
}
