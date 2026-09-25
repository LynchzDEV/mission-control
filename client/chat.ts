import { renderMarkdown } from './markdown'
import { errorText, getJson, postJson, readArray } from './shared'
import { launchChoice, type LaunchProvider } from './shell-launch'
import { chatSignal, historyAction, historyDay, historyLabel, teamRows, titleFrom, turnsFrom, workedLine, type AgentJob, type HistoryItem, type TeamRow, type ThreadMessage, type Turn, type TurnJob } from './chat-view'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const RUNNING_POLL_MS = 2000
const IDLE_POLL_MS = 5000
const ENGINE_COLORS: Record<string, string> = { claude: '#d4a091', glm: '#91b0dc', codex: '#bfd38b' }
const composer = $('composer') as HTMLFormElement
const message = $('message') as HTMLTextAreaElement
const send = composer.querySelector('.send') as HTMLButtonElement
const messages = $('messages')
const stage = document.querySelector('.stage') as HTMLElement
const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }

let root: string | null = null
let running = false
let pollTimer = 0
let generation = 0
let providers: LaunchProvider[] = []
let agents: AgentJob[] = []

function show(screen: 'welcome' | 'conversation' | 'history'): void {
  dispatchEvent(new CustomEvent('quiet:show', { detail: screen }))
}

function setUrl(chat: string | null): void {
  const url = new URL(location.href)
  if (chat) url.searchParams.set('chat', chat); else url.searchParams.delete('chat')
  url.hash = ''
  history.replaceState(null, '', url)
}

function setRunning(on: boolean): void {
  running = on
  send.disabled = on
  send.title = on ? 'Waiting for the reply' : 'Send message'
}

function chatError(text: string): void {
  const last = messages.lastElementChild
  if (last instanceof HTMLElement && last.className === 'chat-error') { last.textContent = text; return }
  const line = document.createElement('p')
  line.className = 'chat-error'
  line.textContent = text
  messages.append(line)
}
function clearChatError(): void { messages.querySelectorAll('.chat-error').forEach(node => node.remove()) }

function engineName(engine: string): string {
  return providers.find(item => item.id === engine)?.name ?? engine
}

function elapsed(row: TeamRow, now: number): string {
  const seconds = Math.max(0, Math.round(((row.ended ?? now) - row.started) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}

function stateText(row: TeamRow, now: number): string {
  if (row.state === 'running') return `Running · ${elapsed(row, now)}`
  if (row.state === 'reviewing') return 'In review'
  if (row.state === 'landed') return 'Landed'
  if (row.state === 'needs-you') return 'Needs you'
  if (row.state === 'retried') return 'Retried'
  if (row.state === 'stopped') return 'Stopped'
  return 'Done'
}

function teamCard(rows: TeamRow[], project: string | null): HTMLElement {
  const card = ($('team-card') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement
  const now = Date.now()
  card.querySelector('header .muted')!.textContent = `${rows.length} agent${rows.length === 1 ? '' : 's'}${project ? ` · ${project.split('/').pop()}` : ''}`
  const list = card.querySelector('ol')!
  for (const row of rows) {
    const item = document.createElement('li')
    item.dataset.engine = row.engine
    item.dataset.state = row.state
    item.style.setProperty('--engine', ENGINE_COLORS[row.engine] ?? '#b5a5d8')
    const disc = document.createElement('span'); disc.className = 'engine-disc'
    const logo = document.createElement('img'); logo.src = `/providers/${row.engine}.svg`; logo.alt = engineName(row.engine)
    disc.append(logo)
    const body = document.createElement('div')
    const title = document.createElement('strong'); title.textContent = row.label
    const meta = document.createElement('small'); meta.textContent = `${engineName(row.engine)} · ${row.model ?? 'default'}${row.reason ? ` — ${row.reason}` : ''}`
    body.append(title, meta)
    if (row.activity) { const latest = document.createElement('p'); latest.className = 'latest'; latest.insertAdjacentHTML('afterbegin', '<span class="pulse"></span>'); latest.append(row.activity); body.append(latest) }
    const state = document.createElement('span'); state.className = 'state'; state.textContent = stateText(row, now)
    item.append(disc, body, state)
    list.append(item)
  }
  const progress = card.querySelector('.team-progress') as HTMLElement
  if (rows.some(row => row.state === 'running' || row.state === 'reviewing')) {
    progress.hidden = false
    const settled = rows.filter(row => row.state === 'done' || row.state === 'landed').length
    ;(progress.firstElementChild as HTMLElement).style.width = `${Math.round((settled / rows.length) * 100)}%`
  }
  ;(card.querySelector('[data-open-agents]') as HTMLButtonElement).onclick = () => {
    dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: root }))
    $('open-agents').click()
  }
  return card
}

