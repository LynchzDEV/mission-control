import { Terminal } from '@xterm/xterm'
import { setActivityScope } from './live-activity.js'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { providerName } from '../../client/terminal-view.ts'
import { errorText, getJson, postJson, readArray, readRecord } from '../../client/shared.ts'

const $ = id => document.getElementById(id)
const canvas = document.querySelector('.canvas')
const savedKey = 'mc.quiet.claude-terminal'
let session = null
let terminal = null
let fit = null
let socket = null
let opening = false
let resizeFrame = 0
let models = {}
let workflowsReady = false
const recentKey = 'mc.term.recentCwd'
const engineName = engine => engine === 'claude' ? 'Claude Code' : providerName(engine)
$('live-cwd').value = import.meta.env.VITE_WORKSPACE_DIR ?? ''

function rememberedId() {
  const query = new URLSearchParams(location.search).get('terminal')
  if (query) return query
  try { return localStorage.getItem(savedKey) } catch { return null }
}

function remember(id) {
  try { if (id) localStorage.setItem(savedKey, id); else localStorage.removeItem(savedKey) } catch {}
}

function visible(on) {
  canvas.dataset.live = String(on)
  document.body.dataset.live = String(on)
  for (const id of ['search', 'new-chat', 'open-studio', 'open-agents', 'toggle-flow']) $(id).hidden = false
  $('back-to-chat').hidden = on || $('studio').hidden
  $('live').hidden = !on
  $('flow').hidden = !on && !$('studio').hidden
  setActivityScope(on ? session : null)
  $('preview-label').textContent = on ? `Live ${engineName(session?.engine)} · local workspace` : 'Design preview · sample content'
  const url = new URL(location.href)
  url.hash = on ? 'terminal' : ''
  if (!on) url.searchParams.delete('terminal')
  if (on && session) url.searchParams.set('terminal', session.id)
  history.replaceState(null, '', url)
  if (on) requestAnimationFrame(() => { resize(); terminal?.focus() })
  else $('new-chat').focus()
}

function resize() {
  if (!terminal || $('live').hidden) return
  fit.fit()
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
}
const observer = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(resize)
})
observer.observe($('live-terminal'))

function connect() {
  socket?.close()
  terminal.reset()
  terminal.options.disableStdin = true
  $('live-status').textContent = 'Connecting…'
  $('live-reconnect').disabled = true
  $('live-reconnect').hidden = true
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const connection = new WebSocket(`${scheme}//${location.host}/ws/terminal/${encodeURIComponent(session.id)}`)
  socket = connection
  connection.binaryType = 'arraybuffer'
  connection.onopen = () => {
    if (socket !== connection) return
    $('live-status').textContent = `Connected · live ${engineName(session.engine)}`
    terminal.options.disableStdin = false
    resize()
    terminal.focus()
  }
  connection.onmessage = event => {
    if (socket !== connection) return
    terminal.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data))
  }
  connection.onerror = () => {
    if (socket === connection) $('live-status').textContent = 'Connection failed. Reconnect to try again.'
  }
  connection.onclose = event => {
    if (socket !== connection) return
    terminal.options.disableStdin = true
    const ended = event.code === 4404 || event.code === 4410
    $('live-status').textContent = ended ? 'Session ended. Return to the design to open another.' : 'Disconnected. Reconnect to try again.'
    $('live-reconnect').disabled = ended
    $('live-reconnect').hidden = ended
    if (ended) { session = null; remember(null) }
  }
}

function attach(record) {
  session = record
  $('live-name').textContent = engineName(record.engine)
  $('live').setAttribute('aria-label', `Live ${engineName(record.engine)} terminal`)
  remember(record.id)
  $('live-directory').textContent = record.cwd
  $('live').dataset.session = record.id
  $('live-launch').close()
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

function recentDirectories() {
  try {
    const stored = JSON.parse(localStorage.getItem(recentKey) ?? '[]')
    return Array.isArray(stored) ? stored.filter(item => typeof item === 'string') : []
  } catch { return [] }
}

function rememberDirectory(cwd) {
  try { localStorage.setItem(recentKey, JSON.stringify([cwd, ...recentDirectories().filter(item => item !== cwd)].slice(0, 12))) } catch {}
}

function listButton(label, detail, action) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  if (detail) { const small = document.createElement('small'); small.textContent = detail; button.append(small) }
  button.onclick = action
  return button
}

function updateModelChoices() {
  $('live-models').replaceChildren(...(models[$('live-engine').value] ?? []).map(model => new Option(model, model)))
  $('live-submit').textContent = `Open ${engineName($('live-engine').value)}`
}

