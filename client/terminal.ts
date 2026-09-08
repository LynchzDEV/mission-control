import { restoreLayout, selectSession, visibleSessions, type TerminalLayout } from './terminal-layout'
import { installModelPickers } from './model-picker'
import { icon, ui, providerName, connectionLabel, installTerminalShell } from './terminal-view'
import { errorText, getJson, pathsFromUriList, postJson, readArray, shellQuote } from './shared'

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
  clear(): void
  getSelection(): string
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
}

type FitAddonInstance = { fit(): void }

type SearchAddonInstance = {
  findNext(term: string): boolean
  findPrevious(term: string): boolean
  clearDecorations(): void
}

type XtermGlobals = {
  Terminal?: new (options: Record<string, unknown>) => XtermInstance
  FitAddon?: { FitAddon: new () => FitAddonInstance }
  WebLinksAddon?: { WebLinksAddon: new () => unknown }
  SearchAddon?: { SearchAddon: new () => SearchAddonInstance }
}

const CLOSE_TERMINAL_NOT_FOUND = 4404
const CLOSE_TERMINAL_ENDED = 4410

const THEME = {
  background: '#070a0c',
  foreground: '#e9eef0',
  cursor: '#579caa',
  selectionBackground: '#344f68',
}

let sessions: TerminalSession[] = []
let attachedId: string | null = null
let term: XtermInstance | null = null
let fit: FitAddonInstance | null = null
let search: SearchAddonInstance | null = null
let socket: WebSocket | null = null

const LAYOUT_KEY = 'mc.term.layout.v2'
type SessionView = { root: HTMLElement; host: HTMLElement; term: XtermInstance; fit: FitAddonInstance; search: SearchAddonInstance | null; socket: WebSocket; observer: ResizeObserver }
const views = new Map<string, SessionView>()
let layout: TerminalLayout = restoreLayout(null, [])
let initialized = false
let splitNext = false
let creating = false

function saveLayout(): void {
  if (!initialized) return
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch {}
}

function resizeView(view: SessionView): void {
  if (view.host.getBoundingClientRect().width < 1 || view.root.hidden) return
  view.fit.fit()
  const dimensions = view.term as unknown as { cols: number; rows: number }
  if (view.socket.readyState === WebSocket.OPEN) view.socket.send(JSON.stringify({ type: 'resize', cols: dimensions.cols, rows: dimensions.rows }))
}

function activate(id: string): void {
  const view = views.get(id)
  if (!view) return
  if (attachedId !== id) closeSearchBox()
  attachedId = id
  layout.active = id
  term = view.term
  fit = view.fit
  search = view.search
  socket = view.socket
  const session = sessions.find(entry => entry.id === id)
  const state = view.root.dataset.connection
  say(`${state === 'live' ? 'Connected' : state === 'error' ? 'Connection failed' : state === 'closed' ? 'Disconnected' : 'Connecting'} · ${session ? displayName(session) : id}${state === 'error' || state === 'closed' ? '. Use Reconnect to retry.' : ''}`, state === 'live')
  announceScope(id, sessions.find((entry) => entry.id === id)?.cwd ?? null)
}