function userRow(turn: Turn): HTMLElement {
  const row = document.createElement('div')
  row.className = 'msg user'
  const bubble = document.createElement('div')
  bubble.className = 'user-message'
  bubble.textContent = turn.prompt
  row.append(bubble)
  return row
}

function agentRow(turn: Turn): HTMLElement {
  const row = document.createElement('details')
  row.className = 'agent-report'
  const [first, ...rest] = turn.prompt.split('\n')
  const summary = document.createElement('summary'); summary.textContent = first ?? ''
  const body = document.createElement('pre'); body.textContent = rest.join('\n').trim()
  row.append(summary, body)
  return row
}

function assistantRow(turn: Turn, rows: TeamRow[], project: string | null): HTMLElement {
  const row = ($('assistant-row') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement
  row.querySelector('time')!.textContent = new Date(turn.started).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const body = row.querySelector('.msg-body')!
  const activity = document.createElement('p')
  activity.className = 'activity-line'
  activity.dataset.running = String(turn.running)
  activity.textContent = workedLine(turn, Date.now())
  body.append(activity)
  if (turn.text) { const md = document.createElement('div'); md.className = 'md'; md.append(renderMarkdown(turn.text)); body.append(md) }
  for (const path of turn.edits) { const card = document.createElement('article'); card.className = 'edit-card'; card.append('Edited directly · '); const code = document.createElement('code'); code.textContent = path; card.append(code); body.append(card) }
  if (rows.length) body.append(teamCard(rows, project))
  return row
}

function signature(turn: Turn, rows: TeamRow[]): string {
  return JSON.stringify([turn.text.length, turn.tools, turn.running, turn.edits.length, rows.map(row => [row.id, row.state, row.activity])])
}

function paint(turns: Turn[], project: string | null): void {
  const existing = new Map([...messages.querySelectorAll<HTMLElement>('[data-turn]')].map(node => [`${node.dataset.turn}:${node.dataset.part}`, node]))
  const atBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 80
  const ordered: HTMLElement[] = []
  for (const turn of turns) {
    const rows = teamRows(agents, turn.id)
    const prompt = existing.get(`${turn.id}:prompt`) ?? (turn.source === 'agent' ? agentRow(turn) : userRow(turn))
    prompt.dataset.turn = turn.id
    prompt.dataset.part = 'prompt'
    ordered.push(prompt)
    const sig = signature(turn, rows)
    let reply = existing.get(`${turn.id}:reply`)
    if (!reply || reply.dataset.sig !== sig) { reply = assistantRow(turn, rows, project); reply.dataset.turn = turn.id; reply.dataset.part = 'reply'; reply.dataset.sig = sig }
    ordered.push(reply)
  }
  if (ordered.some((node, index) => messages.children[index] !== node) || messages.children.length !== ordered.length) messages.replaceChildren(...ordered)
  if (atBottom) stage.scrollTop = stage.scrollHeight
}

async function refresh(): Promise<void> {
  if (!root) return
  const mine = ++generation
  const [thread, jobs] = await Promise.all([getJson(`/api/jobs/${encodeURIComponent(root)}/thread`), getJson(`/api/jobs?chat=${encodeURIComponent(root)}`)])
  if (mine !== generation || !root) return
  if (!thread.ok) { chatError(`Could not reach the chat: ${errorText(thread)}. Retrying…`); schedule(); return }
  clearChatError()
  const all = readArray(jobs.ok ? jobs.data.jobs : []) as unknown as Array<AgentJob & TurnJob & { threadRoot?: string; purpose?: string; project?: string | null }>
  const turnsJobs = all.filter(job => job.threadRoot === root)
  agents = all.filter(job => job.purpose !== 'chat')
  const project = all.find(job => job.id === root)?.project ?? null
  paint(turnsFrom(readArray(thread.data.messages) as unknown as ThreadMessage[], turnsJobs), project)
  setRunning(thread.data.running === true)
  schedule()
}

function schedule(): void {
  clearTimeout(pollTimer)
  if (root && !$('conversation').hidden && document.visibilityState === 'visible') pollTimer = window.setTimeout(() => void refresh(), running ? RUNNING_POLL_MS : IDLE_POLL_MS)
}

function askHome(why: string, candidates: string[]): Promise<string | null> {
  const dialog = $('chat-home') as HTMLDialogElement
  const input = $('chat-home-path') as HTMLInputElement
  const form = $('chat-home-form') as HTMLFormElement
  $('chat-home-why').textContent = why
  $('chat-home-error').textContent = ''
  input.value = candidates[0] ?? ''
  $('chat-home-candidates').replaceChildren(...candidates.map(path => { const button = document.createElement('button'); button.type = 'button'; button.textContent = path; button.onclick = () => { input.value = path }; return button }))
  dialog.showModal()
  return new Promise(resolve => {
    const done = (value: string | null): void => { dialog.removeEventListener('close', onClose); dialog.close(); resolve(value) }
    const onClose = (): void => done(null)
    dialog.addEventListener('close', onClose)
    form.onsubmit = async (event) => {
      event.preventDefault()
      const response = await fetch('/api/chat/home', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: input.value.trim() }) })
      const payload = (await response.json().catch(() => ({}))) as { path?: string; error?: string }
      if (response.ok && typeof payload.path === 'string') done(payload.path)
      else $('chat-home-error').textContent = payload.error ?? 'That folder cannot be used.'
    }
  })
}

