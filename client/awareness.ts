import { readRecord } from './shared'
import { buildWork, type WorkItem, type WorkJob } from './work'
export type TerminalOwner = { id: string; sessionId?: string | null }
function belongsToTerminal(job: WorkJob, owner: TerminalOwner | null): boolean {
  if (!owner) return false
  const { terminalId, terminalSessionId } = readRecord(job)
  return terminalId === owner.id || (!!owner.sessionId && terminalSessionId === owner.sessionId)
}
export function scopedWork(items: WorkItem[], owner: TerminalOwner | null): WorkItem[] {
  if (!owner) return items
  return items.flatMap(item => {
    const members = item.members?.filter(job => belongsToTerminal(job, owner)) ?? []
    return members.length ? [{...item, members}] : []
  })
}
export function activeAgents(jobs: WorkJob[], owner: TerminalOwner | null): WorkItem[] {
  const linked = jobs.filter(job => belongsToTerminal(job, owner))
  return buildWork(linked).filter(item => item.job && ['running', 'queued'].includes(item.state))
}