function paintLayout(): void {
  const deck = el('#term-pane')
  if (!deck) return
  const visible = visibleSessions(layout, innerWidth)
  deck.dataset.axis = layout.axis
  deck.dataset.count = String(visible.length)
  deck.style.setProperty('--split-ratio', `${layout.ratio}%`)
  deck.style.setProperty('--split-first', `${layout.ratio}fr`)
  deck.style.setProperty('--split-second', `${100 - layout.ratio}fr`)
  for (const [id, view] of views) {
    view.root.hidden = !visible.includes(id)
    const position = visible.indexOf(id)
    view.root.dataset.position = String(position)
    view.root.dataset.divider = String(position >= 0 && visible.length > 1 && (layout.axis === 'vertical' ? position < (visible.length > 2 ? 2 : 1) : position % 2 === 0 && position < visible.length - 1))
    view.root.style.order = String(layout.ids.indexOf(id))
    view.root.classList.toggle('is-active', id === layout.active)
    const focusPane = view.root.querySelector<HTMLButtonElement>('.session-focus')
    if (focusPane) {
      const focused = layout.focused && id === layout.active
      focusPane.replaceChildren(icon(focused ? 'restore' : 'focus'))
      focusPane.setAttribute('aria-pressed', String(focused)); focusPane.setAttribute('aria-label', focused ? 'Restore terminal layout' : 'Focus this terminal'); focusPane.title = focused ? 'Restore' : 'Focus'
    }
    const state = view.root.querySelector<HTMLElement>('.connection-state')
    if (state) state.textContent = connectionLabel(view.root.dataset.connection)
    view.root.querySelector('.terminal-resizer')?.setAttribute('aria-orientation', layout.axis === 'horizontal' ? 'vertical' : 'horizontal')
    if (!view.root.hidden) requestAnimationFrame(() => resizeView(view))
  }
  const welcome = el('#terminal-welcome')
  if (welcome) welcome.hidden = sessions.length > 0
  const heading = el('#workspace-name')
  const path = el('#workspace-path')
  const session = sessions.find((entry) => entry.id === layout.active)
  if (heading) heading.textContent = 'Terminals'
  if (path) { path.textContent = `${sessions.length} sessions`; path.title = session?.cwd ?? '' }
  el('#split-horizontal')?.setAttribute('aria-pressed', String(layout.axis === 'horizontal'))
  el('#split-vertical')?.setAttribute('aria-pressed', String(layout.axis === 'vertical'))
  const focus = el('#term-focus')
  if (focus) { focus.textContent = layout.focused ? 'Restore' : 'Focus'; focus.setAttribute('aria-pressed', String(layout.focused)) }
  renderStrip()
  saveLayout()
}

function disposeView(id: string): void {
  if (attachedId === id) closeSearchBox()
  const view = views.get(id)
  if (!view) return
  views.delete(id)
  view.observer.disconnect()
  view.socket.close()
  view.term.dispose()
  view.root.remove()
  if (attachedId === id) { attachedId = null; term = null; fit = null; search = null; socket = null }
}

function split(axis: TerminalLayout['axis']): void {
  if (layout.ids.length > 1 && layout.axis !== axis) { layout.axis = axis; layout.focused = false; paintLayout(); return }
  if (layout.ids.length >= 4) { say('Four panes are already visible. Switch a pane or hide one before splitting.'); return }
  layout.axis = axis
  const peer = sessions.find((entry) => !layout.ids.includes(entry.id))
  splitNext = true
  if (peer) attach(peer.id)
  else { say('Choose another session, or open a new terminal to add a split.', true); toggleForm(true) }
}

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
  box.hidden = /^(Connected|Connecting) ·/.test(message)
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
  if (strip === null || strip.querySelector('input.rename')) return

  for (const tab of strip.querySelectorAll<HTMLAnchorElement>('a[data-term]')) {
    if (!sessions.some(session => session.id === tab.dataset.term)) tab.remove()
  }
  if (none !== null) none.hidden = sessions.length > 0

  for (const session of sessions) {
    const existing = [...strip.querySelectorAll<HTMLAnchorElement>('a[data-term]')].find(tab => tab.dataset.term === session.id)
    if (existing) {
      existing.className = `session-choice${session.id === attachedId ? ' on' : ''}`
      existing.setAttribute('aria-current', String(session.id === attachedId))
      const name = existing.querySelector<HTMLElement>('.name')
      if (name) name.textContent = displayName(session)
      const state = existing.querySelector<HTMLElement>('.session-state')
      if (state) state.textContent = `${providerName(session.engine)} · ${views.has(session.id) ? connectionLabel(views.get(session.id)!.root.dataset.connection) : 'Available'}`
      continue
    }
    const tab = document.createElement('a')
    tab.href = '#'
    tab.dataset.term = session.id
    tab.dataset.engine = session.engine
    tab.className = `session-choice${session.id === attachedId ? ' on' : ''}`
    tab.setAttribute('aria-current', session.id === attachedId ? 'true' : 'false')
    tab.title = session.cwd

    const glyph = ui('span', 'glyph'); glyph.append(icon('terminal')); tab.append(glyph)
    const copy = ui('span', 'session-copy')
    const name = document.createElement('strong')
    name.className = 'name'
    name.textContent = displayName(session)
    name.title = 'double-click to rename'
    name.ondblclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      editName(session, name)
    }
    copy.append(name, ui('small', 'session-state', `${providerName(session.engine)} · ${views.has(session.id) ? connectionLabel(views.get(session.id)!.root.dataset.connection) : 'Available'}`))
    tab.append(copy)
    tab.onkeydown = event => { if (event.key === 'F2') { event.preventDefault(); editName(session, name) } }
    tab.title = `${session.cwd} · F2 to rename`

    const close = document.createElement('span')
    close.className = 'x'
    close.setAttribute('role', 'button')
    close.tabIndex = 0
    close.setAttribute('aria-label', `End ${displayName(session)}`)
    close.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void killSession(session.id) } }
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
  const directory = el('#directory-list')
  if (!directory) return
  directory.replaceChildren()
  const groups = new Map<string, TerminalSession[]>()
  for (const session of sessions) groups.set(session.cwd, [...(groups.get(session.cwd) ?? []), session])
  for (const [cwd, peers] of groups) {
    const group = document.createElement('section')
    const title = document.createElement('h3')
    title.textContent = cwd.split('/').filter(Boolean).pop() ?? cwd
    title.title = cwd
    const exact = document.createElement('small')
    exact.textContent = cwd
    group.append(title, exact)
    for (const peer of peers) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = displayName(peer)
      button.title = `${peer.engine} · ${cwd}`
      button.classList.toggle('on', peer.id === attachedId)
      button.setAttribute('aria-current', String(peer.id === attachedId))
      button.onclick = () => attach(peer.id)
      group.append(button)
    }
    directory.append(group)
  }
  if (groups.size === 0) directory.textContent = 'Your directories appear here when you open a terminal.'
}

