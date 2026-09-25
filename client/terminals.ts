import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { providerName } from './terminal-view'
import { errorText, getJson, pathsFromUriList, postJson, readArray, readRecord, shellQuote } from './shared'
import { launchChoice, readRecentDirectories, restoreRequested } from './shell-launch'
import { dragKind, dropCopy, findCount, findKeys, latestLine, restoreTarget, nextActive, renameValue, sessionState, splitPlan, type Session, type SessionState } from './terminal-state'
import { createPanes, type PaneHeader } from './terminal-panes'

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
const park = $('term-park')
const dropStage = $('drop-stage')
const cards = $('rail-cards')
const panes = createPanes(stage)
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

export class TerminalView {
  readonly host = document.createElement('div')
  readonly terminal: Terminal
  readonly fit = new FitAddon()
  readonly search = new SearchAddon()
  socket: WebSocket | null = null
  lastOutputAt: number | null = null
  ended = false
  buffer = ''
  private resizeFrame = 0
  private readonly observer: ResizeObserver
  private readonly decoder = new TextDecoder()

  constructor(public session: Session) {
    this.host.className = 'term-host'
    this.host.dataset.id = session.id
    this.terminal = new Terminal({ allowProposedApi: true, fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches, scrollback: 10000, macOptionIsMeta: true, theme: { background: '#eaedf6', foreground: '#344155', cursor: '#8062bd', selectionBackground: '#b5a5d866' } })
    this.terminal.loadAddon(this.fit)
    this.terminal.loadAddon(this.search)
    this.terminal.loadAddon(new WebLinksAddon())
    this.terminal.attachCustomKeyEventHandler(event => { if (findKeys(event, false, MAC) !== 'open') return true; if (event.type === 'keydown') openFind(); return false })
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => { if (activeId === session.id) $('find-count').textContent = findCount(resultIndex, resultCount, findInput.value) })
    this.terminal.open(this.host)
    this.terminal.onData(data => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(new TextEncoder().encode(data)) })
    this.observer = new ResizeObserver(() => { cancelAnimationFrame(this.resizeFrame); this.resizeFrame = requestAnimationFrame(() => this.resize()) })
    this.observer.observe(this.host)
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
      const text = typeof event.data === 'string' ? event.data : this.decoder.decode(new Uint8Array(event.data as ArrayBuffer), { stream: true })
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
    this.observer.disconnect()
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
  const changed = (canvas.dataset.live === 'true') !== on
  canvas.dataset.live = String(on)
  document.body.dataset.live = String(on)
  $('live').hidden = !on
  $('flow').hidden = !on && $('flow').dataset.open !== 'true'
  const active = on && activeId ? views.get(activeId)?.session ?? null : null
  if (changed) dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: active }))
  const url = new URL(location.href)
  url.hash = on ? 'terminal' : ''
  if (!on) url.searchParams.delete('terminal')
  if (on && activeId) url.searchParams.set('terminal', activeId)
  history.replaceState(null, '', url)
  if (on) requestAnimationFrame(() => { activeId && views.get(activeId)?.resize(); if (renaming === null && !(document.activeElement instanceof HTMLInputElement)) activeId && views.get(activeId)?.terminal.focus() })
  else $('new-chat').focus()
}

function ensureView(session: Session): TerminalView {
  let view = views.get(session.id)
  if (!view) {
    view = new TerminalView(session)
    views.set(session.id, view)
    park.append(view.host)
    view.connect()
  } else if (view.session.title !== session.title || view.session.model !== session.model) {
    view.session = session
    panes.retitle(session.id, paneHeader(session))
    if (activeId === session.id) $('live-name').textContent = session.title
  } else view.session = session
  return view
}

function paneHeader(session: Session): PaneHeader {
  return { logo: `/providers/${session.engine}.svg`, title: session.title, caption: `${providerName(session.engine)}${session.model ? ` · ${session.model}` : ''}` }
}

