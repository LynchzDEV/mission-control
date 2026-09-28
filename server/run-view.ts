import type { JobRecord } from './jobs'
import type { ApprovalVia, ResolvedAgent, RunOrigin, RunVersion, WorkflowRun } from './workflow-runner'
import type { WorkflowRevision } from './workflows'

export type Scope = { chat?: string; terminal?: string }
export type RunStepView = { id: string; title: string; kind: string; engine: string }
export type RunAttemptView = { nodeId: string; number: number; jobId: string | null; status: string; outcome: 'pass' | 'fail' | 'blocked' | null; summary: string | null; startedAt: number; endedAt: number | null }
export type RunEdgeView = { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked' }
export type RunVersionView = Omit<RunVersion, 'graph' | 'agents' | 'skills'>
export type RunProposalView = { number: number; reason: string; nodes: RunStepView[]; edges: RunEdgeView[] }
export type RunChangeView = { number: number; reason: string; size: 'small' | 'big'; approvedVia: ApprovalVia | null; state: string }
export type RunView = { id: string; label: string; status: string; error: string | null; workflowName: string; revision: string; entry: string; currentNodeId: string; origin: RunOrigin; versions: RunVersionView[]; nodes: RunStepView[]; edges: RunEdgeView[]; attempts: RunAttemptView[]; createdAt: number; updatedAt: number; proposal: RunProposalView | null; latestChange: RunChangeView | null }
export type QuickJobView = { id: string; label: string; engine: string; status: string; startedAt: number; endedAt: number | null }
export type ScopeSnapshot = { runs: RunView[]; jobs: QuickJobView[] }

export function versionView({ graph: _graph, agents: _agents, skills: _skills, ...version }: RunVersion): RunVersionView {
  return version
}

function stepViews(workflow: WorkflowRevision, agents: Record<string, ResolvedAgent>): RunStepView[] {
  return workflow.nodes.map(node => ({ id: node.id, title: node.title, kind: node.kind, engine: agents[node.id]?.engine ?? '' }))
}

function edgeViews(workflow: WorkflowRevision): RunEdgeView[] {
  return workflow.edges.map(edge => ({ source: edge.source, target: edge.target, outcome: edge.outcome }))
}

function proposalView(run: WorkflowRun): RunProposalView | null {
  const pending = run.versions.find(version => version.state === 'pending' && version.number > 1 && version.graph)
  if (!pending) return null
  return { number: pending.number, reason: pending.reason, nodes: stepViews(pending.graph!, pending.agents ?? {}), edges: edgeViews(pending.graph!) }
}

function latestChangeView(run: WorkflowRun): RunChangeView | null {
  const latest = run.versions.filter(version => version.number > 1).at(-1)
  if (!latest) return null
  return { number: latest.number, reason: latest.reason, size: latest.size === 'big' ? 'big' : 'small', approvedVia: latest.approvedVia, state: latest.state }
}

export function runView(run: WorkflowRun): RunView {
  return {
    id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision,
    entry: run.workflow.entry, currentNodeId: run.currentNodeId, origin: run.origin,
    versions: run.versions.map(versionView),
    nodes: stepViews(run.workflow, run.agents), edges: edgeViews(run.workflow),
    attempts: run.attempts.map(attempt => ({ nodeId: attempt.nodeId, number: attempt.number, jobId: attempt.jobId, status: attempt.status, outcome: attempt.result?.outcome ?? null, summary: attempt.result?.summary ?? null, startedAt: attempt.startedAt, endedAt: attempt.endedAt })),
    createdAt: run.createdAt, updatedAt: run.updatedAt, proposal: proposalView(run), latestChange: latestChangeView(run),
  }
}

function inScope(item: { chatId?: string; terminalId?: string | null }, scope: Scope): boolean {
  return (!!scope.chat && item.chatId === scope.chat) || (!!scope.terminal && item.terminalId === scope.terminal)
}

export function scopeSnapshot(runs: WorkflowRun[], jobs: JobRecord[], scope: Scope): ScopeSnapshot {
  return {
    runs: runs.filter(run => inScope(run, scope)).sort((a, b) => b.createdAt - a.createdAt).map(runView),
    jobs: jobs.filter(job => inScope(job, scope) && !job.workflowRunId && job.purpose !== 'chat').sort((a, b) => b.startedAt - a.startedAt)
      .map(job => ({ id: job.id, label: job.label, engine: job.engine, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt ?? null })),
  }
}
