import type { JobRecord } from './jobs'
import type { RunOrigin, RunVersion, WorkflowRun } from './workflow-runner'

export type Scope = { chat?: string; terminal?: string }
export type RunStepView = { id: string; title: string; kind: string; engine: string }
export type RunAttemptView = { nodeId: string; number: number; jobId: string | null; status: string; outcome: 'pass' | 'fail' | 'blocked' | null; summary: string | null; startedAt: number; endedAt: number | null }
export type RunView = { id: string; label: string; status: string; error: string | null; workflowName: string; revision: string; entry: string; currentNodeId: string; origin: RunOrigin; versions: RunVersion[]; nodes: RunStepView[]; edges: { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked' }[]; attempts: RunAttemptView[]; createdAt: number; updatedAt: number }
export type QuickJobView = { id: string; label: string; engine: string; status: string; startedAt: number; endedAt: number | null }
export type ScopeSnapshot = { runs: RunView[]; jobs: QuickJobView[] }

export function runView(run: WorkflowRun): RunView {
  return {
    id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision,
    entry: run.workflow.entry, currentNodeId: run.currentNodeId, origin: run.origin, versions: run.versions,
    nodes: run.workflow.nodes.map(node => ({ id: node.id, title: node.title, kind: node.kind, engine: run.agents[node.id]?.engine ?? '' })),
    edges: run.workflow.edges.map(edge => ({ source: edge.source, target: edge.target, outcome: edge.outcome })),
    attempts: run.attempts.map(attempt => ({ nodeId: attempt.nodeId, number: attempt.number, jobId: attempt.jobId, status: attempt.status, outcome: attempt.result?.outcome ?? null, summary: attempt.result?.summary ?? null, startedAt: attempt.startedAt, endedAt: attempt.endedAt })),
    createdAt: run.createdAt, updatedAt: run.updatedAt,
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