function setActiveState(id: string): void {
  const view = views.get(id)
  if (!view) return
  if (!findBar.hidden && activeId !== null && activeId !== id) views.get(activeId)?.search.clearDecorations()
  activeId = id
  store(savedKey, id)
  if (!findBar.hidden) findStep('next')
  if (canvas.dataset.live === 'true') {
    const url = new URL(location.href); url.searchParams.set('terminal', id); url.hash = 'terminal'; history.replaceState(null, '', url)
    dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: view.session }))
  }
  $('live-name').textContent = view.session.title
  $('live-directory').textContent = `${engineName(view.session.engine)}${view.session.model ? ` · ${view.session.model}` : ''} · ${view.session.cwd}`
  $('live').setAttribute('aria-label', `Live ${engineName(view.session.engine)} terminal`)
  const state = view.socket?.readyState
  if (view.ended) setStatus('Session ended.', false)
  else if (state === WebSocket.OPEN) setStatus(`Connected · live ${engineName(view.session.engine)}`, false)
  else if (state === WebSocket.CLOSED) setStatus('Disconnected. Reconnect to try again.', true)
  renderRail()
}

export function activate(id: string): void {
  const view = views.get(id)
  if (!view) return
  panes.show(id, view.host, paneHeader(view.session))
  setActiveState(id)
  visible(true)
}

panes.onActive(id => { if (id !== activeId) setActiveState(id) })
panes.onHide(id => {
  const view = views.get(id)
  if (view) park.append(view.host)
  if (id === activeId) { const next = panes.active() ?? panes.shown()[0] ?? null; if (next) setActiveState(next) }
})

let dragZone: 'right' | 'bottom' | null = null
function paintZones(zone: 'right' | 'bottom' | null, show: boolean): void {
  dragZone = zone
  dropStage.dataset.dragging = String(show)
  for (const name of ['right', 'bottom'] as const) $(`drop-${name}`).dataset.hot = String(show && zone === name)
}
const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const findBar = $('find')
const findInput = $('find-input') as HTMLInputElement
const MATCH_DECORATIONS = { matchBackground: '#8062bd33', activeMatchBackground: '#8062bd88', matchOverviewRuler: '#8062bd88', activeMatchColorOverviewRuler: '#8062bd' }
function findStep(direction: 'next' | 'prev'): void {
  const view = activeId ? views.get(activeId) : null
  if (!view) return
  if (findInput.value === '') { view.search.clearDecorations(); $('find-count').textContent = ''; return }
  const options = { decorations: MATCH_DECORATIONS, incremental: direction === 'next' }
  if (direction === 'next') view.search.findNext(findInput.value, options)
  else view.search.findPrevious(findInput.value, options)
}
function openFind(): boolean {
  if (!activeId || document.querySelector('dialog[open]')) return false
  if (!findBar.hidden) { findInput.focus(); findInput.select(); return true }
  $('find-open').hidden = true
  $('live-status').hidden = true
  findBar.hidden = false
  findInput.focus()
  findInput.select()
  findStep('next')
  return true
}
function closeFind(): void {
  const view = activeId ? views.get(activeId) : null
  view?.search.clearDecorations()
  findBar.hidden = true
  $('find-open').hidden = false
  $('live-status').hidden = false
  $('find-count').textContent = ''
  view?.terminal.focus()
}
$('find-open').onclick = () => void openFind()
$('find-prev').onclick = () => findStep('prev')
$('find-next').onclick = () => findStep('next')
$('find-close').onclick = closeFind
findInput.oninput = () => findStep('next')
findInput.onkeydown = (event) => {
  event.stopPropagation()
  const action = findKeys(event, true, MAC)
  if (action === null) return
  event.preventDefault()
  if (action === 'close') closeFind()
  else if (action === 'prev') findStep('prev')
  else findStep('next')
}
document.addEventListener('keydown', (event) => { if (canvas.dataset.live === 'true' && findKeys(event, false, MAC) === 'open' && openFind()) event.preventDefault() })
$('find-key').textContent = MAC ? '⌘F' : 'Ctrl+F'
for (const type of ['dragover', 'drop'] as const) document.addEventListener(type, (event) => { if (dragKind(event.dataTransfer?.types ?? []) === 'files' && !dropStage.contains(event.target as Node | null)) event.preventDefault() })

