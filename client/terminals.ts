import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { providerName } from './terminal-view'
import { errorText, getJson, postJson, readArray, readRecord } from './shared'
import { launchChoice, readRecentDirectories, restoreRequested } from './shell-launch'
import { latestLine, nextActive, sessionState, type Session, type SessionState } from './terminal-state'

type Provider = { id: string; name: string; models: string[] }

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const canvas = document.querySelector('.canvas') as HTMLElement
const savedKey = 'mc.quiet.terminal', recentKey = 'mc.term.recentCwd', engineKey = 'mc.shell.engine', modelKey = 'mc.shell.model'
const POLL_MS = 5000, TICK_MS = 2000, BUFFER_CHARS = 4000
const launch = $('live-launch') as HTMLDialogElement
const engineSelect = $('live-engine') as HTMLSelectElement
const modelInput = $('live-model') as HTMLInputElement
const cwdInput = $('live-cwd') as HTMLInputElement
const workflowSelect = $('live-workflow') as HTMLSelectElement
const submit = $('live-submit') as HTMLButtonElement
const reconnectButton = $('live-reconnect') as HTMLButtonElement
const stage = $('live-stage')
const cards = $('rail-cards')
const views = new Map<string, TerminalView>()
let sessions: Session[] = []
let activeId: string | null = null
let opening = false
let models: Record<string, string[]> = {}
let workflowsReady = false
const engineName = (engine: string | undefined): string => engine === 'claude' ? 'Claude Code' : providerName(engine ?? '')
cwdInput.value = (window as { MC_WORKSPACE_DIR?: string }).MC_WORKSPACE_DIR ?? ''

const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string | null): void => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key) } catch {} }
const rememberedId = (): string | null => new URLSearchParams(location.search).get('terminal') ?? stored(savedKey)
const decoder = new TextDecoder()

export class TerminalView {
  readonly host = document.createElement('div')
  readonly terminal: Terminal
  readonly fit = new FitAddon()
  socket: WebSocket | null = null
  lastOutputAt: number | null = null
  ended = false
  buffer = ''
  private resizeFrame = 0

  constructor(public session: Session) {
    this.host.className = 'term-host'
    this.host.dataset.id = session.id
    this.terminal = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches, scrollback: 10000, macOptionIsMeta: true, theme: { background: '#eaedf6', foreground: '#344155', cursor: '#8062bd', selectionBackground: '#b5a5d866' } })
    this.terminal.loadAddon(this.fit)
    this.terminal.open(this.host)
    this.terminal.onData(data => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(new TextEncoder().encode(data)) })
    new ResizeObserver(() => { cancelAnimationFrame(this.resizeFrame); this.resizeFrame = requestAnimationFrame(() => this.resize()) }).observe(this.host)
  }

  get state(): SessionState { return sessionState(this.lastOutputAt, this.ended, Date.now()) }

  resize(): void {
    if (this.host.hidden || this.host.clientWidth === 0) return
    this.fit.fit()
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows }))
  }

  connect(): void {
    this.socket?.close()
    this.terminal.reset()
    this.terminal.options.disableStdin = true
    this.ended = false
    if (activeId === this.session.id) setStatus('Connecting…', false)
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const connection = new WebSocket(`${scheme}//${location.host}/ws/terminal/${encodeURIComponent(this.session.id)}`)
    this.socket = connection
    connection.binaryType = 'arraybuffer'
    connection.onopen = () => {
      if (this.socket !== connection) return
      this.terminal.options.disableStdin = false
      if (activeId === this.session.id) { setStatus(`Connected · live ${engineName(this.session.engine)}`, false); this.resize(); this.terminal.focus() }
    }
    connection.onmessage = (event) => {
      if (this.socket !== connection) return
      const text = typeof event.data === 'string' ? event.data : decoder.decode(new Uint8Array(event.data as ArrayBuffer))
      this.terminal.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
      this.lastOutputAt = Date.now()
      this.buffer = (this.buffer + text).slice(-BUFFER_CHARS)
    }
    connection.onerror = () => { if (this.socket === connection && activeId === this.session.id) setStatus('Connection failed. Reconnect to try again.', true) }
    connection.onclose = (event) => {
      if (this.socket !== connection) return
      this.terminal.options.disableStdin = true
      this.ended = event.code === 4404 || event.code === 4410
      if (activeId === this.session.id) setStatus(this.ended ? 'Session ended.' : 'Disconnected. Reconnect to try again.', !this.ended)
      renderRail()
    }
  }

  dispose(): void {
    this.socket?.close()
    this.socket = null
    this.terminal.dispose()
    this.host.remove()
  }
}