function displayName(session: TerminalSession): string {
  return session.title.replace(/^[A-Z]+ · /, '')
}

function editName(session: TerminalSession, name: HTMLElement): void {
  session = sessions.find(entry => entry.id === session.id) ?? session
  const input = document.createElement('input')
  input.className = 'rename'
  input.value = displayName(session)
  input.maxLength = 60
  let settled = false
  const finish = (save: boolean): void => {
    if (settled) return
    settled = true
    const next = input.value.trim()
    input.replaceWith(name)
    name.textContent = displayName(session)
    if (!save || next === '' || next === displayName(session)) {
      renderStrip()
      return
    }
    void renameSession(session.id, next).catch(() => say('Could not rename session.'))
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') finish(true)
    else if (event.key === 'Escape') finish(false)
    event.stopPropagation()
  }
  input.onblur = () => finish(true)
  input.onclick = (event) => event.stopPropagation()
  name.replaceWith(input)
  input.focus()
  input.select()
}

async function renameSession(id: string, title: string): Promise<void> {
  const response = await fetch(`/api/terminals/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (response.ok) { const titleButton = views.get(id)?.root.querySelector('button'); if (titleButton) titleButton.textContent = title }
  say(response.ok ? 'RENAMED' : 'COULD NOT RENAME', response.ok)
  await refresh()
}

function announceScope(id: string | null, cwd: string | null): void {
  dispatchEvent(new CustomEvent('mc:terminal-scope', { detail: { id, cwd } }))
}

function searchBox(): HTMLInputElement | null {
  return el<HTMLInputElement>('#term-search')
}

function closeSearchBox(): void {
  const box = searchBox()
  if (box === null) return
  box.hidden = true
  box.value = ''
  search?.clearDecorations()
}

function openSearchBox(): void {
  if (!attachedId || !views.has(attachedId) || !search) { closeSearchBox(); say('Open a terminal before using Find.'); return }
  let box = searchBox()
  if (box === null) {
    box = document.createElement('input')
    box.id = 'term-search'
    box.setAttribute('aria-label', 'Search active terminal')
    box.placeholder = 'find… (enter next · shift+enter prev · esc close)'
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSearchBox()
        return
      }
      if (event.key !== 'Enter' || search === null || box === null) return
      event.preventDefault()
      if (event.shiftKey) search.findPrevious(box.value)
      else search.findNext(box.value)
    })
  }
  views.get(attachedId)?.root.appendChild(box)
  box.hidden = false
  box.focus()
  box.select()
}

function sendResize(): void {
  for (const view of views.values()) resizeView(view)
}

function macShortcutHandler(instance: XtermInstance, connection: WebSocket): (event: KeyboardEvent) => boolean {
  const send = (data: string): void => {
    if (connection.readyState === WebSocket.OPEN) connection.send(new TextEncoder().encode(data))
  }
  const CTRL_A_LINE_START = '\x01'
  const CTRL_E_LINE_END = '\x05'
  const CTRL_U_KILL_LINE = '\x15'
  const ESC_CR_NEWLINE = '\x1b\r'
  return (event) => {
    if (event.type !== 'keydown') return true
    const handled = (): false => {
      event.preventDefault()
      return false
    }
    if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      send(ESC_CR_NEWLINE)
      return handled()
    }
    if (!event.metaKey) return true
    switch (event.key) {
      case 'k':
        instance.clear()
        return handled()
      case 'f':
        openSearchBox()
        return handled()
      case 'c': {
        const selected = instance.getSelection()
        if (selected === '') return true
        void navigator.clipboard.writeText(selected)
        return handled()
      }
      case 'v':
        void navigator.clipboard.readText().then(send)
        return handled()
      case 'Backspace':
        send(CTRL_U_KILL_LINE)
        return handled()
      case 'ArrowLeft':
        send(CTRL_A_LINE_START)
        return handled()
      case 'ArrowRight':
        send(CTRL_E_LINE_END)
        return handled()
      default:
        return true
    }
  }
}

function attach(id: string): void {
  const globals = xterm()
  const deck = el('#term-pane')
  if (!deck || !sessions.some((entry) => entry.id === id)) { say('This session is no longer available.'); return }
  if (!globals.Terminal || !globals.FitAddon) { say('Terminal assets unavailable. Run bun install to restore the local vendor files.'); return }
  const selected = selectSession(layout, id, splitNext)
  if (selected.limited) { say('Maximum four visible panes. Hide a pane before adding another.'); return }
  layout = selected.layout
  splitNext = false
  if (!views.has(id)) {
    const session = sessions.find((entry) => entry.id === id)!
    const root = document.createElement('section')
    root.className = 'terminal-panel'
    root.dataset.engine = session.engine
    root.setAttribute('aria-label', `${displayName(session)} terminal`)
    const header = document.createElement('div')
    header.className = 'terminal-panel-head session-heading'
    const emblem = ui('span', 'session-emblem'); emblem.append(icon('terminal'))
    const title = document.createElement('button')
    title.textContent = displayName(session)
    title.className = 'session-title'
    title.title = 'Focus this terminal; double-click to rename'
    title.ondblclick = () => { const name = prompt('Terminal name', displayName(sessions.find(entry => entry.id === id) ?? session)); if (name?.trim()) void renameSession(id, name.trim().slice(0, 60)).catch(() => say('Could not rename session.')) }
    const hide = document.createElement('button')
    hide.className = 'session-hide'
    hide.textContent = '−'
    hide.setAttribute('aria-label', `Hide ${displayName(session)} pane`)
    hide.onclick = (event) => {
      event.stopPropagation()
      if (layout.ids.length <= 1) { say('This is the last visible pane. Select another session to switch.'); return }
      layout.ids = layout.ids.filter((peer) => peer !== id)
      if (layout.active === id) activate(layout.ids[0]!)
      paintLayout()
    }
    const focusPane = document.createElement('button')
    focusPane.type = 'button'
    focusPane.className = 'session-focus expand'
    focusPane.append(icon('focus'))
    focusPane.setAttribute('aria-label', `Focus ${displayName(session)} pane`)
    focusPane.onclick = () => { activate(id); layout.focused = !layout.focused; paintLayout() }
    header.append(emblem, title, focusPane, hide)
    const caption = ui('p', 'session-caption', session.cwd)
    caption.title = session.cwd
    const host = document.createElement('div')
    host.className = 'terminal-surface'
    const handle = document.createElement('div')
    handle.className = 'terminal-resizer'
    handle.tabIndex = 0
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-label', 'Resize terminal split')
    handle.setAttribute('aria-valuemin', '25')
    handle.setAttribute('aria-valuemax', '75')
    const resize = (value: number): void => { layout.ratio = Math.max(25, Math.min(75, value)); handle.setAttribute('aria-valuenow', String(Math.round(layout.ratio))); paintLayout() }
    handle.onkeydown = (event) => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); resize(layout.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -5 : 5)) } }
    handle.onpointerdown = (event) => { event.preventDefault(); handle.setPointerCapture(event.pointerId) }
    handle.onpointermove = (event) => { if (!handle.hasPointerCapture(event.pointerId)) return; const bounds = deck.getBoundingClientRect(); resize(layout.axis === 'horizontal' ? (event.clientX - bounds.left) / bounds.width * 100 : (event.clientY - bounds.top) / bounds.height * 100) }
    const context = document.createElement('div')
    context.className = 'session-context'
    context.append(ui('span', 'provider', providerName(session.engine)), ui('span', 'model connection-state', 'Connecting'), ui('span', 'context-dot', '/'), ui('span', 'path', session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd))
    context.title = session.cwd
    root.append(header, caption, context, host, handle)
    deck.append(root)
    const instance = new globals.Terminal({ convertEol: false, cursorBlink: true, fontFamily: "'JetBrains Mono', Menlo, 'SF Mono', monospace", fontSize: 13, macOptionIsMeta: true, scrollback: 10000, theme: THEME })
    const loader = instance as unknown as { loadAddon(addon: unknown): void }
    const addon = new globals.FitAddon.FitAddon()
    loader.loadAddon(addon)
    if (globals.WebLinksAddon) loader.loadAddon(new globals.WebLinksAddon.WebLinksAddon())
    const finder = globals.SearchAddon ? new globals.SearchAddon.SearchAddon() : null
    if (finder) loader.loadAddon(finder)
    instance.open(host)
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const connection = new WebSocket(`${scheme}//${location.host}/ws/terminal/${encodeURIComponent(id)}`)
    connection.binaryType = 'arraybuffer'
    const observer = new ResizeObserver(() => { const view = views.get(id); if (view) resizeView(view) })
    const view: SessionView = { root, host, term: instance, fit: addon, search: finder, socket: connection, observer }
    views.set(id, view)
    observer.observe(host)
    root.addEventListener('pointerdown', () => { if (attachedId !== id) { activate(id); paintLayout() } })
    void document.fonts?.load("13px 'JetBrains Mono'").then(() => { const current = views.get(id); if (current === view) resizeView(view) }).catch(() => {})
    root.addEventListener('focusin', () => { if (attachedId !== id) { activate(id); paintLayout() } })
    title.onclick = () => { activate(id); paintLayout(); (instance as unknown as { focus(): void }).focus() }
    instance.attachCustomKeyEventHandler(macShortcutHandler(instance, connection))
    connection.onopen = () => { if (views.get(id) !== view || view.socket !== connection) return; resizeView(view); root.dataset.connection = 'live'; paintLayout(); if (attachedId === id) say(`Connected · ${displayName(session)}`, true) }
    connection.onmessage = (event) => { if (views.get(id) === view && view.socket === connection) instance.write(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)) }
    connection.onerror = () => { if (views.get(id) !== view || view.socket !== connection) return; root.dataset.connection = 'error'; paintLayout(); if (attachedId === id) say(`Could not connect to ${displayName(session)}. Use Reconnect to retry.`) }
    connection.onclose = (event) => {
      if (views.get(id) !== view || view.socket !== connection) return
      root.dataset.connection = 'closed'
      paintLayout()
      const ended = event.code === CLOSE_TERMINAL_ENDED || event.code === CLOSE_TERMINAL_NOT_FOUND
      instance.write(ended ? '\r\n[session ended]\r\n' : '\r\n[connection closed — use Reconnect]\r\n')
      if (attachedId === id) say(ended ? `Session ended · ${displayName(session)}` : `Disconnected · ${displayName(session)}. Use Reconnect to retry.`)
      if (ended) void refresh()
    }
    instance.onData((data) => { if (connection.readyState === WebSocket.OPEN) connection.send(new TextEncoder().encode(data)) })
    installDrop(host)
  }
  activate(id)
  paintLayout()
}