const dropOver = $('drop-over')
function paintDropOver(transfer: DataTransfer | null, show: boolean): void {
  if (show) $('drop-over-title').textContent = dropCopy(Array.from(transfer?.items ?? []).filter(item => item.kind === 'file').length).title
  dropOver.hidden = !show
}
let toastTimer = 0
function toast(text: string, ms = 2000): void {
  const box = $('toast')
  box.textContent = text
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { box.hidden = true }, ms)
}
addEventListener('quiet:toast', (event) => toast(String((event as CustomEvent<string>).detail), 4000))
function dropTarget(event: DragEvent): TerminalView | null {
  const id = (event.target as Element | null)?.closest<HTMLElement>('.term-host')?.dataset.id ?? activeId
  return id ? views.get(id) ?? null : null
}
async function uploadDrop(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  form.append('lastModified', String(file.lastModified))
  const response = await fetch('/api/terminals/drops', { method: 'POST', body: form })
  const payload = (await response.json().catch(() => ({}))) as { error?: string; path?: string }
  if (!response.ok || typeof payload.path !== 'string') throw new Error(payload.error ?? `Upload failed (${response.status})`)
  return payload.path
}
async function dropFiles(transfer: DataTransfer | null, view: TerminalView): Promise<void> {
  if (view.socket?.readyState !== WebSocket.OPEN) { toast('That terminal is not connected'); return }
  let paths = pathsFromUriList(transfer?.getData('text/uri-list') ?? '')
  if (paths.length === 0 && transfer) {
    try { paths = await Promise.all(Array.from(transfer.files).map(uploadDrop)) }
    catch (error) { toast(error instanceof Error ? error.message : 'Upload failed'); return }
  }
  if (paths.length === 0) { toast('Nothing to add'); return }
  if (view.socket?.readyState !== WebSocket.OPEN) { toast('That terminal disconnected before the files were added'); return }
  view.socket.send(new TextEncoder().encode(`${paths.map(shellQuote).join(' ')} `))
  activate(view.session.id)
  toast(dropCopy(paths.length).toast)
}
dropStage.addEventListener('dragover', (event) => {
  const kind = dragKind(event.dataTransfer?.types ?? [])
  if (kind === 'none') return
  event.preventDefault()
  if (kind === 'files') { paintDropOver(event.dataTransfer, true); return }
  const box = dropStage.getBoundingClientRect()
  const zone = event.clientX > box.left + box.width * 0.52 ? 'right' : event.clientY > box.top + box.height * 0.6 ? 'bottom' : null
  paintZones(zone, true)
})
dropStage.addEventListener('dragleave', (event) => { if (!dropStage.contains(event.relatedTarget as Node | null)) { paintZones(null, false); paintDropOver(null, false) } })
dropStage.addEventListener('drop', (event) => {
  const kind = dragKind(event.dataTransfer?.types ?? [])
  if (kind === 'none') return
  event.preventDefault()
  if (kind === 'files') { paintDropOver(null, false); const view = dropTarget(event); if (view) void dropFiles(event.dataTransfer, view); return }
  const id = event.dataTransfer?.getData('text/x-mc-terminal') ?? ''
  const plan = splitPlan(id, panes.shown(), dragZone)
  paintZones(null, false)
  const view = views.get(id)
  if (!view) return
  if (!plan) { if (panes.shown().includes(id)) activate(id); return }
  panes.split(id, view.host, paneHeader(view.session), plan.direction)
  setActiveState(id)
})

function stateLabel(state: SessionState): string {
  return state === 'working' ? 'working' : state === 'ended' ? 'ended' : 'idle'
}

function buildCard(session: Session): HTMLElement {
  const item = document.createElement('div')
  item.className = 'rail-item'
  item.dataset.id = session.id
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'session-card'
  card.dataset.id = session.id
  const head = document.createElement('header')
  const logo = document.createElement('img'); logo.className = 'logo'; logo.alt = ''
  const title = document.createElement('span'); title.className = 'card-title'
  const dot = document.createElement('span'); dot.className = 'dot'
  head.append(logo, title, dot)
  const end = document.createElement('button')
  end.type = 'button'
  end.className = 'round card-x'
  end.setAttribute('aria-label', 'End this terminal')
  end.insertAdjacentHTML('afterbegin', '<svg><use href="#close-icon"/></svg>')
  end.onclick = () => askEnd(session.id)
  card.append(head, document.createElement('small'), document.createElement('code'))
  card.draggable = true
  card.ondragstart = (event) => { event.dataTransfer?.setData('text/x-mc-terminal', session.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }
  card.ondragend = () => paintZones(null, false)
  card.onclick = () => activate(session.id)
  title.ondblclick = (event) => { event.stopPropagation(); startRename(card) }
  item.append(card, end)
  return item
}

let renaming: string | null = null
let ending: string | null = null
const endDialog = $('end-session') as HTMLDialogElement

function askEnd(id: string): void {
  const session = sessions.find(item => item.id === id)
  if (!session) return
  ending = id
  $('end-session-title').textContent = `End ${session.title}?`
  endDialog.showModal()
}

async function endSession(id: string): Promise<void> {
  let ok = false
  try { const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }); ok = response.ok || response.status === 404 } catch {}
  if (!ok) { toast('Could not end this terminal. Try again.'); return }
  await refreshSessions()
  if (canvas.dataset.live === 'true' && activeId) views.get(activeId)?.terminal.focus()
}