async function load(restore = false) {
  $('live-error').textContent = 'Checking your local workspace…'
  $('live-create').hidden = true
  workflowsReady = false
  const result = await getJson('/api/terminals')
  if (result.status === 401) {
    if (location.origin !== 'http://127.0.0.1:51947') {
      const local = new URL('http://127.0.0.1:51947/#terminal')
      const id = rememberedId()
      if (restore && id) local.searchParams.set('terminal', id)
      location.assign(local)
    } else $('live-error').textContent = 'Local access expired. Reload this page to reconnect.'
    return
  }
  if (!result.ok) { $('live-error').textContent = `Could not connect: ${errorText(result)}. Close this panel and retry.`; return }
  if (!$('live-launch').open) return
  const available = readArray(result.data.sessions)
  const existing = available.find(item => item.id === rememberedId())
  if (restore && existing) { attach(existing); return }
  $('live-directories').replaceChildren(...[...new Set([...recentDirectories(), ...available.map(item => item.cwd)])].map(cwd => listButton(cwd, '', () => { $('live-cwd').value = cwd })))
  $('live-recents').hidden = !$('live-directories').children.length
  const [modelResult, workflowResult, roleResult] = await Promise.all([getJson('/api/models'), getJson('/api/studio/workflows'), getJson('/api/roles')])
  const failed = [modelResult, workflowResult, roleResult].find(item => !item.ok)
  if (failed) { $('live-error').textContent = `Could not load launch options: ${errorText(failed)}. Close and reopen to retry.`; return }
  const selected = readRecord(workflowResult.data.selected)
  if (!selected.id || !selected.revision || !selected.name) { $('live-error').textContent = 'Default workflow unavailable. Close and reopen to retry.'; return }
  models = Object.fromEntries(Object.entries(modelResult.data).filter(([, values]) => Array.isArray(values) && values.every(value => typeof value === 'string')))
  $('live-engine').replaceChildren(...[...new Set(['claude', 'codex', 'glm', ...Object.keys(models)])].map(engine => new Option(engineName(engine), engine)))
  const role = readRecord(roleResult.data.plan)
  $('live-engine').value = [...$('live-engine').options].some(option => option.value === role.engine) ? role.engine : 'claude'
  $('live-model').value = typeof role.model === 'string' ? role.model : ''
  $('live-workflow').replaceChildren(new Option(`Default · ${selected.name}`, ''), ...readArray(workflowResult.data.workflows).filter(item => item.id && item.revision && item.name && !(item.id === selected.id && item.revision === selected.revision)).map(item => new Option(item.name, `${item.id}@${item.revision}`)))
  $('live-workflow').disabled = false
  workflowsReady = true
  updateModelChoices()
  $('live-create').hidden = false
  $('live-error').textContent = 'Choose how and where to start.'
}

export async function openTerminal(restore = false) {
  if (opening) return
  opening = true
  if (!$('live-launch').open) $('live-launch').showModal()
  try { await load(restore) } finally { opening = false }
}

async function createTerminal() {
  if (opening || !workflowsReady) return
  const cwd = $('live-cwd').value.trim()
  if (!cwd) { $('live-error').textContent = 'Choose a working directory.'; return }
  opening = true
  $('live-submit').disabled = true
  const engine = $('live-engine').value
  const model = $('live-model').value.trim()
  const [workflowId, revision] = $('live-workflow').value.split('@')
  $('live-error').textContent = `Opening ${engineName(engine)}…`
  try {
    const result = await postJson('/api/terminals', { engine, cwd, cols: 100, rows: 30, ...(model ? { model } : {}), ...(workflowId ? { workflowId, revision } : {}) })
    if (!result.ok) { $('live-error').textContent = `Could not open ${engineName(engine)}: ${errorText(result)}`; return }
    rememberDirectory(cwd)
    attach(result.data)
  } finally { opening = false; $('live-submit').disabled = false }
}

$('live-create').onsubmit = event => { event.preventDefault(); void createTerminal() }
$('live-engine').onchange = () => { $('live-model').value = ''; updateModelChoices() }
addEventListener('quiet:design', () => { if (canvas.dataset.live === 'true') visible(false) })
$('live-reconnect').onclick = async () => {
  if (opening) return
  opening = true
  $('live-reconnect').disabled = true
  const result = await getJson('/api/terminals')
  opening = false
  if (result.status === 401) {
    $('live-launch').showModal()
    await load()
  } else if (!result.ok) {
    $('live-status').textContent = `Could not reconnect: ${errorText(result)}`
    $('live-reconnect').disabled = false
  } else if (result.data.sessions?.some(item => item.id === session?.id)) connect()
  else { session = null; remember(null); $('live-status').textContent = 'Session ended. Return to the design to open another.' }
}
