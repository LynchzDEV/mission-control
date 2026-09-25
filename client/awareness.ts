import { readRecord, providerName } from './shared'
import { buildWork, reviewable, type WorkItem, type WorkJob } from './work'
import { groupByThread } from './thread-view'
import { STAGES, templateNodeSpecs } from './plan-view'
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
export function activeAgents(jobs: WorkJob[], flows: Record<string, unknown>, id: string | null, cwd: string | null): WorkItem[] {
  if (!id) return []
  const linked = jobs.filter(job => belongsToTerminal(job, id, cwd))
  return buildWork(linked, flows).filter(item => !item.archived && item.job && ['running', 'queued'].includes(item.state))
}
export function selectFlow(items: WorkItem[], previous: string): string { return items.find(item => item.id === previous)?.id ?? items.find(item => item.state === 'running')?.id ?? items[0]?.id ?? '' }
export function awarenessFlows(items: WorkItem[]): WorkItem[] {
  const groups = new Map<string, WorkItem>()
  for (const item of items.filter(item => !item.archived)) {
    const id = item.flowLabel ? `flow:${item.flowLabel}` : item.id
    const existing = groups.get(id)
    if (!existing) groups.set(id, {...item, id, label:item.flowLabel ?? item.label, members:[...(item.members ?? [])]})
    else {
      existing.members = [...new Map([...existing.members ?? [], ...item.members ?? []].map(job => [job.id, job])).values()]
      if (item.state === 'running') existing.state = 'running'
    }
  }
  return [...groups.values()]
}
type FlowStep = { key?:string; title:string; status:string; detail:string; assignee?:string }
export function flowSteps(item: WorkItem): FlowStep[] {
  if (item.plan) return item.plan.steps.map(step => ({...step,detail:({done:'Decided',active:'Working',pending:'Up next',error:'Needs attention'} as Record<string,string>)[step.status] ?? step.status}))
  if (item.members?.length) {
    const members = item.members
    const started = new Map<string,number>()
    for (const job of members) { const root = job.threadRoot || job.id; started.set(root,Math.min(started.get(root) ?? Infinity,job.startedAt)) }
    const threads = groupByThread(members).sort((a,b) => started.get(a.threadRoot)! - started.get(b.threadRoot)!)
    const branches = threads.map(thread => {
      const job = thread.runningJob ?? thread.newestJob
      const title = job.label && job.label !== item.label ? job.label : readRecord(job).reviewOf ? 'Code review' : `${providerName(job.engine)} work`
      return {key:thread.threadRoot,title,status:job.status === 'running' ? 'active' : job.status,assignee:job.engine,detail:({running:'Working',queued:'Queued',done:'Finished',failed:'Failed',killed:'Stopped'} as Record<string,string>)[job.status] ?? job.status}
    })
    const artifacts = members.filter(job => job.diffStat || job.worktree)
    const ready = members.some(reviewable), reviewed = artifacts.length > 0 && artifacts.every(job => job.reviewedAt != null)
    const directed = members.some(job => typeof readRecord(job).prompt === 'string' && String(readRecord(job).prompt).trim())
    return [{key:'direction',title:'Direction',status:directed ? 'done' : 'pending',detail:directed ? 'Decided' : 'Not reported'},...branches,{key:'review',title:'Your review',status:reviewed ? 'done' : 'pending',detail:ready ? 'Ready for you' : reviewed ? 'Reviewed' : 'Up next'}]
  }
  if (item.stages) return templateNodeSpecs(item.stages).map((spec,index) => ({title:['Spec','Implementation','Code review','Verification','Merged'][index]!,status:item.stages![STAGES[index]!]![0],detail:spec.chipText}))
  return item.members?.map(job => ({title:job.label || job.id,status:job.status === 'running' ? 'active' : job.status,assignee:job.engine,detail:`${job.engine} · ${job.status}`})) ?? []
}
export function workingLabel(startedAt: number, now: number): string {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `Working · ${elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}`
}
export function flowColumns(item: WorkItem | undefined): FlowStep[][] {
  const steps = item ? flowSteps(item) : []
  return steps.length < 3 ? steps.map(step => [step]) : [[steps[0]!], steps.slice(1,-1), [steps.at(-1)!]]
}