async function killSession(id: string): Promise<void> {
  const session = sessions.find((entry) => entry.id === id)
  if (!confirm(`End ${session ? displayName(session) : id}? This stops its running process.`)) return
  try {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) { say('Could not end session. Try again.'); return }
    disposeView(id)
    say('Session ended', true)
    await refresh()
  } catch { say('Could not reach the server. Session was not ended.') }
}

let refreshGeneration = 0
async function refresh(): Promise<void> {
  const generation = ++refreshGeneration
  const result = await getJson('/api/terminals')
  if (generation !== refreshGeneration) return
  if (!result.ok) { say(`Could not refresh sessions: ${errorText(result)}. Existing terminals are preserved.`); return }
  sessions = readArray(result.data.sessions).map(toSession).filter((entry) => entry.id !== '')
  if (!initialized) {
    let saved: unknown = null
    try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') } catch {}
    layout = restoreLayout(saved, sessions.map((entry) => entry.id))
    initialized = true
  } else layout = restoreLayout(layout, sessions.map((entry) => entry.id))
  for (const id of views.keys()) if (!sessions.some((entry) => entry.id === id)) disposeView(id)
  const active = layout.active
  for (const id of layout.ids) if (!views.has(id)) attach(id)
  if (active && views.has(active)) activate(active)
  if (!active) announceScope(null, null)
  paintLayout()
}

