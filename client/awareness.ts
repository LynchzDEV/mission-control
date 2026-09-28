import { readRecord } from './shared'
import { buildWork, type WorkItem, type WorkJob } from './work'
function belongsToTerminal(job: WorkJob, id: string | null, cwd: string | null): boolean {
  const terminalId = readRecord(job).terminalId
  return terminalId ? terminalId === id : !!cwd && (job.cwd === cwd || job.cwd.startsWith(`${cwd}/`))
}
export function scopedWork(items: WorkItem[], id: string | null, cwd: string | null): WorkItem[] {
  if (!id && !cwd) return items
  return items.flatMap(item => {
    const members = item.members?.filter(job => belongsToTerminal(job, id, cwd)) ?? []
    return members.length ? [{...item, members}] : []
  })
}
export function activeAgents(jobs: WorkJob[], id: string | null, cwd: string | null): WorkItem[] {
  if (!id) return []
  const linked = jobs.filter(job => belongsToTerminal(job, id, cwd))
  return buildWork(linked).filter(item => item.job && ['running', 'queued'].includes(item.state))
}
