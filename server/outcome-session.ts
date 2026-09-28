import { reportedJobOutcome } from './activity'
import { readLogTail, type JobRecord } from './jobs'
import { checkOutcomes, jobOutcome, type Actor, type CheckedAttempt, type OutcomeDraft } from './outcome-sources'
import type { FileSource, SessionSources, SourceResolver } from './outcomes'

const REPORT_TAIL_BYTES = 65_536
const MAIN_LABEL = 'Main agent'

export type OutcomeRun = { id: string; label: string; terminalId?: string; chatId?: string; attempts: CheckedAttempt[] }
export type OutcomeSessionDeps = {
  terminals: { get(id: string): { engine: string } | undefined; transcriptPath(id: string): Promise<string | null> }
  jobs: { listJobs(): JobRecord[]; logPath(id: string): string }
  runs: { list(): OutcomeRun[] }
  reported?: (logPath: string) => Promise<'done' | 'failed' | null>
}

async function reportedFromLog(path: string): Promise<'done' | 'failed' | null> {
  try {
    return reportedJobOutcome((await readLogTail(path, REPORT_TAIL_BYTES)).content)
  } catch {
    return null
  }
}

export function spawnedJobActor(job: Pick<JobRecord, 'label' | 'engine'>): Actor {
  return { by: 'spawned', label: `Job · ${job.label}`, engine: job.engine }
}

export function createSessionResolver(deps: OutcomeSessionDeps): SourceResolver {
  const reported = deps.reported ?? reportedFromLog
  const settled = new Map<string, OutcomeDraft | null>()

  function logSource(job: JobRecord, actor: Actor): FileSource {
    return { id: `job:${job.id}`, parser: job.engine === 'codex' ? 'codex-exec' : 'claude', path: deps.jobs.logPath(job.id), actor, final: job.status !== 'running' }
  }

  async function settledOutcome(job: JobRecord, actor: Actor): Promise<OutcomeDraft | null> {
    if (job.status === 'running') return null
    if (!settled.has(job.id)) settled.set(job.id, jobOutcome(job, await reported(deps.jobs.logPath(job.id)), actor))
    return settled.get(job.id) ?? null
  }

  async function spawned(jobs: JobRecord[], runs: OutcomeRun[]): Promise<SessionSources> {
    const files: FileSource[] = []
    const records: OutcomeDraft[] = []
    for (const job of jobs) {
      const actor = spawnedJobActor(job)
      files.push(logSource(job, actor))
      const outcome = await settledOutcome(job, actor)
      if (outcome) records.push(outcome)
    }
    for (const run of runs) records.push(...checkOutcomes(run.id, run.attempts, { by: 'spawned', label: `Workflow · ${run.label}`, engine: 'claude' }))
    return { files, records }
  }

  async function terminal(id: string): Promise<SessionSources | null> {
    const record = deps.terminals.get(id)
    if (record === undefined) return null
    const runs = deps.runs.list().filter((run) => run.terminalId === id)
    const runIds = new Set(runs.map((run) => run.id))
    const jobs = deps.jobs.listJobs().filter((job) => job.terminalId === id || (job.workflowRunId !== undefined && runIds.has(job.workflowRunId)))
    const children = await spawned(jobs, runs)
    const path = await deps.terminals.transcriptPath(id)
    const main: FileSource[] = path === null ? [] : [{ id: 'main', parser: record.engine === 'codex' ? 'codex-rollout' : 'claude', path, actor: { by: 'main', label: MAIN_LABEL, engine: record.engine }, subagents: record.engine !== 'codex' }]
    return { files: [...main, ...children.files], records: children.records }
  }

  async function chat(rootId: string): Promise<SessionSources | null> {
    const all = deps.jobs.listJobs()
    const isTurn = (job: JobRecord): boolean => job.purpose === 'chat' && job.threadRoot === rootId
    if (!all.some((job) => job.id === rootId && isTurn(job))) return null
    const turns = all.filter(isTurn)
    const runs = deps.runs.list().filter((run) => run.chatId === rootId)
    const runIds = new Set(runs.map((run) => run.id))
    const others = all.filter((job) => !isTurn(job) && (job.chatId === rootId || job.threadRoot === rootId || (job.workflowRunId !== undefined && runIds.has(job.workflowRunId))))
    const children = await spawned(others, runs)
    const main = turns.map((job) => logSource(job, { by: 'main', label: MAIN_LABEL, engine: job.engine }))
    return { files: [...main, ...children.files], records: children.records }
  }

  return async (key) => {
    const [kind, id] = key.split(':', 2) as [string, string | undefined]
    if (!id) return null
    if (kind === 'terminal') return terminal(id)
    if (kind === 'chat') return chat(id)
    return null
  }
}
