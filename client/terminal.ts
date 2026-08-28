import { errorText, getJson, postJson, readArray } from './shared'

type TerminalSession = {
  id: string
  engine: string
  cwd: string
  title: string
}

type XtermInstance = {
  open(host: HTMLElement): void
  write(data: string): void
  onData(listener: (data: string) => void): void
  dispose(): void
}

type FitAddonInstance = { fit(): void }

type XtermGlobals = {
  Terminal?: new (options: Record<string, unknown>) => XtermInstance
  FitAddon?: { FitAddon: new () => FitAddonInstance }
}

const CLOSE_TERMINAL_NOT_FOUND = 4404
const CLOSE_TERMINAL_ENDED = 4410

const ACCENT: Record<string, string> = {
  claude: 'c-claude',
  glm: 'c-glm',
  codex: 'c-white',
}

const THEME = {
  background: '#0d0d0f',
  foreground: '#d8d8d8',
  cursor: '#33ff66',
  selectionBackground: '#2a2a30',
}

let sessions: TerminalSession[] = []
let attachedId: string | null = null
let term: XtermInstance | null = null
let fit: FitAddonInstance | null = null
let socket: WebSocket | null = null

function el<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

function xterm(): XtermGlobals {
  return window as unknown as XtermGlobals
}

function say(message: string, ok = false): void {
  const box = el('#term-msg')
  if (box === null) return
  box.textContent = message
  box.classList.toggle('ok', ok)
}

function toSession(raw: Record<string, unknown>): TerminalSession {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const engine = typeof raw.engine === 'string' ? raw.engine : '?'
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  const title = typeof raw.title === 'string' ? raw.title : `${engine.toUpperCase()} · ${id}`
  return { id, engine, cwd, title }
}

function renderStrip(): void {
  const strip = el('#term-strip')
  const none = el('#term-none')
  const newButton = el('#term-new')
  if (strip === null) return

  strip.querySelectorAll('a[data-term]').forEach((tab) => tab.remove())
  if (none !== null) none.hidden = sessions.length > 0

  for (const session of sessions) {
    const tab = document.createElement('a')
    tab.href = '#'
    tab.dataset.term = session.id
    if (session.id === attachedId) tab.className = 'on'

    const tag = document.createElement('span')
    tag.className = `tag ${ACCENT[session.engine] ?? 'c-white'}`
    tag.textContent = session.engine.toUpperCase()
    tab.appendChild(tag)
    tab.append(session.title.replace(/^[A-Z]+ · /, ''))

    const close = document.createElement('span')
    close.className = 'x'
    close.textContent = '×'
    close.title = 'kill session'
    close.onclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      void killSession(session.id)
    }
    tab.appendChild(close)

    tab.onclick = (event) => {
      event.preventDefault()
      attach(session.id)
    }
    strip.insertBefore(tab, newButton)
  }
}

function detach(): void {
  socket?.close()
  socket = null
  term?.dispose()
  term = null
  fit = null
  attachedId = null
}

function resetPane(): void {
  const pane = el('#term-pane')
  if (pane === null) return
  pane.classList.remove('live')
  pane.textContent = 'NO SESSION ATTACHED'
}

function sendResize(): void {
  if (fit === null || socket === null || socket.readyState !== WebSocket.OPEN) return
  fit.fit()
  const view = term as unknown as { cols?: number; rows?: number } | null
  socket.send(JSON.stringify({ type: 'resize', cols: view?.cols, rows: view?.rows }))
}

function attach(id: string): void {
  const globals = xterm()
  const pane = el('#term-pane')
  if (pane === null) return
  if (globals.Terminal === undefined || globals.FitAddon === undefined) {
    say('XTERM VENDOR ASSETS ARE MISSING — RUN BUN INSTALL')
    return
  }
  if (attachedId === id) return

  detach()
  attachedId = id
  pane.textContent = ''
  pane.classList.add('live')

  const instance = new globals.Terminal({
    convertEol: false,
    cursorBlink: true,
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 13,
    theme: THEME,
  })
  const addon = new globals.FitAddon.FitAddon()
  ;(instance as unknown as { loadAddon(addon: unknown): void }).loadAddon(addon)
  instance.open(pane)
  addon.fit()
  term = instance
  fit = addon

  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const connection = new WebSocket(`${scheme}//${location.host}/ws/terminal/${id}`)
  connection.binaryType = 'arraybuffer'
  socket = connection

  connection.onopen = () => {
    sendResize()
    say(`ATTACHED · ${id.slice(0, 8)}`, true)
  }
  connection.onmessage = (event) => {
    const data = event.data
    instance.write(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer))
  }
  connection.onclose = (event) => {
    if (socket !== connection) return
    if (event.code === CLOSE_TERMINAL_ENDED || event.code === CLOSE_TERMINAL_NOT_FOUND) {
      instance.write('\r\n[session ended]\r\n')
      say('SESSION ENDED')
      void refresh()
      return
    }
    instance.write('\r\n[detached]\r\n')
  }
  instance.onData((data) => {
    if (connection.readyState === WebSocket.OPEN) connection.send(new TextEncoder().encode(data))
  })

  renderStrip()
}

async function killSession(id: string): Promise<void> {
  const response = await fetch(`/api/terminals/${id}`, { method: 'DELETE' })
  if (!response.ok) {
    say('COULD NOT KILL SESSION')
    return
  }
  if (attachedId === id) {
    detach()
    resetPane()
  }
  say('SESSION KILLED', true)
  await refresh()
}

async function refresh(): Promise<void> {
  const result = await getJson('/api/terminals')
  const raw = Array.isArray(result.data) ? result.data : (result.data as { sessions?: unknown }).sessions
  sessions = result.ok ? readArray(raw).map(toSession) : []
  if (attachedId !== null && !sessions.some((session) => session.id === attachedId)) {
    detach()
    resetPane()
  }
  renderStrip()
}

function toggleForm(open: boolean): void {
  const form = el<HTMLFormElement>('#term-form')
  if (form === null) return
  form.hidden = !open
  if (open) el<HTMLInputElement>('#term-cwd')?.focus()
}

async function openTerminal(event: Event): Promise<void> {
  event.preventDefault()
  const engine = el<HTMLSelectElement>('#term-engine')?.value ?? 'claude'
  const cwd = el<HTMLInputElement>('#term-cwd')?.value.trim() ?? ''
  if (cwd === '') {
    say('CWD IS REQUIRED')
    return
  }
  const dimensions = term as unknown as { cols?: number; rows?: number } | null
  const result = await postJson('/api/terminals', {
    engine,
    cwd,
    cols: dimensions?.cols ?? 80,
    rows: dimensions?.rows ?? 24,
  })
  if (!result.ok) {
    say(errorText(result).toUpperCase())
    return
  }
  say('SESSION OPEN', true)
  toggleForm(false)
  await refresh()
  const id = result.data.id
  if (typeof id === 'string') attach(id)
}

export function installTerminals(): void {
  if (el('#term-strip') === null) return
  el('#term-new')?.addEventListener('click', () => toggleForm(true))
  el('#term-cancel')?.addEventListener('click', () => toggleForm(false))
  el<HTMLFormElement>('#term-form')?.addEventListener('submit', (event) => void openTerminal(event))
  addEventListener('resize', sendResize)
  void refresh()
}

installTerminals()
