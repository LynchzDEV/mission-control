import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { providerName } from './terminal-view'
import { errorText, getJson, postJson, readArray, readRecord } from './shared'
import { launchChoice, restoreRequested } from './shell-launch'

type Session = { id: string; engine: string; cwd: string }
type Provider = { id: string; name: string; models: string[] }

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const canvas = document.querySelector('.canvas') as HTMLElement
const savedKey = 'mc.quiet.terminal'
const recentKey = 'mc.term.recentCwd'
const engineKey = 'mc.shell.engine'
const modelKey = 'mc.shell.model'
const launch = $('live-launch') as HTMLDialogElement
const engineSelect = $('live-engine') as HTMLSelectElement
const modelInput = $('live-model') as HTMLInputElement
const cwdInput = $('live-cwd') as HTMLInputElement
const workflowSelect = $('live-workflow') as HTMLSelectElement
const submit = $('live-submit') as HTMLButtonElement
const reconnectButton = $('live-reconnect') as HTMLButtonElement
let session: Session | null = null
let terminal: Terminal | null = null
let fit: FitAddon | null = null
let socket: WebSocket | null = null
let opening = false
let resizeFrame = 0
let models: Record<string, string[]> = {}
let workflowsReady = false
const engineName = (engine: string | undefined): string => engine === 'claude' ? 'Claude Code' : providerName(engine ?? '')
cwdInput.value = (window as { MC_WORKSPACE_DIR?: string }).MC_WORKSPACE_DIR ?? ''

const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string | null): void => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key) } catch {} }

function rememberedId(): string | null {
  return new URLSearchParams(location.search).get('terminal') ?? stored(savedKey)
}

function visible(on: boolean): void {
  canvas.dataset.live = String(on)
  document.body.dataset.live = String(on)
  $('live').hidden = !on
  flowVisible(on)
  dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: on ? session : null }))
  const url = new URL(location.href)
  url.hash = on ? 'terminal' : ''
  if (!on) url.searchParams.delete('terminal')
  if (on && session) url.searchParams.set('terminal', session.id)
  history.replaceState(null, '', url)
  if (on) requestAnimationFrame(() => { resize(); terminal?.focus() })
  else $('new-chat').focus()
}

function flowVisible(on: boolean): void {
  $('flow').hidden = !on && $('flow').dataset.open !== 'true'
}

function resize(): void {
  if (!terminal || !fit || $('live').hidden) return
  fit.fit()
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
}
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(resize)
}).observe($('live-terminal'))

function connect(): void {
  if (!terminal || !session) return
  const term = terminal
  const current = session
  socket?.close()
  term.reset()
  term.options.disableStdin = true
  $('live-status').textContent = 'Connecting…'
  reconnectButton.disabled = true
  reconnectButton.hidden = true
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const connection = new WebSocket(`${scheme}//${location.host}/ws/terminal/${encodeURIComponent(current.id)}`)
  socket = connection
  connection.binaryType = 'arraybuffer'
  connection.onopen = () => {
    if (socket !== connection) return
    $('live-status').textContent = `Connected · live ${engineName(current.engine)}`
    term.options.disableStdin = false
    resize()
    term.focus()
  }
  connection.onmessage = (event) => {
    if (socket !== connection) return
    term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
  }
  connection.onerror = () => {
    if (socket === connection) $('live-status').textContent = 'Connection failed. Reconnect to try again.'
  }
  connection.onclose = (event) => {
    if (socket !== connection) return
    term.options.disableStdin = true
    const ended = event.code === 4404 || event.code === 4410
    $('live-status').textContent = ended ? 'Session ended. Open another from New chat.' : 'Disconnected. Reconnect to try again.'
    reconnectButton.disabled = ended
    reconnectButton.hidden = ended
    if (ended) { session = null; store(savedKey, null) }
  }
}

function attach(record: Session): void {
  session = record
  $('live-name').textContent = engineName(record.engine)
  $('live').setAttribute('aria-label', `Live ${engineName(record.engine)} terminal`)
  store(savedKey, record.id)
  $('live-directory').textContent = record.cwd
  $('live').dataset.session = record.id
  launch.close()
  visible(true)
  if (!terminal) {
    terminal = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: !matchMedia('(prefers-reduced-motion: reduce)').matches, scrollback: 10000, macOptionIsMeta: true, theme: { background: '#eaedf6', foreground: '#344155', cursor: '#8062bd', selectionBackground: '#b5a5d866' } })
    fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open($('live-terminal'))
    terminal.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data)) })
  }
  resize()
  connect()
}

function recentDirectories(): string[] {
  try {
    const parsed: unknown = JSON.parse(stored(recentKey) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

function rememberDirectory(cwd: string): void {
  store(recentKey, JSON.stringify([cwd, ...recentDirectories().filter(item => item !== cwd)].slice(0, 12)))
}

function listButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.onclick = action
  return button
}

function updateModelChoices(): void {
  ;($('live-models') as HTMLDataListElement).replaceChildren(...(models[engineSelect.value] ?? []).map(model => new Option(model, model)))
  submit.textContent = `Open ${engineName(engineSelect.value)}`
}

async function load(restore = false): Promise<void> {
  $('live-error').textContent = 'Checking your workspace…'
  $('live-create').hidden = true
  workflowsReady = false
  const result = await getJson('/api/terminals')
  if (!result.ok) { $('live-error').textContent = `Could not connect: ${errorText(result)}. Close this panel and retry.`; return }
  if (!launch.open) return
  const available = readArray(result.data.sessions) as Session[]
  const existing = available.find(item => item.id === rememberedId())
  if (restore && existing) { attach(existing); return }
  $('live-directories').replaceChildren(...[...new Set([...recentDirectories(), ...available.map(item => item.cwd)])].map(cwd => listButton(cwd, () => { cwdInput.value = cwd })))
  $('live-recents').hidden = !$('live-directories').children.length
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

async function openTerminal(restore = false): Promise<void> {
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
    rememberDirectory(cwd)
    store(engineKey, engine)
    store(modelKey, model || null)
    attach(result.data as unknown as Session)
  } finally { opening = false; submit.disabled = false }
}

;($('live-create') as HTMLFormElement).onsubmit = (event) => { event.preventDefault(); void createTerminal() }
engineSelect.onchange = () => { modelInput.value = ''; updateModelChoices() }
addEventListener('quiet:design', () => { if (canvas.dataset.live === 'true') visible(false) })
addEventListener('quiet:open-terminal', (event) => { void openTerminal((event as CustomEvent<{ restore: boolean }>).detail.restore) })
if (restoreRequested(location)) void openTerminal(true)
reconnectButton.onclick = async () => {
  if (opening) return
  opening = true
  reconnectButton.disabled = true
  const result = await getJson('/api/terminals')
  opening = false
  if (!result.ok) {
    $('live-status').textContent = `Could not reconnect: ${errorText(result)}`
    reconnectButton.disabled = false
  } else if ((readArray(result.data.sessions) as Session[]).some(item => item.id === session?.id)) connect()
  else { session = null; store(savedKey, null); $('live-status').textContent = 'Session ended. Open another from New chat.' }
}

export {}
