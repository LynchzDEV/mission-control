import { getJson, postJson, readArray, readRecord, errorText, shellQuote, streamJobLog } from './shared'
import { confirmDialog } from './dialog'
import { groupByThread, sortThreadsByActivity, createFullFeed, fetchThread, sendReply, type Feed } from './thread-view'
import { parsePlan, STAGES, type SessionFlow, type StageState, type Plan } from './plan-view'
import { installModelPickers } from './model-picker'
export type WorkJob = { id: string; threadRoot: string; label: string; engine: string; cwd: string; status: string; startedAt: number; endedAt: number | null; diffStat: string; worktree: string | null; reviewedAt: number | null }
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
export function filterWork(items: WorkItem[], filter: string, query: string): WorkItem[] {
  return items.filter(item => (filter === 'archived' ? item.archived : !item.archived) && (filter === 'active' ? ['running','queued','plan'].includes(item.state) : filter === 'review' ? item.members?.some(job => reviewable(job) || (job.status === 'done' && !!job.worktree)) : filter === 'completed' ? ['done','failed','killed'].includes(item.state) : true) && `${item.label} ${item.provider} ${item.job?.cwd ?? ''}`.toLowerCase().includes(query.toLowerCase()))
}
export function chooseWork(items: WorkItem[], selected: string): string { return items.some(item => item.id === selected) ? selected : items[0]?.id ?? '' }
export function readDraft(raw: string | null): Record<string, string | boolean> { try { const value = JSON.parse(raw ?? '{}'); return Object.fromEntries(Object.entries(readRecord(value)).filter(([key,value]) => ['prompt','label','cwd','engine','model','worktree'].includes(key) && (typeof value === 'string' || typeof value === 'boolean'))) as Record<string,string|boolean> } catch { return {} } }
function node(tag: string, text = '', className = ''): HTMLElement { const element = document.createElement(tag); element.textContent = text; element.className = className; return element }
function installWork(): void {
  const root = document.querySelector<HTMLElement>('#work-view')
  if (!root || new URLSearchParams(location.search).get('view') === 'usage') return
  const list = document.querySelector<HTMLElement>('#work-list')!
  const selected = document.querySelector<HTMLElement>('#work-selected')!
  const filter = document.querySelector<HTMLSelectElement>('#work-filter')!
  const search = document.querySelector<HTMLInputElement>('#work-search')!
  const status = document.querySelector<HTMLElement>('#work-status')!
  const form = document.querySelector<HTMLFormElement>('#dispatch-form')
  const messages = new Map<string,string>()
  const pending = new Set<string>()
  const replyPending = new Set<string>()
  const replyInputs = new Map<string, HTMLTextAreaElement>()
  let refreshReply: (() => Promise<void>) | undefined
  let syncLog: (() => void) | undefined
  let logStream: EventSource | null = null
  let items: WorkItem[] = [], active = new URLSearchParams(location.search).get('job') ?? '', feed: Feed | undefined, detailId: string | null | undefined = null, composing = root.dataset.mode === 'compose'
  let loaded = false
  let updateMetadata: ((item: WorkItem) => void) | undefined
  const button = (text: string, action: () => void): HTMLButtonElement => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = text; b.onclick = action; return b }
  async function action(path: string, message: HTMLElement): Promise<void> {
    const id = active
    if (pending.has(id)) return
    pending.add(id); message.textContent = 'Saving…'
    const result = await postJson(path, {})
    pending.delete(id)
    const files = Array.isArray(result.data.files) ? result.data.files.filter(value => typeof value === 'string') : []
    const feedback = result.ok ? path.endsWith('/land') ? `Landed on ${str(result.data.base)}: ${Array.isArray(result.data.landed) ? result.data.landed.join(', ') || 'no new commits' : ''}` : 'Saved' : [errorText(result), ...files].join(' · ')
    messages.set(id,feedback); message.textContent = feedback
    if (result.ok) await refresh()
  }
  function detail(item?: WorkItem): void {
    if (form) form.hidden = !composing
    selected.hidden = composing
    if (composing) return
    if (detailId === item?.id) { if (item) updateMetadata?.(item); syncLog?.(); void feed?.refresh(); void refreshReply?.(); return }
    detailId = item?.id; feed?.stop(); feed = undefined; logStream?.close(); logStream = null; syncLog = undefined; refreshReply = undefined; updateMetadata = undefined; selected.replaceChildren()
    if (!item) { selected.append(node('h2', 'No work selected'), node('p', 'Choose another filter or create a new job.')); return }
    const metadata = node('div')
    const message = node('div', messages.get(item.id) ?? '', 'work-feedback'); message.setAttribute('role','status'); message.setAttribute('aria-live','polite')
    selected.append(metadata, message)
    let metadataSignature = ''
    updateMetadata = item => {
      const next = JSON.stringify([item.label, item.provider, item.state, item.activity, item.job?.id, item.job?.cwd, item.flowLabel, item.archived, item.plan, item.members?.map(job => [job.id, job.label, job.cwd, job.status, job.diffStat, job.worktree, job.reviewedAt])])
      if (next === metadataSignature) return
      metadataSignature = next
      const scroller = selected.parentElement
      const scrollTop = scroller?.scrollTop
      metadata.replaceChildren()
    metadata.append(node('h1', item.label), node('p', `${item.provider} · ${item.state}`), node('p', item.job?.cwd ?? 'Manual plan only', 'work-path'))
    if (item.flowLabel) metadata.append(button(item.archived ? 'Restore plan' : 'Archive plan', () => void action(`/api/flow/${encodeURIComponent(item.flowLabel!)}/${item.archived ? 'unarchive' : 'archive'}`, message)))
    if (item.plan) { const plan = node('section', '', 'ordered-plan'); plan.append(node('h2','Manual plan')); const steps = node('ol'); for (const step of item.plan.steps) steps.append(node('li', `${step.title} — ${step.assignee} · ${step.status}`)); plan.append(steps); if (item.plan.next) plan.append(node('p', `Next: ${item.plan.next}`)); metadata.append(plan) }
    const job = item.job
    if (!job) { metadata.append(node('p', item.activity || 'This plan has no linked conversation.')); return }
    for (const job of item.members ?? []) {
      if (!job.diffStat && !job.worktree) continue
      const review = node('section', '', 'work-review'); review.append(node('h2',`Changes · ${job.label || job.id}`), node('small',job.id), node('pre', job.diffStat || 'No diff summary reported.'))
      review.append(button('Copy review command', () => { const cmd = `cd ${shellQuote(job.cwd)} && claude --continue`; void navigator.clipboard.writeText(cmd).then(() => { message.textContent = 'Review command copied' }).catch(() => { message.textContent = cmd }) }))
      if (reviewable(job)) review.append(button('Mark reviewed', () => void action(`/api/jobs/${job.id}/reviewed`, message)))
      else if (job.reviewedAt) review.append(node('p','Review acknowledged'))
      if (job.worktree && job.status === 'done') { const landing = node('details'); landing.append(node('summary','Land worktree'), node('p', job.worktree)); landing.append(button('Land changes', () => { void confirmDialog(`Land ${job.label} onto its base branch? This changes the base checkout.`, { confirmLabel: 'Land changes' }).then(ok => { if (ok) void action(`/api/jobs/${job.id}/land`, message) }) })); review.append(landing) }
      metadata.append(review)
    }
    if (job.status === 'running') metadata.append(button('Stop job', () => { void confirmDialog(`Stop ${job.label}?`, { confirmLabel: 'Stop job', danger: true }).then(ok => { if (ok) void action(`/api/jobs/${job.id}/kill`, message) }) }))
      if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop
    }
    updateMetadata(item)
    if (!item.job) return
    const log = document.createElement('details'); log.className = 'work-log'; log.append(node('summary','Raw job output')); const output = node('pre'); log.append(output)
    let logJobId = ''
    syncLog = () => {
      const id = log.open ? items.find(current => current.id === item.id)?.job?.id ?? item.job!.id : ''
      if (id === logJobId) return
      logStream?.close(); logStream = null; logJobId = id
      if (!id) return
      output.textContent = ''
      logStream = streamJobLog(id,line => { if (logJobId === id) output.textContent += line + '\n' },() => { if (logJobId === id) output.textContent += '[stream closed]\n' })
    }
    log.ontoggle = syncLog
    selected.append(log, node('h2','Conversation'))
    feed = createFullFeed(item.id); selected.append(feed.root); feed.start()
    const reply = document.createElement('form'); reply.className = 'reply-composer'; const input = document.createElement('textarea'); input.setAttribute('aria-label','Reply to this work'); input.placeholder = 'Reply to continue this conversation'; input.required = true
    const send = button('Send reply', () => {}); send.type = 'submit'; input.disabled = true; send.disabled = true; reply.append(input, send); selected.append(reply)
    const key = `mc.reply.${item.id}`; try { input.value = localStorage.getItem(key) ?? '' } catch {}
    input.oninput = () => { try { localStorage.setItem(key,input.value) } catch {} }
    replyInputs.set(item.id, input)
    refreshReply = async () => {
      const model = await fetchThread(item.id)
      if (active !== item.id || !selected.contains(reply)) return
      input.disabled = !model?.canReply; send.disabled = replyPending.has(item.id) || !model?.canReply
      if (!model) message.textContent = 'Conversation unavailable. Retrying automatically.'
      else if (!model.canReply) message.textContent = 'Reply becomes available when the engine reports a session.'
      else if (message.textContent.startsWith('Conversation unavailable') || message.textContent.startsWith('Reply becomes')) message.textContent = ''
    }
    void refreshReply()
    reply.onsubmit = async event => { event.preventDefault(); if (send.disabled || replyPending.has(item.id)) return; const submitted = input.value; replyPending.add(item.id); send.disabled = true; message.textContent = 'Sending…'; const error = await sendReply(item.id,submitted); replyPending.delete(item.id); send.disabled = false; message.textContent = error || 'Reply sent'; if (!error) { const currentInput = replyInputs.get(item.id); if (currentInput?.value === submitted) currentInput.value = ''; try { if (localStorage.getItem(key) === submitted) localStorage.removeItem(key) } catch {}; if (active === item.id) await feed?.refresh() }; if (active === item.id) void refreshReply?.() }
  }
  function paint(): void { const visible = filterWork(items,filter.value,search.value); if (loaded) active = chooseWork(visible,active); list.replaceChildren(); if (!visible.length) list.append(node('p','No work matches this view.')); for (const item of visible) { const entry = button('', () => { active = item.id; composing = false; paint() }); entry.className = 'work-entry'; entry.setAttribute('aria-pressed',String(active === item.id && !composing)); entry.append(node('strong', item.label), node('span', `${item.state} · ${item.provider}`), node('small',item.activity || 'No activity reported')); list.append(entry) }; detail(visible.find(item => item.id === active)) }
  async function refresh(): Promise<void> { const [jobs,flow] = await Promise.all([getJson('/api/jobs'),getJson('/api/flow?includeArchived=1')]); if (!jobs.ok || !flow.ok) { status.textContent = `Could not load ${!jobs.ok ? 'jobs' : 'plans'}: ${errorText(!jobs.ok ? jobs : flow)}. Retrying automatically.`; if (!items.length) list.textContent = 'Work unavailable'; return }; items = buildWork(readArray(jobs.data.jobs).map(raw => ({ ...raw, id: str(raw.id), threadRoot: str(raw.threadRoot) || str(raw.id) } as WorkJob)),readRecord(flow.data.sessions)); loaded = true; status.textContent = ''; paint() }
  search.oninput = paint; filter.onchange = () => { composing = false; paint() }
  if (form) {
    const key = 'mc.job.draft.v1'; let draft: Record<string,string|boolean> = {}; try { draft = readDraft(localStorage.getItem(key)) } catch {}
    for (const [name,value] of Object.entries(draft)) { const field = form.elements.namedItem(name) as HTMLInputElement | null; if (field) { if (field.type === 'checkbox') field.checked = value === true; else field.value = String(value) } }
    const saveDraft = () => { const data = Object.fromEntries(new FormData(form)); try { localStorage.setItem(key,JSON.stringify({ ...data, worktree: data.worktree === 'on' })) } catch {} }
    form.oninput = saveDraft; form.onchange = saveDraft
    document.querySelector('#draft-clear')?.addEventListener('click', () => { form.reset(); try { localStorage.removeItem(key) } catch {} })
    form.onsubmit = async event => { event.preventDefault(); const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!; if (submit.disabled) return; submit.disabled = true; const message = document.querySelector<HTMLElement>('#dispatch-msg')!; message.textContent = 'Creating job…'; const data = Object.fromEntries(new FormData(form)); const submitted = JSON.stringify(data); let savedDraft: string | null = null; try { savedDraft = localStorage.getItem(key) } catch {}; const result = await postJson('/api/jobs',{ ...data, model: data.model || undefined, worktree: data.worktree === 'on' }); submit.disabled = false; message.textContent = result.ok ? 'Job created' : errorText(result); if (result.ok) { const job = readRecord(result.data.job ?? result.data); active = str(job.threadRoot) || str(job.id); composing = false; filter.value = 'all'; search.value = ''; try { if (localStorage.getItem(key) === savedDraft) localStorage.removeItem(key) } catch {}; if (JSON.stringify(Object.fromEntries(new FormData(form))) === submitted) form.reset(); await refresh() } }
  }
  addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'mc:new-job' || !form) return
    composing = true
    paint()
  })
  installModelPickers()
  paint(); void refresh(); setInterval(() => { if (!document.hidden) void refresh() },5000)
}
if (typeof document !== 'undefined') installWork()
