import type { WorkflowRun } from './workflow-runner'

export type QueueStep = { title: string; attempt: number; maxAttempts: number }
export type QueueStepRun = { workflow: { nodes: ReadonlyArray<{ id: string; title: string; maxVisits: number }> }; currentNodeId: string; attempts: ReadonlyArray<{ nodeId: string }> }

export function queueStep(run: QueueStepRun | Pick<WorkflowRun, 'workflow' | 'currentNodeId' | 'attempts'>): QueueStep | null {
  const node = run.workflow.nodes.find(entry => entry.id === run.currentNodeId)
  if (node === undefined) return null
  const visits = run.attempts.filter(attempt => attempt.nodeId === node.id).length
  return { title: node.title, attempt: Math.max(1, visits), maxAttempts: node.maxVisits }
}
