import { readRecord } from './shared'
import { groupByThread, sortThreadsByActivity } from './thread-view'
import { parsePlan, STAGES, type SessionFlow, type StageState, type Plan } from './plan-view'
export type WorkJob = { id: string; threadRoot: string; label: string; engine: string; cwd: string; status: string; startedAt: number; endedAt: number | null; diffStat: string; worktree: string | null; reviewedAt: number | null; slowAt?: number | null; turns?: number; reviewOf?: string | null; parentJobId?: string | null }
export type WorkItem = { id: string; label: string; state: string; provider: string; activity: string; job?: WorkJob; members?: WorkJob[]; plan: Plan | null; flowLabel?: string; stages?: SessionFlow | null; archived: boolean }
const str = (value: unknown): string => typeof value === 'string' ? value : ''
function parseStages(raw: Record<string, unknown>): SessionFlow | null {
  const stages: SessionFlow = {}
  for (const stage of STAGES) {
    const pair = raw[stage]
    if (!Array.isArray(pair) || !['done','active','queued','future','error'].includes(pair[0])) return null
    stages[stage] = [pair[0] as StageState, typeof pair[1] === 'string' ? pair[1] : '']
  }
  return stages
}
export function buildWork(jobs: WorkJob[], flows: Record<string, unknown>): WorkItem[] {
  const used = new Set<string>()
  const items = sortThreadsByActivity(groupByThread(jobs)).map(thread => {
    const job = thread.runningJob ?? thread.newestJob
    const match = Object.entries(flows).find(([label, value]) => { const flow = readRecord(value); return jobs.some(member => (member.threadRoot || member.id) === thread.threadRoot && member.id === flow.activityJobId) || label === (job.label.trim() || job.id) })
    if (match) used.add(match[0])
    const flow = readRecord(match?.[1])
    return { id: thread.threadRoot, label: job.label || job.id, state: job.status, provider: job.engine, activity: (flow.activityJobId === job.id ? str(flow.currentActivity) : '') || (job.endedAt ? `Finished ${new Date(job.endedAt).toLocaleString()}` : 'Started ' + new Date(job.startedAt).toLocaleString()), job, members: jobs.filter(member => (member.threadRoot || member.id) === thread.threadRoot), plan: parsePlan(flow.plan), flowLabel: match?.[0], stages: parseStages(flow), archived: flow.archived === true }
  })
  for (const [label, raw] of Object.entries(flows)) {
    if (used.has(label)) continue
    const flow = readRecord(raw)
    items.push({ id: `plan:${label}`, label, state: flow.finished ? 'done' : 'plan', provider: 'Manual plan', activity: str(flow.currentActivity), plan: parsePlan(flow.plan), flowLabel: label, stages: parseStages(flow), archived: flow.archived === true } as typeof items[number])
  }
  return items
}
export function reviewable(job?: WorkJob): boolean { return !!job && job.status === 'done' && (!!job.diffStat || !!job.worktree) && job.reviewedAt === null }
