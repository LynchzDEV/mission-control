import { oneLine, parseThread, reportedJobOutcome } from './activity'
import type { ChatQueue, ChatQueueItem } from './chat-queue'
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

export const RESTART_CATCH_UP = '[Mission Control restarted — catching up]'

export type ChatFlusherOptions = {
  queue: ChatQueue
  logReader: () => Promise<LogReader>
  notify?: (title: string, body: string) => Promise<void>
  retryMs?: number
  retryLimit?: number
  schedule?: (retry: () => Promise<void>, ms: number) => void
}

export type ChatFlusher = {
  kick(chatId: string): Promise<void>
  onAgentSettled(record: JobRecord): Promise<void>
  recoverAll(): Promise<void>
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

export function needsReport(job: JobRecord): boolean {
  return Boolean(job.chatId) && job.status !== 'running' && !job.workflowRunId && job.reportedAt === null
}

type Reported = { record: JobRecord; report: AgentReport }

function turnPrompt(users: readonly ChatQueueItem[], reports: readonly Reported[], catchingUp: boolean): string {
  const block = reports.length === 0 ? '' : `${catchingUp ? `${RESTART_CATCH_UP}\n` : ''}${reports.map(({ report }) => report.message).join('\n\n')}`
  return [users.map((item) => item.text).join('\n\n'), block].filter((part) => part !== '').join('\n\n')
}

export function createChatFlusher(manager: JobManager, resolver: EngineResolver, opts: ChatFlusherOptions): ChatFlusher {
  const retryMs = opts.retryMs ?? REPORT_RETRY_MS
  const retryLimit = opts.retryLimit ?? REPORT_RETRY_LIMIT
  const schedule = opts.schedule ?? ((retry, ms) => { setTimeout(() => void retry().catch(() => {}), ms) })
  const bootAt = Date.now()
  const seen = new Set<string>()
  const attempts = new Map<string, number>()
  const scheduled = new Set<string>()
  const chains = new Map<string, Promise<void>>()

  const chatRootFor = (chatId: string): JobRecord | undefined => {
    const root = manager.getJob(chatId)
    return root && root.purpose === 'chat' && threadRootOf(root) === root.id ? root : undefined
  }

  const unreported = (chatId: string): JobRecord[] => manager.listJobs().filter((job) => job.chatId === chatId && needsReport(job))
  const settledBeforeBoot = (job: JobRecord): boolean => !seen.has(job.id) && (job.endedAt ?? 0) < bootAt
  const labels = (records: readonly JobRecord[]): string => records.map((record) => record.label).join(', ')

  const kick = (chatId: string): Promise<void> => {
    const next = (chains.get(chatId) ?? Promise.resolve()).then(() => flush(chatId)).catch((error) => console.error(`chat queue for ${chatId} failed`, error))
    chains.set(chatId, next)
    return next
  }

  const needsYouNotice = async (root: JobRecord, reports: readonly Reported[]): Promise<void> => {
    const needing = reports.filter(({ report }) => report.needsYou).map(({ record }) => record.label)
    if (needing.length > 0) await opts.notify?.('Needs you', `${root.label} · ${needing.join(', ')}`)
  }

  const markReported = async (reports: readonly Reported[]): Promise<void> => {
    const at = Date.now()
    for (const { record } of reports) await manager.updateJob(record.id, { reportedAt: at })
  }

  const noSession = async (root: JobRecord, reports: readonly Reported[]): Promise<void> => {
    await markReported(reports)
    for (const { record } of reports) console.error(`chat report dropped: chat ${root.id} agent ${record.label} (chat has no session to resume)`)
    await needsYouNotice(root, reports)
  }

  const holdForUser = async (root: JobRecord, agents: readonly JobRecord[]): Promise<void> => {
    console.error(`chat report held: chat ${root.id} reached ${AGENT_ROUNDS_MAX} agent rounds without a user turn (${labels(agents)})`)
    await opts.notify?.('Needs you', `${root.label} · waiting for you after ${AGENT_ROUNDS_MAX} agent rounds`)
  }

  const wait = (root: JobRecord, agents: readonly JobRecord[], hasUserMessages: boolean): void => {
    if (scheduled.has(root.id)) return
    const attempt = attempts.get(root.id) ?? 0
    if (!hasUserMessages && attempt >= retryLimit) {
      if (attempt === retryLimit) console.error(`chat report still waiting: chat ${root.id} stayed busy after ${retryLimit} retries (${labels(agents)}); it goes out when the chat is next idle`)
      attempts.set(root.id, attempt + 1)
      return
    }
    attempts.set(root.id, attempt + 1)
    scheduled.add(root.id)
    schedule(() => {
      scheduled.delete(root.id)
      return kick(root.id)
    }, retryMs)
  }

  const flush = async (chatId: string): Promise<void> => {
    const root = chatRootFor(chatId)
    if (root === undefined) return
    const agents = unreported(chatId)
    const hasUserMessages = opts.queue.list(chatId).length > 0
    if (agents.length === 0 && !hasUserMessages) {
      attempts.delete(chatId)
      return
    }
    if (threadIsRunning(threadChain(manager.listJobs(), chatId))) return wait(root, agents, hasUserMessages)
    const readLog = await opts.logReader()
    const reports = await Promise.all(agents.map(async (record) => ({ record, report: agentReport(record, await readLog(record.id)) })))
    const memory = root.project ? await projectMemory(manager.listJobs(), root.project, chatId, readLog) : ''
    const chain = threadChain(manager.listJobs(), chatId)
    if (threadIsRunning(chain)) return wait(root, agents, hasUserMessages)
    const sessionId = replySessionId(chain)
    const last = chain[chain.length - 1]
    if (sessionId === null || last === undefined) return noSession(root, reports)
    const users = await opts.queue.take(chatId)
    if (users.length === 0 && agentRoundsSinceUser(chain) >= AGENT_ROUNDS_MAX) return holdForUser(root, agents)
    const created = await manager.createJob({
      engine: root.engine,
      cwd: root.cwd,
      prompt: turnPrompt(users, reports, reports.some(({ record }) => settledBeforeBoot(record))),
      label: root.label,
      parentJobId: last.id,
      threadRoot: chatId,
      resumeSessionId: sessionId,
      purpose: 'chat',
      source: users.length > 0 ? 'user' : 'agent',
      edit: root.edit ?? false,
      project: root.project ?? null,
      memory,
      ...(root.model === null ? {} : { model: root.model }),
    }, resolver)
    if (!created.ok) {
      await opts.queue.restore(chatId, users)
      console.error(`chat turn not started: chat ${chatId} (${created.error}); ${users.length} message(s) and ${reports.length} report(s) stay queued`)
      return
    }
    attempts.delete(chatId)
    await markReported(reports)
    await needsYouNotice(root, reports)
  }

  return {
    kick,
    onAgentSettled(record) {
      if (!record.chatId || record.workflowRunId) return Promise.resolve()
      seen.add(record.id)
      return kick(record.chatId)
    },
    async recoverAll() {
      const chats = new Set([...opts.queue.chats(), ...manager.listJobs().filter(needsReport).map((job) => job.chatId as string)])
      await Promise.all([...chats].map(kick))
    },
  }
}
