import type { JobManager, JobRecord } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import type { QuotaComposite } from './quota'
import { quotaCache } from './routes/quota'
import { readRoles } from './routes/roles'
import type { EngineRoles } from './secrets'

export function buildReviewPrompt(source: JobRecord): string {
  return [
    `Cross-family review of a finished ${source.engine} implementation job (label: ${source.label}).`,
    `You are in the job's working tree. Review ONLY that job's changes:`,
    `1. Run \`git status --porcelain\` — if the tree is dirty, review \`git diff HEAD\` (plus untracked files).`,
    `2. If the tree is clean, review the most recent commit: \`git log --oneline -3\` then \`git diff HEAD~1\`.`,
    `Do NOT edit, create, or delete any file. Read surrounding code as needed for context.`,
    `Output format — first line exactly \`SHIP\` or \`NO-SHIP\`, then findings ranked most severe first,`,
    `each as: file:line — what is wrong — why it matters. If SHIP with no findings, say so in one line.`,
    `Reported diff stat of the job under review: ${source.diffStat ?? 'unknown'}.`,
  ].join('\n')
}

export function shouldAutoReview(record: JobRecord, allJobs: readonly JobRecord[], roles: EngineRoles): boolean {
  const { execute } = roles
  if (record.status !== 'done' || record.engine !== execute.engine || record.reviewOf !== null) return false
  if (record.diffStat === null || record.diffStat.trim() === '') return false
  return !allJobs.some((job) => job.reviewOf !== null && job.threadRoot === record.threadRoot)
}

export type ReviewerReadiness = { ok: true } | { ok: false; reason: string }

export function reviewerReadiness(engine: string, quota: QuotaComposite): ReviewerReadiness {
  if (engine === 'codex') {
    if (!quota.codex.available) return { ok: false, reason: 'codex unavailable' }
    return quota.codex.authed ? { ok: true } : { ok: false, reason: 'codex not authed' }
  }
  if (engine === 'glm') return quota.glm.available ? { ok: true } : { ok: false, reason: quota.glm.reason }
  if (engine === 'claude') return quota.claude.available ? { ok: true } : { ok: false, reason: quota.claude.reason }
  return { ok: false, reason: `unknown reviewer engine ${engine}` }
}

export type AutoReviewDeps = {
  resolver: EngineResolver
  roles?: () => Promise<EngineRoles>
  probeQuota?: () => Promise<QuotaComposite>
  log?: (line: string) => void
}

export async function maybeAutoReview(
  record: JobRecord,
  manager: JobManager,
  deps: AutoReviewDeps,
): Promise<void> {
  const log = deps.log ?? console.error
  const roles = await (deps.roles ?? readRoles)()
  if (!shouldAutoReview(record, manager.listJobs(), roles)) return
  const { review } = roles

  const readiness = reviewerReadiness(review.engine, await (deps.probeQuota ?? (() => quotaCache.get()))())
  if (!readiness.ok) {
    log(`auto-review: skipped for ${record.label} — ${readiness.reason}`)
    return
  }

  const result = await manager.createJob(
    {
      engine: review.engine,
      cwd: record.cwd,
      label: record.label,
      prompt: buildReviewPrompt(record),
      parentJobId: record.id,
      threadRoot: record.threadRoot,
      reviewOf: record.id,
      ...(record.terminalId === null ? {} : { terminalId: record.terminalId }),
      ...(review.model === null ? {} : { model: review.model }),
    },
    deps.resolver,
  )
  if (!result.ok) log(`auto-review: dispatch failed for ${record.label} — ${result.error}`)
}