async function ensureHome(): Promise<string | null> {
  const status = await getJson('/api/chat/home')
  if (!status.ok) { chatError(errorText(status)); return null }
  if (status.data.ok === true) return String(status.data.path)
  const candidates = (readArray(status.data.candidates) as unknown[]).map(String)
  return askHome(status.data.reason === 'home' ? 'Your projects share only your home folder. Pick the folder that holds them.' : 'No projects yet. Type the folder where your projects live.', candidates)
}

async function startChat(prompt: string): Promise<void> {
  const home = await ensureHome()
  if (!home) return
  const choice = launchChoice(providers, stored('mc.shell.engine'), stored('mc.shell.model'))
  const project = stored('mc.shell.project')
  const result = await postJson('/api/jobs', { engine: choice.engine, ...(choice.model ? { model: choice.model } : {}), cwd: home, prompt, label: titleFrom(prompt), purpose: 'chat', edit: stored('mc.shell.edit') === '1', ...(project ? { project } : {}) })
  if (!result.ok) { chatError(errorText(result)); return }
  root = String(result.data.id)
  setUrl(root)
  await refresh()
}

async function sendMessage(prompt: string): Promise<void> {
  show('conversation')
  if (!root) { messages.replaceChildren(userRow({ id: 'pending', source: 'user', prompt, text: '', tools: 0, edits: [], started: Date.now(), ended: null, running: true })); setRunning(true); await startChat(prompt); if (!root) { setRunning(false); messages.replaceChildren(); message.value = prompt; show('welcome') } return }
  setRunning(true)
  const result = await postJson(`/api/jobs/${encodeURIComponent(root)}/reply`, { message: prompt })
  if (!result.ok) { chatError(errorText(result)); setRunning(false); return }
  await refresh()
}

type ListedJob = AgentJob & TurnJob & { threadRoot: string; purpose?: string; project?: string | null; chatId?: string; label: string }

