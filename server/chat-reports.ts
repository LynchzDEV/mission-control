import { oneLine, parseThread, reportedJobOutcome } from './activity'
import type { JobManager, JobRecord } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import { replySessionId, threadChain, threadIsRunning, threadRootOf } from './threads'

const REPORT_TEXT_MAX = 1200
const MEMORY_TEXT_MAX = 160
const LABEL_MAX = 160
const MEMORY_ITEMS = 8
const DAY_MS = 86_400_000
export const REPORT_RETRY_MS = 3_000
export const REPORT_RETRY_LIMIT = 400

export type AgentReport = { message: string; needsYou: boolean }

export type ReportPosterOptions = {
  readLog: (id: string) => Promise<string>
  notify?: (title: string, body: string) => Promise<void>
  retryMs?: number
  schedule?: (retry: () => Promise<void>, ms: number) => void
}

function lastText(log: string): string {
  const texts = parseThread(log).filter((event) => event.kind === 'text')
  return texts[texts.length - 1]?.detail.trim() ?? ''
}

function outcome(job: JobRecord, failed: boolean): string {
  if (!failed) return 'done'
  return job.exitCode !== null && job.exitCode !== 0 ? `failed (exit ${job.exitCode})` : 'failed'
}

export function agentReport(job: JobRecord, log: string): AgentReport {
  const text = lastText(log)
  const failed = job.status === 'failed' || reportedJobOutcome(log) === 'failed'
  const head = `[agent ${oneLine(job.label, LABEL_MAX)} · ${job.engine}] ${outcome(job, failed)}`
  const body = text.length > REPORT_TEXT_MAX ? `${text.slice(0, REPORT_TEXT_MAX - 1)}…` : text
  const diff = job.diffStat ? `\nDiff:${job.diffStat}` : ''
  return { message: `${head}\n${body}${diff}`.trim(), needsYou: failed || text.endsWith('?') }
}

function relativeDay(at: number, now: number): string {
  const days = Math.floor((now - at) / DAY_MS)
  if (days <= 0) return 'today'
  return days === 1 ? 'yesterday' : `${days} days ago`
}

const newestFirst = (left: JobRecord, right: JobRecord): number => right.startedAt - left.startedAt

export async function projectMemory(jobs: readonly JobRecord[], project: string, exceptRoot: string, readLog: (id: string) => Promise<string>): Promise<string> {
  const now = Date.now()
  const roots = jobs
    .filter((job) => job.purpose === 'chat' && threadRootOf(job) === job.id && job.project === project && job.id !== exceptRoot)
    .sort(newestFirst)
    .slice(0, MEMORY_ITEMS)
  const lines: string[] = []
  for (const root of roots) {
    const latest = threadChain(jobs, root.id).sort(newestFirst)[0] ?? root
    lines.push(`- ${root.label} (${relativeDay(root.startedAt, now)}): ${oneLine(lastText(await readLog(latest.id)), MEMORY_TEXT_MAX)}`)
  }
  const agents = jobs
    .filter((job) => job.purpose !== 'chat' && (job.baseRepo ?? job.cwd) === project && job.chatId !== exceptRoot)
    .sort(newestFirst)
    .slice(0, MEMORY_ITEMS)
  for (const agent of agents) lines.push(`- agent ${agent.label} (${agent.status})`)
  return lines.join('\n')
}

export function createReportPoster(manager: JobManager, resolver: EngineResolver, opts: ReportPosterOptions): (record: JobRecord) => Promise<void> {
  const retryMs = opts.retryMs ?? REPORT_RETRY_MS
  const schedule = opts.schedule ?? ((retry, ms) => { setTimeout(() => void retry().catch(() => {}), ms) })

  const post = async (record: JobRecord, attempt: number): Promise<void> => {
    const chatId = record.chatId
    if (!chatId) return
    const root = manager.getJob(chatId)
    if (!root || root.purpose !== 'chat' || threadRootOf(root) !== root.id) return
    const chain = threadChain(manager.listJobs(), chatId)
    if (threadIsRunning(chain)) {
      if (attempt < REPORT_RETRY_LIMIT) schedule(() => post(record, attempt + 1), retryMs)
      return
    }
    const sessionId = replySessionId(chain)
    const last = chain[chain.length - 1]
    if (sessionId === null || last === undefined) return
    const report = agentReport(record, await opts.readLog(record.id))
    const memory = root.project ? await projectMemory(manager.listJobs(), root.project, chatId, opts.readLog) : ''
    const created = await manager.createJob({
      engine: root.engine,
      cwd: root.cwd,
      prompt: report.message,
      label: root.label,
      parentJobId: last.id,
      threadRoot: chatId,
      resumeSessionId: sessionId,
      purpose: 'chat',
      source: 'agent',
      edit: root.edit ?? false,
      project: root.project ?? null,
      memory,
      ...(root.model === null ? {} : { model: root.model }),
    }, resolver)
    if (!created.ok) console.error(`chat report for ${record.id} not posted: ${created.error}`)
    if (report.needsYou) await opts.notify?.('Needs you', `${root.label} · ${record.label}`)
  }

  return (record) => post(record, 0)
}
