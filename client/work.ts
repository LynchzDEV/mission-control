import { groupByThread, sortThreadsByActivity } from './thread-view'
export type WorkJob = { id: string; threadRoot: string; label: string; engine: string; cwd: string; status: string; startedAt: number; endedAt: number | null; diffStat: string; worktree: string | null; reviewedAt: number | null; slowAt?: number | null; turns?: number; reviewOf?: string | null; parentJobId?: string | null }
export type WorkItem = { id: string; label: string; state: string; provider: string; activity: string; job?: WorkJob; members?: WorkJob[] }
export function buildWork(jobs: WorkJob[]): WorkItem[] {
  return sortThreadsByActivity(groupByThread(jobs)).map(thread => {
    const job = thread.runningJob ?? thread.newestJob
    return { id: thread.threadRoot, label: job.label || job.id, state: job.status, provider: job.engine, activity: job.endedAt ? `Finished ${new Date(job.endedAt).toLocaleString()}` : 'Started ' + new Date(job.startedAt).toLocaleString(), job, members: jobs.filter(member => (member.threadRoot || member.id) === thread.threadRoot) }
  })
}
export function reviewable(job?: WorkJob): boolean { return !!job && job.status === 'done' && (!!job.diffStat || !!job.worktree) && job.reviewedAt === null }