function setStatus(text: string, canReconnect: boolean): void {
  $('live-status').textContent = text
  reconnectButton.hidden = !canReconnect
  reconnectButton.disabled = !canReconnect
}

function visible(on: boolean): void {
  canvas.dataset.live = String(on)
  document.body.dataset.live = String(on)
  $('live').hidden = !on
  $('flow').hidden = !on && $('flow').dataset.open !== 'true'
  const active = on && activeId ? views.get(activeId)?.session ?? null : null
  dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: active }))
  const url = new URL(location.href)
  url.hash = on ? 'terminal' : ''
  if (!on) url.searchParams.delete('terminal')
  if (on && activeId) url.searchParams.set('terminal', activeId)
  history.replaceState(null, '', url)
  if (on) requestAnimationFrame(() => { activeId && views.get(activeId)?.resize(); activeId && views.get(activeId)?.terminal.focus() })
  else $('new-chat').focus()
}

function ensureView(session: Session): TerminalView {
  let view = views.get(session.id)
  if (!view) {
    view = new TerminalView(session)
    view.host.hidden = true
    views.set(session.id, view)
    stage.append(view.host)
    view.connect()
  } else view.session = session
  return view
}

export function activate(id: string): void {
  const view = views.get(id)
  if (!view) return
  activeId = id
  store(savedKey, id)
  for (const other of views.values()) other.host.hidden = other !== view
  $('live-name').textContent = view.session.title
  $('live-directory').textContent = `${engineName(view.session.engine)}${view.session.model ? ` · ${view.session.model}` : ''} · ${view.session.cwd}`
  $('live').setAttribute('aria-label', `Live ${engineName(view.session.engine)} terminal`)
  const state = view.socket?.readyState
  if (view.ended) setStatus('Session ended.', false)
  else if (state === WebSocket.OPEN) setStatus(`Connected · live ${engineName(view.session.engine)}`, false)
  else if (state === WebSocket.CLOSED) setStatus('Disconnected. Reconnect to try again.', true)
  visible(true)
  renderRail()
}

function stateLabel(state: SessionState): string {
  return state === 'working' ? 'working' : state === 'ended' ? 'ended' : 'idle'
}

export function renderRail(): void {
  $('rail-count').textContent = sessions.length ? `Terminals · ${sessions.length}` : 'Terminals'
  const known = new Set(sessions.map(session => session.id))
  cards.replaceChildren(...sessions.map(session => {
    const view = views.get(session.id)
    const state = view?.state ?? 'idle'
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'session-card'
    card.dataset.id = session.id
    card.setAttribute('aria-current', String(session.id === activeId))
    const head = document.createElement('header')
    const logo = document.createElement('img'); logo.className = 'logo'; logo.src = `/providers/${session.engine}.svg`; logo.alt = ''
    const title = document.createElement('span'); title.className = 'card-title'; title.textContent = session.title
    const dot = document.createElement('span'); dot.className = 'dot'; dot.dataset.state = state
    head.append(logo, title, dot)
    const small = document.createElement('small'); small.textContent = `${providerName(session.engine)}${session.model ? ` · ${session.model}` : ''} · ${stateLabel(state)}`
    const line = document.createElement('code'); line.textContent = view ? latestLine(view.buffer) || '>' : '>'
    card.append(head, small, line)
    card.onclick = () => activate(session.id)
    return card
  }))
  for (const [id, view] of views) if (!known.has(id) && !view.ended) { view.ended = true }
}

async function refreshSessions(): Promise<void> {
  const result = await getJson('/api/terminals')
  if (!result.ok) return
  sessions = (readArray(result.data.sessions) as Session[]).filter(item => typeof item.id === 'string')
  for (const session of sessions) ensureView(session)
  for (const [id, view] of views) if (!sessions.some(session => session.id === id)) {
    view.dispose()
    views.delete(id)
    if (activeId === id) {
      const next = nextActive([...views.keys(), id], id, id)
      if (next) activate(next); else { activeId = null; store(savedKey, null); if (canvas.dataset.live === 'true') visible(false) }
    }
  }
  renderRail()
}

function updateModelChoices(): void {
  ;($('live-models') as HTMLDataListElement).replaceChildren(...(models[engineSelect.value] ?? []).map(model => new Option(model, model)))
  submit.textContent = `Open ${engineName(engineSelect.value)}`
}

