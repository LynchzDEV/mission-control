import { getJson, readArray, readRecord, errorText } from './shared'
import { buildWork, reviewable, type WorkItem, type WorkJob } from './work'
import { createMiniFeed, groupByThread, type MiniFeed } from './thread-view'
import { STAGES, templateNodeSpecs } from './plan-view'
import { icon, providerName } from './terminal-view'
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
export function connectorPath(x1: number, y1: number, x2: number, y2: number, bend: number): string {
  if (y1 === y2) return `M${x1} ${y1}H${x2}`
  const radius = Math.min(8, Math.abs(y2 - y1) / 2), direction = y2 > y1 ? 1 : -1
  return `M${x1} ${y1}H${bend - radius}Q${bend} ${y1} ${bend} ${y1 + radius * direction}V${y2 - radius * direction}Q${bend} ${y2} ${bend + radius} ${y2}H${x2}`
}
export function flowColumns(item: WorkItem | undefined): FlowStep[][] {
  const steps = item ? flowSteps(item) : []
  return steps.length < 3 ? steps.map(step => [step]) : [[steps[0]!], steps.slice(1,-1), [steps.at(-1)!]]
}
function renderFlow(flow: HTMLElement, columns: FlowStep[][]): {disconnect():void; update(columns:FlowStep[][]):void} {
  const graph = element('div', '', 'flow-graph')
  graph.style.setProperty('--flow-columns', String(columns.length))
  graph.dataset.columns = String(columns.length)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'flow-connections'); svg.setAttribute('aria-hidden', 'true')
  graph.append(svg)
  const nodes = columns.map(steps => {
    const column = element('div', '', 'flow-branches'); graph.append(column)
    return steps.map(step => {
      const node = element('div', '', `flow-node ${step.status}${step.status === 'active' ? ' working' : ''}`)
      node.dataset.engine = step.assignee ?? ''
      const copy = element('span', '', 'node-copy')
      copy.append(element('strong', step.title), element('small', step.detail))
      node.title = `${step.title} · ${step.status}${step.detail ? ` · ${step.detail}` : ''}`
      node.setAttribute('role', 'group'); node.setAttribute('aria-label', node.title)
      const mark = element('span', step.status === 'done' ? '✓' : ['error','failed','killed'].includes(step.status) ? '!' : step.status === 'queued' ? '·' : '', 'node-mark')
      mark.setAttribute('aria-hidden', 'true'); node.append(mark, copy); column.append(node)
      return {node, mark, step, copy}
    })
  })
  flow.append(graph)
  const measure = () => {
    const bounds = graph.getBoundingClientRect()
    svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`)
    svg.replaceChildren()
    for (let i = 1; i < nodes.length; i++) for (const from of nodes[i - 1]!) for (const to of nodes[i]!) {
      const start = from.mark.getBoundingClientRect(), end = to.mark.getBoundingClientRect()
      const x1 = start.right - bounds.left, y1 = start.top + start.height / 2 - bounds.top
      const x2 = end.left - bounds.left, y2 = end.top + end.height / 2 - bounds.top
      const exit = Math.max(...nodes[i - 1]!.map(({node}) => node.getBoundingClientRect().right)) - bounds.left
      const d = connectorPath(x1, y1, x2, y2, Math.max(exit + 12, x2 - bounds.width * .1))
      const path = document.createElementNS(svg.namespaceURI!, 'path')
      path.setAttribute('d', d); path.setAttribute('class', from.step.status === 'done' ? 'complete' : '')
      svg.append(path)
      const active = to.step.status === 'active' ? to : from.step.status === 'active' ? from : null
      if (active) {
        const signal = document.createElementNS(svg.namespaceURI!, 'path')
        signal.setAttribute('d', d); signal.setAttribute('class', 'signal'); signal.setAttribute('data-engine', active.step.assignee ?? '')
        svg.append(signal)
      }
    }
  }
  const observer = new ResizeObserver(measure)
  observer.observe(graph)
  for (const column of nodes) for (const {node} of column) observer.observe(node)
  measure()
  return {disconnect:() => observer.disconnect(), update(next) {
    nodes.forEach((column,i) => column.forEach((entry,j) => {
      const step = next[i]![j]!; entry.step = step
      entry.node.className = `flow-node ${step.status}${step.status === 'active' ? ' working' : ''}`
      entry.node.dataset.engine = step.assignee ?? ''
      entry.node.title = `${step.title} · ${step.status} · ${step.detail}`; entry.node.setAttribute('aria-label', entry.node.title)
      entry.copy.children[0]!.textContent = step.title; entry.copy.children[1]!.textContent = step.detail
      entry.mark.textContent = step.status === 'done' ? '✓' : ['error','failed','killed'].includes(step.status) ? '!' : step.status === 'queued' ? '·' : ''
    })); measure()
  }}
}
function element(tag: string, text = '', className = ''): HTMLElement { const node = document.createElement(tag); node.textContent = text; node.className = className; return node }
function install(): void {
  const select = document.querySelector<HTMLSelectElement>('#awareness-select')
  if (!select) return
  const flow = document.querySelector<HTMLElement>('#awareness-flow')!, status = document.querySelector<HTMLElement>('#awareness-status')!
  flow.tabIndex = 0; flow.setAttribute('role', 'region'); flow.setAttribute('aria-label', 'Work flow steps')
  const collection = document.querySelector<HTMLElement>('#active-agent-windows')!, agentStatus = document.querySelector<HTMLElement>('#active-agent-status')!
  const rails = [document.querySelector<HTMLElement>('#active-agents-left')!, document.querySelector<HTMLElement>('#active-agents-right')!]
  type Card = { root: HTMLDetailsElement; label: HTMLElement; state: HTMLElement; activity: HTMLElement; count:HTMLElement; host: HTMLElement; feed?: MiniFeed; jobId: string }
  const cards = new Map<string, Card>()
  let items: WorkItem[] = [], jobs: WorkJob[] = [], flows: Record<string, unknown> = {}, unavailable = false
  let scopeId: string | null = null, cwd: string | null = null, current = '', signature = '', generation = 0
  function paintAgents(): void {
    if (unavailable) {
      agentStatus.textContent = 'Agent activity unavailable. Retrying…'
      for (const card of cards.values()) {
        card.feed?.stop(); card.feed = undefined; card.jobId = ''; card.host.replaceChildren()
        card.activity.textContent = ''; card.host.textContent = 'Activity unavailable. Retrying…'; card.state.textContent = 'Unavailable'; card.root.dataset.running = 'false'
      }
      return
    }
    const threads = activeAgents(jobs, flows, scopeId, cwd)
    const wanted = new Set(threads.map(item => item.id))
    for (const [id, card] of cards) {
      if (wanted.has(id)) continue
      card.feed?.stop(); card.root.remove(); cards.delete(id)
    }
    agentStatus.textContent = !scopeId ? 'Select a terminal to see its active agents.' : threads.length ? `${threads.length} active agent${threads.length === 1 ? '' : 's'}` : 'No active agents for this terminal.'
    collection.dataset.active = String(threads.length > 0)
    for (const [index,item] of threads.entries()) {
      let card = cards.get(item.id)
      if (!card) {
        const root = document.createElement('details'); root.className = 'agent-window'; root.open = true; root.dataset.thread = item.id
        const summary = element('summary'), bars = element('span', '', 'activity-bars')
        bars.setAttribute('aria-hidden', 'true')
        for (let i = 0; i < 4; i++) bars.append(element('i'))
        const label = element('span', '', 'agent-label'), state = element('span', '', 'agent-model')
        summary.append(bars, label, state, icon('chevron'))
        const output = element('div', '', 'agent-output'), activity = element('span', '', 'activity-text'), host = element('div', '', 'agent-feed')
        const footer = element('div', '', 'agent-footer')
        const open = document.createElement('button'); open.type = 'button'; open.className = 'agent-open'; open.textContent = 'Open conversation ↗'
        open.title = 'Open conversation'; open.setAttribute('aria-label', `Open conversation for ${item.label}`)
        open.onclick = () => {
          const current = activeAgents(jobs, flows, scopeId, cwd).find(thread => thread.id === item.id)
          if (current) dispatchEvent(new CustomEvent('mc:agent-open', {detail:{id:current.id,label:current.label,engine:current.provider,elapsed:current.state}}))
        }
        footer.append(activity, open); output.append(host, footer); root.append(summary, output)
        card = {root, label, state, activity, count:open, host, jobId:''}
        cards.set(item.id, card)
        const rail = rails[0]!.children.length <= rails[1]!.children.length ? rails[0]! : rails[1]!
        rail.append(root)
      }
      const elapsed = Math.max(0,Math.floor((Date.now() - item.job!.startedAt)/1000))
      card.label.textContent = item.label; card.label.title = item.label; card.state.textContent = providerName(item.provider)
      card.count.setAttribute('aria-label', `Open conversation for ${item.label}`)
      card.activity.textContent = item.state === 'queued' ? 'Queued' : `Working · ${elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed/60)}m ${elapsed%60}s`}`
      card.count.textContent = `Agent ${index+1} of ${threads.length}`
      card.root.dataset.engine = item.provider; card.root.dataset.running = String(item.state === 'running')
      if (card.jobId !== item.job!.id) {
        card.feed?.stop(); card.host.replaceChildren(); card.host.textContent = ''; card.jobId = item.job!.id
        card.feed = createMiniFeed(item.id, {onOpen:() => card!.host.parentElement?.querySelector<HTMLButtonElement>('.agent-open')?.click(), activityJobId:item.job!.id})
        card.host.append(card.feed.root); card.feed.start()
      } else void card.feed?.refresh()
    }
  }
  const options = (target: HTMLSelectElement, entries: WorkItem[], value: string, empty: string): void => {
    const next = JSON.stringify(entries.map(item => [item.id,item.label]))
    if (target.dataset.shape !== next) { target.replaceChildren(); for (const item of entries) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; target.append(option) }; if (!entries.length) { const option = document.createElement('option'); option.textContent = empty; option.value = ''; target.append(option) }; target.dataset.shape = next }
    target.value = value; target.disabled = !entries.length
  }
  let flowObserver: ReturnType<typeof renderFlow> | undefined
  function paint(): void {
    const scoped = scopedWork(buildWork(scopeId || cwd ? jobs.filter(job => belongsToTerminal(job,scopeId,cwd)) : jobs,flows), scopeId,cwd).filter(item => !item.archived)
    const groups = awarenessFlows(scoped)
    current = selectFlow(groups, current)
    options(select!, groups, current, 'No linked work')
    const item = groups.find(item => item.id === current)
    const columns = flowColumns(item), steps = columns.flat(), active = (item?.members ?? []).filter(job => job.status === 'running').length
    status.textContent = steps.length ? `Work flow · ${active ? `${active} agent${active === 1 ? '' : 's'} working` : steps.every(step => step.status === 'done') ? 'Completed' : steps.some(step => ['error','failed','killed'].includes(step.status)) ? 'Needs attention' : steps.some(step => step.status === 'queued') ? 'Queued' : 'No agents working'}` : item ? 'Work flow · No steps' : scopeId || cwd ? 'No work linked to this session' : 'No work yet'
    status.title = item?.plan?.next ?? ''
    const link = document.querySelector<HTMLAnchorElement>('#awareness-open')!; link.href = item ? `/lanes?job=${encodeURIComponent(item.job?.threadRoot || item.job?.id || (item.flowLabel ? `plan:${item.flowLabel}` : item.id))}` : '/dispatch'; link.textContent = item ? 'Open work ↗' : 'New job ↗'
    const shape = JSON.stringify([item?.id,columns.map(column => column.map(step => step.key ?? step.title))])
    if (shape !== signature) {
      signature = shape; flowObserver?.disconnect(); flowObserver = undefined; flow.replaceChildren()
      if (steps.length) flowObserver = renderFlow(flow, columns)
      else flow.append(element('p',item ? 'No steps reported for this work.' : 'Select a session or create work to see its flow.','flow-empty'))
    } else flowObserver?.update(columns)
    paintAgents()
  }
  select.onchange = () => { current = select.value; paint() }
  addEventListener('mc:terminal-scope', event => {
    const detail = (event as CustomEvent<{id:string|null;cwd:string|null}>).detail
    if (scopeId === detail.id && cwd === detail.cwd) return
    for (const card of cards.values()) { card.feed?.stop(); card.root.remove() }
    cards.clear(); scopeId = detail.id; cwd = detail.cwd; current = ''; paint()
  })
  async function refresh(): Promise<void> {
    const request = ++generation
    const [jobResult, flowResult] = await Promise.all([getJson('/api/jobs'),getJson('/api/flow?includeArchived=1')])
    if (request !== generation) return
    unavailable = !jobResult.ok || !flowResult.ok
    if (unavailable) { status.textContent = `Work unavailable: ${errorText(!jobResult.ok ? jobResult : flowResult)}. Retrying…`; paintAgents(); return }
    jobs = readArray(jobResult.data.jobs).map(job => ({...job,threadRoot:job.threadRoot || job.id}) as WorkJob)
    flows = readRecord(flowResult.data.sessions)
    items = buildWork(jobs, flows); paint()
  }
  void refresh(); setInterval(() => { if (!document.hidden) void refresh() },3000)
}
if (typeof document !== 'undefined') install()
