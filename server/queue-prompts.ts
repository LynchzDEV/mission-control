import type { QueueItem } from './queue-store'
import type { SourceReply } from './queue-source'
import type { WorkflowRun } from './workflow-runner'

export type RunView = Pick<WorkflowRun, 'id' | 'status' | 'error' | 'attempts'>

export const SETTLED: ReadonlySet<WorkflowRun['status']> = new Set(['done', 'failed', 'blocked', 'stopped'])

const MAX_BRANCH = 60

export function branchLabel(item: Pick<QueueItem, 'title' | 'externalId'>): string {
  const id = item.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const room = MAX_BRANCH - 'queue-'.length - id.length - 1
  const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, Math.max(0, room)).replace(/-+$/, '')
  return slug ? `queue-${slug}-${id}` : `queue-${id}`
}

export function runRequest(item: Pick<QueueItem, 'title' | 'url' | 'contextPath' | 'answerPaths'>): string {
  return [
    `Work on "${item.title}" (${item.url}).`,
    `Read the task context in ${item.contextPath}.`,
    ...(item.answerPaths.length > 0 ? [`The requester answered your earlier questions: read ${item.answerPaths.join(', ')}.`] : []),
    'If information you need is missing and you cannot decide it yourself, end the step with MC_RESULT blocked and put each question for the requester as one evidence item.',
  ].join('\n')
}

export function questionsOf(run: RunView): string[] {
  const settled = run.attempts.filter(attempt => attempt.result !== null && attempt.endedAt !== null)
  const last = settled.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).at(-1)
  if (run.status !== 'blocked' || last === undefined || last.interrupted || last.result?.outcome !== 'blocked') return []
  return last.result.evidence.map(line => line.trim()).filter(line => line !== '')
}

export function answersMarkdown(questions: string[], replies: SourceReply[], images: string[]): string {
  const asked = questions.map(question => `- ${question}`).join('\n')
  const answered = replies.map(reply => `### ${reply.author}\n\n${reply.text}`).join('\n\n')
  const pictures = images.length > 0 ? `\n## Images\n\n${images.map(path => `- ${path}`).join('\n')}\n` : ''
  return `# Answers from the requester\n\n## Questions asked\n\n${asked}\n\n## Replies\n\n${answered}\n${pictures}`
}