async function load(restore = false): Promise<void> {
  $('live-error').textContent = 'Checking your workspace…'
  $('live-create').hidden = true
  workflowsReady = false
  await refreshSessions()
  if (restore) {
    const wanted = rememberedId()
    const target = (wanted && views.has(wanted) ? wanted : null) ?? sessions[0]?.id ?? null
    if (target) { launch.close(); activate(target); return }
  }
  if (!launch.open) return
  const [providerResult, workflowResult] = await Promise.all([getJson('/api/providers'), getJson('/api/studio/workflows')])
  const failed = [providerResult, workflowResult].find(item => !item.ok)
  if (failed) { $('live-error').textContent = `Could not load launch options: ${errorText(failed)}. Close and reopen to retry.`; return }
  const selected = readRecord(workflowResult.data.selected)
  if (!selected.id || !selected.revision || !selected.name) { $('live-error').textContent = 'Default workflow unavailable. Close and reopen to retry.'; return }
  const providers = readArray(providerResult.data.providers) as Provider[]
  models = Object.fromEntries(providers.map(provider => [provider.id, provider.models]))
  engineSelect.replaceChildren(...providers.map(provider => new Option(provider.name, provider.id)))
  const choice = launchChoice(providers, stored(engineKey), stored(modelKey))
  engineSelect.value = choice.engine
  modelInput.value = choice.model
  const workflows = readArray(workflowResult.data.workflows) as Array<{ id: string; revision: string; name: string }>
  workflowSelect.replaceChildren(new Option(`Default · ${String(selected.name)}`, ''), ...workflows.filter(item => item.id && item.revision && item.name && !(item.id === selected.id && item.revision === selected.revision)).map(item => new Option(item.name, `${item.id}@${item.revision}`)))
  workflowSelect.disabled = false
  workflowsReady = true
  updateModelChoices()
  $('live-create').hidden = false
  $('live-error').textContent = 'Choose how and where to start.'
}

export async function openTerminal(restore = false): Promise<void> {
  if (opening) return
  opening = true
  if (!launch.open) launch.showModal()
  try { await load(restore) } finally { opening = false }
}

async function createTerminal(): Promise<void> {
  if (opening || !workflowsReady) return
  const cwd = cwdInput.value.trim()
  if (!cwd) { $('live-error').textContent = 'Choose a working directory.'; return }
  opening = true
  submit.disabled = true
  const engine = engineSelect.value
  const model = modelInput.value.trim()
  const [workflowId, revision] = workflowSelect.value.split('@')
  $('live-error').textContent = `Opening ${engineName(engine)}…`
  try {
    const result = await postJson('/api/terminals', { engine, cwd, cols: 100, rows: 30, ...(model ? { model } : {}), ...(workflowId ? { workflowId, revision } : {}) })
    if (!result.ok) { $('live-error').textContent = `Could not open ${engineName(engine)}: ${errorText(result)}`; return }
    store(recentKey, JSON.stringify([cwd, ...readRecentDirectories(stored(recentKey)).filter(item => item !== cwd)].slice(0, 12)))
    store(engineKey, engine)
    store(modelKey, model || null)
    const session = result.data as unknown as Session
    sessions = [...sessions.filter(item => item.id !== session.id), session]
    ensureView(session)
    launch.close()
    activate(session.id)
  } finally { opening = false; submit.disabled = false }
}

;($('live-create') as HTMLFormElement).onsubmit = (event) => { event.preventDefault(); void createTerminal() }
engineSelect.onchange = () => { modelInput.value = ''; updateModelChoices() }
$('rail-new').onclick = () => void openTerminal(false)
addEventListener('quiet:design', () => { if (canvas.dataset.live === 'true') visible(false) })
addEventListener('quiet:open-terminal', (event) => { void openTerminal((event as CustomEvent<{ restore: boolean }>).detail.restore) })
reconnectButton.onclick = async () => {
  if (opening || !activeId) return
  const id = activeId
  opening = true
  reconnectButton.disabled = true
  await refreshSessions()
  opening = false
  const view = views.get(id)
  if (view && !view.ended) view.connect()
  else setStatus('Session ended.', false)
}
setInterval(() => { if (!document.hidden) void refreshSessions() }, POLL_MS)
setInterval(() => { if (!document.hidden && canvas.dataset.live === 'true') renderRail() }, TICK_MS)
if (restoreRequested(location)) void openTerminal(true)