const RECENT_CWD_KEY = 'mc.term.recentCwd'
const RECENT_CWD_LIMIT = 12

function readRecentCwds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_CWD_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function rememberCwd(cwd: string): void {
  const next = [cwd, ...readRecentCwds().filter((entry) => entry !== cwd)].slice(0, RECENT_CWD_LIMIT)
  try {
    localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(next))
  } catch {
    // storage blocked — recents are a convenience only
  }
}

function fillRecentCwds(): void {
  const list = el<HTMLDataListElement>('#term-recent-cwd')
  if (list === null) return
  list.textContent = ''
  for (const cwd of readRecentCwds()) {
    const option = document.createElement('option')
    option.value = cwd
    list.appendChild(option)
  }
}

function toggleForm(open: boolean): void {
  closeSearchBox()
  const form = el<HTMLFormElement>('#term-form')
  if (form === null) return
  form.hidden = !open
  if (open) {
    fillRecentCwds()
    el<HTMLInputElement>('#term-cwd')?.focus()
  }
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function toggleSessions(open: boolean): void {
  const panel = el<HTMLDivElement>('#term-sessions')
  if (panel === null) return
  panel.hidden = !open
  if (!open) return
  const form = el<HTMLFormElement>('#term-form')
  if (form !== null) form.hidden = true
  fillRecentCwds()
  const input = el<HTMLInputElement>('#term-sessions-cwd')
  if (input === null) return
  input.value = readRecentCwds()[0] ?? ''
  if (input.value === '') input.focus()
  else void loadSessions()
}

async function loadSessions(): Promise<void> {
  const list = el<HTMLDivElement>('#term-sessions-list')
  const cwd = el<HTMLInputElement>('#term-sessions-cwd')?.value.trim() ?? ''
  if (list === null) return
  if (cwd === '') {
    say('CWD IS REQUIRED')
    return
  }
  const result = await getJson(`/api/terminals/sessions?cwd=${encodeURIComponent(cwd)}`)
  if (!result.ok) {
    list.textContent = ''
    say(errorText(result).toUpperCase())
    return
  }
  list.textContent = ''
  const rows = readArray(result.data.sessions)
  if (rows.length === 0) {
    const none = document.createElement('div')
    none.className = 'none'
    none.textContent = 'NO SESSIONS FOR THIS CWD'
    list.appendChild(none)
    return
  }
  for (const raw of rows) {
    const id = typeof raw.id === 'string' ? raw.id : ''
    const title = typeof raw.title === 'string' ? raw.title : id
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
    const bytes = typeof raw.bytes === 'number' ? raw.bytes : 0
    const row = document.createElement('a')
    row.href = '#'
    row.className = 'srow'
    row.dataset.session = id
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = title
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = `${ago(updatedAt)} · ${Math.round(bytes / 1024)} KB`
    row.append(name, meta)
    row.onclick = (event) => {
      event.preventDefault()
      void resumeSession(id, title.slice(0, 40), cwd)
    }
    list.appendChild(row)
  }
}

async function resumeSession(id: string, title: string, cwd: string): Promise<void> {
  const engine = 'claude'
  const model = el<HTMLSelectElement>('#term-engine')?.value === engine ? el<HTMLInputElement>('#term-model')?.value.trim() ?? '' : ''
  const dimensions = term as unknown as { cols?: number; rows?: number } | null
  if (creating) return
  creating = true
  say('Opening terminal…', true)
  el<HTMLButtonElement>('#term-form button[type=submit]')?.setAttribute('disabled', '')
  const result = await postJson('/api/terminals', {
    engine,
    cwd,
    resumeSessionId: id,
    title,
    ...(model !== '' ? { model } : {}),
    cols: dimensions?.cols ?? 80,
    rows: dimensions?.rows ?? 24,
  })
  creating = false
  el<HTMLButtonElement>('#term-form button[type=submit]')?.removeAttribute('disabled')
  if (!result.ok) {
    say(errorText(result).toUpperCase())
    return
  }
  say('SESSION RESUMED', true)
  rememberCwd(cwd)
  toggleSessions(false)
  await refresh()
  const terminalId = result.data.id
  if (typeof terminalId === 'string') attach(terminalId)
}

async function openTerminal(event: Event): Promise<void> {
  event.preventDefault()
  const engine = el<HTMLSelectElement>('#term-engine')?.value ?? 'claude'
  const cwd = el<HTMLInputElement>('#term-cwd')?.value.trim() ?? ''
  if (cwd === '') {
    say('CWD IS REQUIRED')
    return
  }
  const model = el<HTMLSelectElement>('#term-engine')?.value === engine ? el<HTMLInputElement>('#term-model')?.value.trim() ?? '' : ''
  const dimensions = term as unknown as { cols?: number; rows?: number } | null
  if (creating) return
  creating = true
  say('Opening terminal…', true)
  el<HTMLButtonElement>('#term-form button[type=submit]')?.setAttribute('disabled', '')
  const result = await postJson('/api/terminals', {
    engine,
    cwd,
    ...(model !== '' ? { model } : {}),
    cols: dimensions?.cols ?? 80,
    rows: dimensions?.rows ?? 24,
  })
  creating = false
  el<HTMLButtonElement>('#term-form button[type=submit]')?.removeAttribute('disabled')
  if (!result.ok) {
    say(errorText(result).toUpperCase())
    return
  }
  say('SESSION OPEN', true)
  rememberCwd(cwd)
  toggleForm(false)
  await refresh()
  const id = result.data.id
  if (typeof id === 'string') attach(id)
}

function readData(transfer: DataTransfer | null, type: string): string {
  try {
    return transfer?.getData(type) ?? ''
  } catch {
    return ''
  }
}

async function uploadDrop(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  form.append('lastModified', String(file.lastModified))
  const response = await fetch('/api/terminals/drops', { method: 'POST', body: form })
  const payload = (await response.json().catch(() => ({}))) as { error?: string; path?: string }
  if (!response.ok || typeof payload.path !== 'string') {
    const message = payload.error ?? `request failed (${response.status})`
    throw new Error(message.toUpperCase())
  }
  return payload.path
}

async function handleDrop(transfer: DataTransfer | null): Promise<void> {
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    say('ATTACH A SESSION FIRST')
    return
  }
  const wire = socket
  const typeIn = (paths: string[]): void => {
    wire.send(new TextEncoder().encode(`${paths.map(shellQuote).join(' ')} `))
    say(`DROPPED · ${paths.length} PATH${paths.length === 1 ? '' : 'S'}`, true)
  }
  const uriPaths = pathsFromUriList(readData(transfer, 'text/uri-list'))
  if (uriPaths.length > 0) {
    typeIn(uriPaths)
    return
  }
  if (transfer !== null && transfer.files.length > 0) {
    const paths: string[] = []
    for (const file of Array.from(transfer.files)) {
      try {
        paths.push(await uploadDrop(file))
      } catch (error) {
        say(error instanceof Error ? error.message : 'UPLOAD FAILED')
        return
      }
    }
    typeIn(paths)
    return
  }
  const plain = readData(transfer, 'text/plain').trim()
  if (plain !== '') {
    wire.send(new TextEncoder().encode(`${plain} `))
    say('DROPPED · 1 PATH', true)
    return
  }
  say('NOTHING DROPPABLE')
}

