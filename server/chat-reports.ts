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
export const AGENT_ROUNDS_MAX = 12

export type AgentReport = { message: string; needsYou: boolean }

export type LogReader = (id: string) => Promise<string>

export type ReportPosterOptions = {
  logReader: () => Promise<LogReader>
  notify?: (title: string, body: string) => Promise<void>
  retryMs?: number
  retryLimit?: number
  schedule?: (retry: () => Promise<void>, ms: number) => void
}

function lastText(log: string): string {
  const texts = parseThread(log).filter((event) => event.kind === 'text')
  return texts[texts.length - 1]?.detail.trim() ?? ''
}

function outcome(job: JobRecord, failed: boolean): string {
  if (job.stoppedAt !== undefined) return 'stopped'
  if (!failed) return 'done'
  return job.exitCode !== null && job.exitCode !== 0 ? `failed (exit ${job.exitCode})` : 'failed'
}

export function agentReport(job: JobRecord, log: string): AgentReport {
  const text = lastText(log)
  const failed = job.status === 'failed' || reportedJobOutcome(log) === 'failed'
  const head = `[agent ${oneLine(job.label, LABEL_MAX)} · ${job.engine}] ${outcome(job, failed)}`
  const body = text.length > REPORT_TEXT_MAX ? `${text.slice(0, REPORT_TEXT_MAX - 1)}…` : text
  const diff = job.diffStat ? `\nDiff:${job.diffStat}` : ''
  return { message: `${head}\n${body}${diff}`.trim(), needsYou: job.stoppedAt === undefined && (failed || text.endsWith('?')) }
}

function relativeDay(at: number, now: number): string {
  const days = Math.floor((now - at) / DAY_MS)
  if (days <= 0) return 'today'
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function agentRoundsSinceUser(chain: readonly JobRecord[]): number {
  let rounds = 0
  for (let index = chain.length - 1; index >= 0 && chain[index]?.source === 'agent'; index -= 1) rounds += 1
  return rounds
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
  const retryLimit = opts.retryLimit ?? REPORT_RETRY_LIMIT
  const schedule = opts.schedule ?? ((retry, ms) => { setTimeout(() => void retry().catch(() => {}), ms) })
  const waiting = new Map<string, JobRecord[]>()
  const attempts = new Map<string, number>()
  const scheduled = new Set<string>()
  const queues = new Map<string, Promise<void>>()

  const chatRootFor = (chatId: string): JobRecord | undefined => {
    const root = manager.getJob(chatId)
    return root && root.purpose === 'chat' && threadRootOf(root) === root.id ? root : undefined
  }

  const enqueue = (chatId: string): Promise<void> => {
    const next = (queues.get(chatId) ?? Promise.resolve()).then(() => flush(chatId)).catch((error) => console.error(`chat report for ${chatId} failed`, error))
    queues.set(chatId, next)
    return next
  }

  const needsYouNotice = async (root: JobRecord, reports: ReadonlyArray<{ record: JobRecord; report: AgentReport }>): Promise<void> => {
    const needing = reports.filter(({ report }) => report.needsYou).map(({ record }) => record.label)
    if (needing.length > 0) await opts.notify?.('Needs you', `${root.label} · ${needing.join(', ')}`)
  }

  const take = (chatId: string, records: readonly JobRecord[]): void => {
    const rest = (waiting.get(chatId) ?? []).filter((entry) => !records.includes(entry))
    if (rest.length > 0) {
      waiting.set(chatId, rest)
      return
    }
    waiting.delete(chatId)
    attempts.delete(chatId)
  }

  const drop = async (root: JobRecord, records: readonly JobRecord[], reason: string): Promise<void> => {
    take(root.id, records)
    for (const record of records) console.error(`chat report dropped: chat ${root.id} agent ${record.label} (${reason})`)
    const readLog = await opts.logReader()
    await needsYouNotice(root, await Promise.all(records.map(async (record) => ({ record, report: agentReport(record, await readLog(record.id)) }))))
  }

  const holdForUser = async (root: JobRecord, records: readonly JobRecord[]): Promise<void> => {
    take(root.id, records)
    console.error(`chat report held: chat ${root.id} reached ${AGENT_ROUNDS_MAX} agent rounds without a user turn (${records.map((record) => record.label).join(', ')})`)
    await opts.notify?.('Needs you', `${root.label} · waiting for you after ${AGENT_ROUNDS_MAX} agent rounds`)
  }

  const wait = async (root: JobRecord, records: readonly JobRecord[]): Promise<void> => {
    const attempt = attempts.get(root.id) ?? 0
    if (attempt >= retryLimit) return drop(root, records, 'chat stayed busy')
    if (scheduled.has(root.id)) return
    attempts.set(root.id, attempt + 1)
    scheduled.add(root.id)
    schedule(() => {
      scheduled.delete(root.id)
      return enqueue(root.id)
    }, retryMs)
  }

  const flush = async (chatId: string): Promise<void> => {
    const records = waiting.get(chatId) ?? []
    const root = chatRootFor(chatId)
    if (records.length === 0 || root === undefined) return
    if (threadIsRunning(threadChain(manager.listJobs(), chatId))) return wait(root, records)
    const readLog = await opts.logReader()
    const reports = await Promise.all(records.map(async (record) => ({ record, report: agentReport(record, await readLog(record.id)) })))
    const memory = root.project ? await projectMemory(manager.listJobs(), root.project, chatId, readLog) : ''
    const chain = threadChain(manager.listJobs(), chatId)
    if (threadIsRunning(chain)) return wait(root, records)
    const sessionId = replySessionId(chain)
    const last = chain[chain.length - 1]
    if (sessionId === null || last === undefined) return drop(root, records, 'chat has no session to resume')
    if (agentRoundsSinceUser(chain) >= AGENT_ROUNDS_MAX) return holdForUser(root, records)
    take(chatId, records)
    const created = await manager.createJob({
      engine: root.engine,
      cwd: root.cwd,
      prompt: reports.map(({ report }) => report.message).join('\n\n'),
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
    if (!created.ok) return drop(root, records, created.error)
    await needsYouNotice(root, reports)
  }

  return (record) => {
    const chatId = record.chatId
    if (!chatId || chatRootFor(chatId) === undefined) return Promise.resolve()
    const pending = waiting.get(chatId) ?? []
    if (!pending.some((entry) => entry.id === record.id)) waiting.set(chatId, [...pending, record])
    return enqueue(chatId)
  }
}
