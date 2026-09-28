import type { JobRecord } from './jobs'
import type { ApprovalVia, ResolvedAgent, RunOrigin, RunVersion, TokenState, WorkflowRun } from './workflow-runner'
import { forkSections, type ForkSection, type WorkflowNode, type WorkflowRevision } from './workflows'

export type Scope = { chat?: string; terminal?: string }
export type RunStepView = { id: string; title: string; kind: string; engine: string }
export type RunAttemptView = { nodeId: string; number: number; jobId: string | null; status: string; outcome: 'pass' | 'fail' | 'blocked' | null; summary: string | null; startedAt: number; endedAt: number | null; pathId: string; from: number[]; subAgents: number }
export type RunTokenView = { nodeId: string; pathId: string; state: TokenState; from: number[] }
export type RunSectionPathView = { nodes: string[]; title: string; firstNodeId: string; pathId: string | null; branch: string | null }
export type RunSectionView = { fork: string; join: string; state: 'waiting' | 'open' | 'joined' | 'conflict'; joined: string[]; paths: RunSectionPathView[] }
export type RunEdgeView = { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked' }
export type RunVersionView = Omit<RunVersion, 'graph' | 'agents' | 'skills'>
export type RunProposalView = { number: number; reason: string; nodes: RunStepView[]; edges: RunEdgeView[]; removed: string[]; changed: string[] }
export type RunChangeView = { number: number; reason: string; size: 'small' | 'big'; approvedVia: ApprovalVia | null; state: string }
export type RunView = { id: string; label: string; status: string; error: string | null; workflowName: string; revision: string; entry: string; currentNodeId: string; origin: RunOrigin; versions: RunVersionView[]; nodes: RunStepView[]; edges: RunEdgeView[]; attempts: RunAttemptView[]; createdAt: number; updatedAt: number; proposal: RunProposalView | null; latestChange: RunChangeView | null; tokens: RunTokenView[]; sections: RunSectionView[]; keptBranches: string[] }
export type QuickJobView = { id: string; label: string; engine: string; status: string; startedAt: number; endedAt: number | null }
export type ScopeSnapshot = { runs: RunView[]; jobs: QuickJobView[] }

export function versionView({ graph: _graph, agents: _agents, skills: _skills, ...version }: RunVersion): RunVersionView {
  return version
}

function stepViews(workflow: WorkflowRevision, agents: Record<string, ResolvedAgent>): RunStepView[] {
  return workflow.nodes.map(node => ({ id: node.id, title: node.title, kind: node.kind, engine: node.kind === 'join' ? '' : agents[node.id]?.engine ?? '' }))
}

function edgeViews(workflow: WorkflowRevision): RunEdgeView[] {
  return workflow.edges.map(edge => ({ source: edge.source, target: edge.target, outcome: edge.outcome }))
}

const behaviour = (node: WorkflowNode): string => JSON.stringify([node.kind, node.instructions, node.agent, node.checks, node.mcpServers])

function proposalView(run: WorkflowRun): RunProposalView | null {
  const pending = run.versions.find(version => version.state === 'pending' && version.number > 1 && version.graph)
  if (!pending) return null
  const next = new Map(pending.graph!.nodes.map(node => [node.id, node]))
  const removed = run.workflow.nodes.filter(node => !next.has(node.id)).map(node => node.id)
  const changed = run.workflow.nodes.filter(node => next.has(node.id) && behaviour(next.get(node.id)!) !== behaviour(node)).map(node => node.id)
  return { number: pending.number, reason: pending.reason, nodes: stepViews(pending.graph!, pending.agents ?? {}), edges: edgeViews(pending.graph!), removed, changed }
}

function latestChangeView(run: WorkflowRun): RunChangeView | null {
  const latest = run.versions.filter(version => version.number > 1).at(-1)
  if (!latest) return null
  return { number: latest.number, reason: latest.reason, size: latest.size === 'big' ? 'big' : 'small', approvedVia: latest.approvedVia, state: latest.state }
}

function latestAttempt(run: WorkflowRun, nodeId: string, before = Infinity): WorkflowRun['attempts'][number] | undefined {
  return run.attempts.filter(attempt => attempt.nodeId === nodeId && attempt.number < before).sort((a, b) => a.number - b.number).at(-1)
}

function settledSection(run: WorkflowRun, section: ForkSection, paths: RunSectionPathView[]): RunSectionView | null {
  const join = latestAttempt(run, section.join)
  const outcome = join?.status === 'settled' ? join.result?.outcome : undefined
  if (!join || (outcome !== 'pass' && outcome !== 'fail')) return null
  const fork = latestAttempt(run, section.fork, join.number)
  const pathIdOf = (firstNodeId: string): string | null => run.attempts.find(attempt => attempt.nodeId === firstNodeId && !!fork && attempt.from?.includes(fork.number))?.pathId ?? null
  const settled = paths.map(path => {
    const pathId = pathIdOf(path.firstNodeId)
    const kept = outcome === 'fail' && pathId ? run.keptBranches.find(branch => branch.endsWith(`-${pathId}`)) ?? null : null
    return { ...path, pathId, branch: kept }
  })
  const joined = settled.filter(path => path.pathId && !path.branch).map(path => path.pathId!)
  return { fork: section.fork, join: section.join, state: outcome === 'pass' ? 'joined' : 'conflict', joined, paths: settled }
}

function sectionView(run: WorkflowRun, section: ForkSection): RunSectionView {
  const title = (id: string): string => run.workflow.nodes.find(node => node.id === id)?.title ?? id
  const paths = section.paths.map(nodes => ({ nodes, title: title(nodes[0]!), firstNodeId: nodes[0]!, pathId: null, branch: null }))
  const open = run.sections.filter(candidate => candidate.fork === section.fork && candidate.join === section.join).at(-1)
  if (open) {
    const live = (firstNodeId: string) => open.paths.find(path => path.firstNodeId === firstNodeId)
    return { fork: section.fork, join: section.join, state: 'open', joined: [...open.joined], paths: paths.map(path => ({ ...path, pathId: live(path.firstNodeId)?.pathId ?? null, branch: live(path.firstNodeId)?.branch ?? null })) }
  }
  return settledSection(run, section, paths) ?? { fork: section.fork, join: section.join, state: 'waiting', joined: [], paths }
}

export function runView(run: WorkflowRun, jobsById: ReadonlyMap<string, JobRecord> = new Map()): RunView {
  return {
    id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision,
    entry: run.workflow.entry, currentNodeId: run.currentNodeId, origin: run.origin,
    versions: run.versions.map(versionView),
    nodes: stepViews(run.workflow, run.agents), edges: edgeViews(run.workflow),
    attempts: run.attempts.map(attempt => ({ nodeId: attempt.nodeId, number: attempt.number, jobId: attempt.jobId, status: attempt.status, outcome: attempt.result?.outcome ?? null, summary: attempt.result?.summary ?? null, startedAt: attempt.startedAt, endedAt: attempt.endedAt, pathId: attempt.pathId ?? 'main', from: attempt.from ?? (attempt.number ? [attempt.number - 1] : []), subAgents: (attempt.jobId ? jobsById.get(attempt.jobId)?.subAgents : undefined) ?? 0 })),
    createdAt: run.createdAt, updatedAt: run.updatedAt, proposal: proposalView(run), latestChange: latestChangeView(run),
    tokens: run.tokens.map(token => ({ nodeId: token.nodeId, pathId: token.pathId, state: token.state, from: token.from })),
    sections: forkSections(run.workflow).map(section => sectionView(run, section)),
    keptBranches: run.keptBranches,
  }
}

function inScope(item: { chatId?: string; terminalId?: string | null }, scope: Scope): boolean {
  return (!!scope.chat && item.chatId === scope.chat) || (!!scope.terminal && item.terminalId === scope.terminal)
}

export function scopeSnapshot(runs: WorkflowRun[], jobs: JobRecord[], scope: Scope): ScopeSnapshot {
  const jobsById = new Map(jobs.map(job => [job.id, job]))
  return {
    runs: runs.filter(run => inScope(run, scope)).sort((a, b) => b.createdAt - a.createdAt).map(run => runView(run, jobsById)),
    jobs: jobs.filter(job => inScope(job, scope) && !job.workflowRunId && job.purpose !== 'chat').sort((a, b) => b.startedAt - a.startedAt)
      .map(job => ({ id: job.id, label: job.label, engine: job.engine, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt ?? null })),
  }
}