function installDrop(pane: HTMLElement): void {
  pane.addEventListener('dragenter', (event) => {
    event.preventDefault()
    pane.classList.add('drop')
  })
  pane.addEventListener('dragover', (event) => {
    event.preventDefault()
    pane.classList.add('drop')
  })
  pane.addEventListener('dragleave', () => pane.classList.remove('drop'))
  pane.addEventListener('drop', (event) => {
    event.preventDefault()
    pane.classList.remove('drop')
    const id = [...views.entries()].find(([, view]) => view.host === pane)?.[0]
    if (id) activate(id)
    void handleDrop((event as DragEvent).dataTransfer).catch((error) => say(error instanceof Error ? error.message : 'Drop failed'))
  })
}

export function installTerminals(): void {
  if (el('#term-strip') === null) return
  installTerminalShell()
  const directory = el('#directory-nav')
  const directoryToggle = el('#directory-toggle')
  const syncDirectory = () => {
    if (!directory) return
    directory.toggleAttribute('data-mobile-open', !directory.hidden)
    directoryToggle?.setAttribute('aria-expanded', String(!directory.hidden))
  }
  syncDirectory()
  el('#term-new')?.addEventListener('click', () => toggleForm(true))
  el('#term-cancel')?.addEventListener('click', () => { splitNext = false; toggleForm(false) })
  el('#term-resume')?.addEventListener('click', () => {
    const panel = el<HTMLDivElement>('#term-sessions')
    if (panel === null) return
    toggleSessions(panel.hidden)
  })
  el('#term-sessions-close')?.addEventListener('click', () => toggleSessions(false))
  el('#term-sessions-load')?.addEventListener('click', () => void loadSessions())
  el<HTMLInputElement>('#term-sessions-cwd')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void loadSessions()
    }
  })
  el<HTMLFormElement>('#term-form')?.addEventListener('submit', (event) => void openTerminal(event))
  installModelPickers()
  el('#welcome-new')?.addEventListener('click', () => toggleForm(true))
  el('#split-horizontal')?.addEventListener('click', () => split('horizontal'))
  el('#split-vertical')?.addEventListener('click', () => split('vertical'))
  el('#term-focus')?.addEventListener('click', () => { if (!attachedId) { say('Open a terminal before using Focus.'); return }; layout.focused = !layout.focused; paintLayout() })
  el('#term-find')?.addEventListener('click', openSearchBox)
  el('#term-reconnect')?.addEventListener('click', () => { if (attachedId) { const id = attachedId; disposeView(id); attach(id) } else say('Open a terminal before reconnecting.') })
  directoryToggle?.addEventListener('click', () => { if (directory) { directory.hidden = !directory.hidden; syncDirectory() } })
  addEventListener('resize', () => { paintLayout(); sendResize() })
  addEventListener('mc:workspace-visible', () => { paintLayout(); sendResize() })
  void refresh()
  setInterval(() => { if (!document.hidden) void refresh() }, 10000)
}

installTerminals()