$('end-session-confirm').onclick = () => { const id = ending; endDialog.close(); if (id) void endSession(id) }
$('end-session-cancel').onclick = () => endDialog.close()
endDialog.addEventListener('close', () => { ending = null })

function startRename(card: HTMLButtonElement): void {
  const id = card.dataset.id ?? ''
  const session = sessions.find(item => item.id === id)
  if (!session || renaming === id) return
  renaming = id
  const editor = document.createElement('div')
  editor.className = 'session-card editing'
  editor.dataset.id = id
  const head = document.createElement('header')
  const logo = document.createElement('img'); logo.className = 'logo'; logo.alt = ''; logo.src = `/providers/${session.engine}.svg`
  const input = document.createElement('input')
  input.className = 'name-edit'
  input.value = session.title
  input.maxLength = 60
  input.setAttribute('aria-label', 'Terminal name')
  head.append(logo, input)
  const hint = document.createElement('span')
  hint.className = 'edit-hint'
  hint.textContent = 'Enter to save · Esc to cancel · empty keeps the old name'
  editor.append(head, hint, card.querySelector('code')?.cloneNode(true) ?? document.createElement('code'))
  card.replaceWith(editor)
  let settled = false
  const finish = (save: boolean): void => {
    if (settled) return
    settled = true
    renaming = null
    const next = save ? renameValue(session.title, input.value) : null
    editor.replaceWith(card)
    card.focus()
    if (next !== null) void rename(id, next)
    else renderRail()
  }
  input.onkeydown = (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); finish(true) }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
  }
  input.onblur = () => finish(false)
  input.onclick = (event) => event.stopPropagation()
  input.focus()
  input.select()
}

async function rename(id: string, title: string): Promise<void> {
  refreshGeneration += 1
  let ok = false
  try {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    ok = response.ok
  } catch {}
  if (!ok) { toast('Could not rename this terminal'); renderRail(); return }
  sessions = sessions.map(session => session.id === id ? { ...session, title } : session)
  const view = views.get(id)
  if (view) { view.session = { ...view.session, title }; panes.retitle(id, paneHeader(view.session)) }
  if (activeId === id) $('live-name').textContent = title
  renderRail()
}

function paintCard(item: HTMLElement, session: Session): void {
  const card = item.querySelector('.session-card')
  if (!card) return
  const view = views.get(session.id)
  const state = view?.state ?? 'idle'
  card.setAttribute('aria-current', String(session.id === activeId))
  const logo = card.querySelector('img') as HTMLImageElement
  const src = `/providers/${session.engine}.svg`
  if (logo.getAttribute('src') !== src) logo.src = src
  card.querySelector('.card-title')!.textContent = session.title
  ;(card.querySelector('.dot') as HTMLElement).dataset.state = state
  card.querySelector('small')!.textContent = `${providerName(session.engine)}${session.model ? ` · ${session.model}` : ''} · ${stateLabel(state)}`
  card.querySelector('code')!.textContent = view ? latestLine(view.buffer) || '>' : '>'
}

export function renderRail(): void {
  if (renaming !== null) return
  $('rail-count').textContent = sessions.length ? `Terminals · ${sessions.length}` : 'Terminals'
  const existing = new Map([...cards.querySelectorAll<HTMLElement>('.rail-item')].map(item => [item.dataset.id ?? '', item]))
  const wanted = sessions.map(session => session.id)
  for (const [id, card] of existing) if (!wanted.includes(id)) card.remove()
  const ordered = sessions.map(session => { const card = existing.get(session.id) ?? buildCard(session); paintCard(card, session); return card })
  const current = [...cards.children].map(card => (card as HTMLElement).dataset.id)
  if (current.join() !== wanted.join()) cards.replaceChildren(...ordered)
  $('rail-empty').hidden = sessions.length > 0
}