function paintHistory(items: HistoryItem[]): void {
  $('history-count').textContent = items.length ? `(${items.length})` : ''
  const list = $('history-list')
  if (!items.length) { list.replaceChildren(Object.assign(document.createElement('p'), { className: 'history-empty', textContent: 'Nothing yet. Write a message or open a terminal to start.' })); historySignature = ''; return }
  const signature = JSON.stringify(items.map(item => [item.kind, item.id, item.title, item.updatedAt, item.kind === 'chat' ? [item.running, item.agents.map(job => [job.status, job.landedAt, job.stoppedAt])] : null]))
  if (signature === historySignature) return
  historySignature = signature
  const openIds = new Set([...list.querySelectorAll<HTMLElement>('details[open]')].map(item => item.dataset.item))
  list.replaceChildren(...items.map((item, index) => {
    const key = `${item.kind}:${item.id}`
    const signal = item.kind === 'chat' ? chatSignal(item.running, item.agents) : item.kind === 'terminal' ? { state: 'running' as const, count: 0 } : { state: null, count: 0 }
    const card = document.createElement('details'); card.className = 'history-item'; card.dataset.item = key; card.dataset.kind = item.kind; card.open = openIds.size ? openIds.has(key) : index === 0
    const summary = document.createElement('summary')
    const title = document.createElement('span')
    if (signal.state) { const dot = document.createElement('span'); dot.className = 'live-dot'; dot.dataset.state = signal.state; dot.title = signal.count ? `${signal.count} ${signal.state === 'running' ? 'running' : signal.state === 'needs-you' ? 'need you' : 'landed'}` : signal.state; title.append(dot); if (signal.count > 1) { const count = document.createElement('small'); count.className = 'dot-count'; count.textContent = String(signal.count); title.append(count) } }
    title.append(item.title)
    const time = document.createElement('time'); time.textContent = historyDay(item.updatedAt, Date.now())
    summary.append(title, time)
    const line = document.createElement('p'); line.textContent = historyLabel(item)
    const footer = document.createElement('footer')
    const kind = document.createElement('span'); kind.textContent = item.kind === 'chat' ? 'Chat' : item.kind === 'terminal' ? 'Terminal' : item.kind === 'claude-history' ? 'Claude history' : 'Outside session'
    footer.append(kind)
    const actionText = historyAction(item)
    if (actionText) {
      const action = document.createElement('button'); action.type = 'button'; action.className = 'text-button'; action.textContent = actionText
      action.onclick = () => {
        if (item.kind === 'chat') { openChat(item.id); return }
        show('welcome')
        if (item.kind === 'terminal') dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { id: item.id } }))
        else if (item.kind === 'claude-history') dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { resume: { sessionId: item.id, cwd: item.cwd, title: item.title } } }))
        else dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { restore: false, cwd: item.cwdHint } }))
      }
      footer.append(action)
    }
    card.append(summary, line, footer)
    return card
  }))
}

function paintAgentsCount(jobs: ListedJob[]): void {
  const running = jobs.filter(job => job.chatId && job.status === 'running').length
  const badge = $('agents-count')
  badge.textContent = String(running)
  badge.hidden = running === 0
}

let jobsTimer = 0
let historySignature = ''
async function pollJobs(): Promise<void> {
  clearTimeout(jobsTimer)
  if (document.visibilityState === 'visible') {
    const result = await getJson('/api/jobs')
    if (result.ok) paintAgentsCount(readArray(result.data.jobs) as unknown as ListedJob[])
    if (!$('history').hidden) { const feed = await getJson('/api/history'); if (feed.ok) paintHistory(readArray(feed.data.items) as unknown as HistoryItem[]) }
  }
  jobsTimer = window.setTimeout(() => void pollJobs(), IDLE_POLL_MS)
}

export function openChat(id: string): void {
  root = id
  agents = []
  messages.replaceChildren()
  setUrl(id)
  show('conversation')
  void refresh()
}

composer.onsubmit = (event) => {
  event.preventDefault()
  const prompt = message.value.trim()
  if (!prompt || running) return
  message.value = ''
  message.style.height = ''
  void sendMessage(prompt)
  message.focus()
}

addEventListener('quiet:new-chat', () => { root = null; agents = []; messages.replaceChildren(); setRunning(false); clearTimeout(pollTimer); setUrl(null) })
addEventListener('quiet:open-chat', (event) => openChat((event as CustomEvent<string>).detail))
addEventListener('quiet:show', (event) => { if ((event as CustomEvent<string>).detail === 'conversation') schedule(); else clearTimeout(pollTimer) })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(); else clearTimeout(pollTimer) })

void getJson('/api/providers').then(result => {
  if (result.ok) providers = (readArray(result.data.providers) as unknown as LaunchProvider[]).filter(item => typeof item.id === 'string')
})
addEventListener('quiet:screen', (event) => { if ((event as CustomEvent<string>).detail === 'history') void pollJobs() })
void pollJobs()
const initial = new URLSearchParams(location.search).get('chat')
if (initial) openChat(initial)
