import type { JobManager, JobRecord } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import { fetchCodexQuota, type CodexQuota } from './quota'

export function buildReviewPrompt(source: JobRecord): string {
  return [
    `Cross-family review of a finished glm implementation job (label: ${source.label}).`,
    `You are in the job's working tree. Review ONLY that job's changes:`,
    `1. Run \`git status --porcelain\` — if the tree is dirty, review \`git diff HEAD\` (plus untracked files).`,
    `2. If the tree is clean, review the most recent commit: \`git log --oneline -3\` then \`git diff HEAD~1\`.`,
    `Do NOT edit, create, or delete any file. Read surrounding code as needed for context.`,
    `Output format — first line exactly \`SHIP\` or \`NO-SHIP\`, then findings ranked most severe first,`,
    `each as: file:line — what is wrong — why it matters. If SHIP with no findings, say so in one line.`,
    `Reported diff stat of the job under review: ${source.diffStat ?? 'unknown'}.`,
  ].join('\n')
}

export function shouldAutoReview(record: JobRecord, allJobs: readonly JobRecord[]): boolean {
  if (record.status !== 'done' || record.engine !== 'glm') return false
  if (record.diffStat === null || record.diffStat.trim() === '') return false
  return !allJobs.some((job) => job.engine === 'codex' && job.threadRoot === record.threadRoot)
}

export type AutoReviewDeps = {
  resolver: EngineResolver
  probeCodex?: () => Promise<CodexQuota>
  log?: (line: string) => void
}

export async function maybeAutoReview(
  record: JobRecord,
  manager: JobManager,
  deps: AutoReviewDeps,
): Promise<void> {
  const log = deps.log ?? console.error
  if (!shouldAutoReview(record, manager.listJobs())) return

  const codex = await (deps.probeCodex ?? fetchCodexQuota)()
  if (!codex.available) {
    log(`auto-review: skipped for ${record.label} — codex unavailable`)
    return
  }
  if (!codex.authed) {
    log(`auto-review: skipped for ${record.label} — codex not authed`)
    return
  }

  const result = await manager.createJob(
    {
      engine: 'codex',
      cwd: record.cwd,
      label: record.label,
      prompt: buildReviewPrompt(record),
      parentJobId: record.id,
      threadRoot: record.threadRoot,
      ...(record.terminalId === null ? {} : { terminalId: record.terminalId }),
    },
    deps.resolver,
  )
  if (!result.ok) log(`auto-review: dispatch failed for ${record.label} — ${result.error}`)
}