let refreshGeneration = 0
async function refreshSessions(): Promise<void> {
  const generation = ++refreshGeneration
  const result = await getJson('/api/terminals')
  if (!result.ok || generation !== refreshGeneration) return
  sessions = (readArray(result.data.sessions) as Session[]).filter(item => typeof item.id === 'string')
  for (const session of sessions) ensureView(session)
  const order = [...views.keys()]
  const removed = order.filter(id => !sessions.some(session => session.id === id))
  for (const id of removed) { panes.hide(id); views.get(id)?.dispose(); views.delete(id) }
  if (activeId !== null && removed.includes(activeId)) {
    const survivors = order.filter(id => !removed.includes(id) || id === activeId)
    const next = nextActive(survivors, activeId, activeId)
    if (next) { if (canvas.dataset.live === 'true') activate(next); else setActiveState(next) }
    else { activeId = null; store(savedKey, null); if (canvas.dataset.live === 'true') visible(false) }
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
    const target = restoreTarget(new URLSearchParams(location.search).get('terminal'), stored(savedKey), [...views.keys()])
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

export async function openTerminal(restore = false, cwd?: string): Promise<void> {
  if (opening) return
  opening = true
  if (!launch.open) launch.showModal()
  try { await load(restore); if (cwd) cwdInput.value = cwd } finally { opening = false }
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

async function resumeSession(resume: { sessionId: string; cwd: string; title: string }): Promise<void> {
  if (opening) return
  opening = true
  try {
    const result = await postJson('/api/terminals', { engine: 'claude', cwd: resume.cwd, cols: 100, rows: 30, resumeSessionId: resume.sessionId, title: resume.title.slice(0, 60) })
    if (!result.ok) { toast(`Could not resume: ${errorText(result)}`, 4000); return }
    const session = result.data as unknown as Session
    sessions = [...sessions.filter(item => item.id !== session.id), session]
    ensureView(session)
    launch.close()
    activate(session.id)
  } finally { opening = false }
}

;($('live-create') as HTMLFormElement).onsubmit = (event) => { event.preventDefault(); void createTerminal() }
engineSelect.onchange = () => { modelInput.value = ''; updateModelChoices() }
$('rail-new').onclick = () => void openTerminal(false)
const railOpenKey = 'mc.rail.open'
function paintRail(open: boolean): void {
  const toggle = $('rail-toggle')
  ;(document.querySelector('.with-rail') as HTMLElement).dataset.rail = open ? 'open' : 'closed'
  toggle.setAttribute('aria-expanded', String(open))
  toggle.setAttribute('aria-label', open ? 'Hide the session list' : 'Show the session list')
  toggle.title = open ? 'Hide the session list' : 'Show the session list'
}
$('rail-toggle').onclick = () => { const open = (document.querySelector('.with-rail') as HTMLElement).dataset.rail === 'closed'; store(railOpenKey, open ? null : '0'); paintRail(open) }
paintRail(stored(railOpenKey) !== '0')
addEventListener('quiet:design', () => { if (canvas.dataset.live === 'true') visible(false) })
addEventListener('quiet:open-terminal', (event) => {
  const detail = (event as CustomEvent<{ restore?: boolean; id?: string; cwd?: string; resume?: { sessionId: string; cwd: string; title: string } }>).detail
  if (detail.id) { void refreshSessions().then(() => { if (views.has(detail.id!)) activate(detail.id!); else toast('That terminal has ended.', 4000) }); return }
  if (detail.resume) { void resumeSession(detail.resume); return }
  void openTerminal(detail.restore === true, detail.cwd)
})
reconnectButton.onclick = async () => {
  if (opening || !activeId) return
  const id = activeId
  opening = true
  reconnectButton.disabled = true
  await refreshSessions()
  opening = false
  if (activeId !== id) return
  const view = views.get(id)
  if (view && !view.ended) view.connect()
  else setStatus('Session ended.', false)
}
setInterval(() => { if (!document.hidden) void refreshSessions() }, POLL_MS)
setInterval(() => { if (!document.hidden && canvas.dataset.live === 'true') renderRail() }, TICK_MS)
if (restoreRequested(location)) void openTerminal(true)
