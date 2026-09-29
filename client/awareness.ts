import { readRecord } from './shared'
import { buildWork, type WorkItem, type WorkJob } from './work'
const belongsToTerminal = (job: WorkJob, id: string | null): boolean => !!id && readRecord(job).terminalId === id
export function scopedWork(items: WorkItem[], id: string | null): WorkItem[] {
  if (!id) return items
  return items.flatMap(item => {
    const members = item.members?.filter(job => belongsToTerminal(job, id)) ?? []
    return members.length ? [{...item, members}] : []
  })
}
export function activeAgents(jobs: WorkJob[], id: string | null): WorkItem[] {
  const linked = jobs.filter(job => belongsToTerminal(job, id))
  return buildWork(linked).filter(item => item.job && ['running', 'queued'].includes(item.state))
}
