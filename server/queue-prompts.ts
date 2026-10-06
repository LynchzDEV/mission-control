import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { QueueItem } from './queue-store'
import type { SourceReply } from './queue-source'
import type { WorkflowRun } from './workflow-runner'

export type RunView = Pick<WorkflowRun, 'id' | 'status' | 'error' | 'attempts'>

export const SETTLED: ReadonlySet<WorkflowRun['status']> = new Set(['done', 'failed', 'blocked', 'stopped'])

const MAX_BRANCH = 60

const sourceTag = (source: string): string => createHash('sha256').update(source).digest('hex').slice(0, 4)

export function branchLabel(item: Pick<QueueItem, 'title' | 'externalId' | 'source'>): string {
  const id = `${item.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${sourceTag(item.source)}`
  const room = MAX_BRANCH - 'queue-'.length - id.length - 1
  const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, Math.max(0, room)).replace(/-+$/, '')
  return slug ? `queue-${slug}-${id}` : `queue-${id}`
}

const REPO_REQUEST = /^repo:\s*(\S.*)$/

function reposLines(item: Pick<QueueItem, 'repo' | 'worktree'> & { repos: readonly string[] }, available: readonly string[]): string[] {
  const copies = item.repos.length === 0 ? 'none yet' : item.repos.map(name => join(item.worktree ?? '', name)).join(', ')
  return [
    `This item spans several repos in ${item.repo}. The real repos there are READ-ONLY: read them to plan, never change them: ${available.map(name => join(item.repo, name)).join(', ')}.`,
    `Work only in the repo copies in this workspace, at ${item.worktree}/<name>. Copies ready now: ${copies}. Each copy is its own git worktree; make, test and inspect changes inside it.`,
    'To get a copy of another repo, end the step with MC_RESULT blocked and one evidence item per repo in exactly the form `repo: <name>`. Any other evidence item is a question for the requester.',
  ]
}

export function runRequest(item: Pick<QueueItem, 'title' | 'url' | 'contextPath' | 'answerPaths' | 'repos' | 'repo' | 'worktree'>, available: readonly string[] = []): string {
  return [
    `Work on "${item.title}" (${item.url}).`,
    ...(item.repos === undefined ? [] : reposLines({ ...item, repos: item.repos }, available)),
    `Read the task context in ${item.contextPath}.`,
    ...(item.answerPaths.length > 0 ? [`The requester answered your earlier questions: read ${item.answerPaths.join(', ')}.`] : []),
    'If information you need is missing and you cannot decide it yourself, end the step with MC_RESULT blocked and put each question for the requester as one evidence item.',
  ].join('\n')
}

type Attempt = RunView['attempts'][number]

const byAgent = (attempt: Attempt): boolean => attempt.jobId !== null || attempt.inSession === true

function blockedEvidence(run: RunView): string[] {
  const settled = run.attempts.filter(attempt => attempt.result !== null && attempt.endedAt !== null && !attempt.interrupted)
  const last = settled.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).at(-1)
  if (run.status !== 'blocked' || last === undefined || !byAgent(last) || last.result?.outcome !== 'blocked') return []
  return last.result.evidence.map(line => line.trim()).filter(line => line !== '')
}

export function questionsOf(run: RunView): string[] {
  return blockedEvidence(run).filter(line => !REPO_REQUEST.test(line))
}

export function repoRequestsOf(run: RunView): string[] {
  return [...new Set(blockedEvidence(run).flatMap(line => REPO_REQUEST.exec(line)?.[1]?.trim() ?? []))]
}

export function answersMarkdown(questions: string[], replies: SourceReply[], images: string[]): string {
  const asked = questions.map(question => `- ${question}`).join('\n')
  const answered = replies.map(reply => `### ${reply.author}\n\n${reply.text}`).join('\n\n')
  const pictures = images.length > 0 ? `\n## Images\n\n${images.map(path => `- ${path}`).join('\n')}\n` : ''
  return `# Answers from the requester\n\n## Questions asked\n\n${asked}\n\n## Replies\n\n${answered}\n${pictures}`
}
