import {
  DRAWER_POLL_MS,
  createFullList,
  fetchThread,
  sendReply,
  threadCounts,
  type ThreadModel,
  type ThreadRow,
} from './thread-view'

export type DrawerTarget = { id: string; label: string; engine: string; elapsed: string }

export const HINT_TEXT = '↵ send · ⇧↵ newline · continues the same session'
export const SINGLE_TURN_NOTE = 'Single-turn engine · no reply'
export const NO_SESSION_NOTE = 'No session id yet · reply opens when the engine reports one'
export const OPEN_CLASS = 'mcd-open'

export function optimisticRow(jobId: string, text: string, nonce: number): ThreadRow {
  return {
    key: `pending#${nonce}`,
    jobId,
    role: 'user',
    kind: 'prompt',
    text,
    title: '',
    detail: '',
    input: '',
    result: '',
    isError: false,
  }
}

export function replyNote(model: ThreadModel | null): string {
  if (model === null || model.canReply) return ''
  return model.engine === 'codex' || model.engine === 'claude' || model.engine === 'glm'
    ? NO_SESSION_NOTE
    : SINGLE_TURN_NOTE
}

export function headerStats(model: ThreadModel | null): string {
  if (model === null) return ''
  const counts = threadCounts(model)
  return `${counts.tools} tools · ${counts.thoughts} thoughts`
}

export function statusLabel(model: ThreadModel | null): string {
  if (model === null) return '…'
  return model.running ? 'Running' : 'Done'
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== '') node.textContent = text
  return node
}

type Shell = {
  root: HTMLElement
  name: HTMLElement
  chip: HTMLElement
  elapsed: HTMLElement
  status: HTMLElement
  stats: HTMLElement
  transcript: HTMLElement
  note: HTMLElement
  input: HTMLTextAreaElement
  send: HTMLButtonElement
  close: HTMLButtonElement
}

let shell: Shell | null = null
let openId = ''
let timer: ReturnType<typeof setTimeout> | undefined
let last: ThreadModel | null = null
let list: ReturnType<typeof createFullList> | null = null
let nonce = 0
let opener: HTMLElement | null = null
let focusPending = false
const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', glm: 'GLM' }

function glyph(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI!, 'path'); path.setAttribute('d', d); svg.append(path)
  return svg
}

function trapFocus(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || shell === null) return
  const focusable = [...shell.root.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])')]
  const first = focusable[0], last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

function buildShell(root: HTMLElement): Shell {
  root.textContent = ''
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'mcd-title')
  const name = el('h2'); name.id = 'mcd-title'
  const chip = el('span', 'mcd-chip')
  const elapsed = el('span', 'mcd-el')
  const status = el('span', 'st')
  const identity = el('div', 'mcd-identity')
  identity.append(name, chip, elapsed, status)
  const stats = el('div', 'mcd-stats')
  const close = document.createElement('button')
  close.type = 'button'; close.className = 'mcd-close'; close.title = 'Close (Esc)'; close.setAttribute('aria-label', 'Close conversation')
  close.append(glyph('M5 5l10 10M15 5L5 15'))
  close.onclick = closeDrawer
  const head = el('div', 'mcd-head')
  head.append(identity, stats, close)

  const transcript = el('div', 'mcd-tx')
  const note = el('div', 'mcd-note')
  note.hidden = true; note.setAttribute('role', 'alert')
  const input = document.createElement('textarea')
  input.placeholder = 'Reply to this agent…'; input.rows = 2; input.setAttribute('aria-label', 'Reply to this agent')
  const send = document.createElement('button')
  send.type = 'button'; send.className = 'mcd-send'; send.textContent = 'Send'
  const compose = el('div', 'mcd-compose')
  compose.append(input, send)
  const foot = el('div', 'mcd-foot')
  foot.append(note, compose, el('div', 'mcd-hint', HINT_TEXT))

  root.append(head, transcript, foot)
  root.addEventListener('keydown', trapFocus)
  return { root, name, chip, elapsed, status, stats, transcript, note, input, send, close }
}

function applyModel(model: ThreadModel): void {
  if (shell === null) return
  last = model
  list?.sync(model)
  shell.status.textContent = statusLabel(model)
  shell.stats.textContent = headerStats(model)
  const note = replyNote(model)
  shell.note.hidden = note === ''
  shell.note.textContent = note
  shell.input.disabled = !model.canReply
  shell.send.disabled = !model.canReply
  if (focusPending && model.canReply) { focusPending = false; shell.input.focus() }
}

async function tick(): Promise<void> {
  const jobId = openId
  if (jobId === '') return
  const model = await fetchThread(jobId)
  if (openId !== jobId || model === null) return
  applyModel(model)
  clearTimeout(timer)
  if (model.running) timer = setTimeout(() => void tick(), DRAWER_POLL_MS)
}

async function submit(): Promise<void> {
  if (shell === null || openId === '') return
  const message = shell.input.value.trim()
  if (message === '' || shell.input.disabled) return
  shell.input.value = ''
  if (last !== null) {
    nonce += 1
    applyModel({ ...last, rows: [...last.rows, optimisticRow(openId, message, nonce)], running: true })
  }
  const error = await sendReply(openId, message)
  if (error !== '') {
    shell.note.hidden = false
    shell.note.textContent = error
    return
  }
  await tick()
}

export function drawerJobId(): string {
  return openId
}

export function isDrawerOpen(jobId: string): boolean {
  return openId === jobId
}

export function closeDrawer(): void {
  openId = ''
  last = null
  focusPending = false
  clearTimeout(timer)
  document.body.classList.remove(OPEN_CLASS)
  opener?.focus()
  opener = null
}

export function openDrawer(target: DrawerTarget): void {
  const root = document.getElementById('mc-drawer')
  if (root === null) return
  if (shell === null || shell.root !== root) {
    shell = buildShell(root)
    shell.send.onclick = () => void submit()
    shell.input.onkeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      void submit()
    }
  }

  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  focusPending = true
  openId = target.id
  last = null
  clearTimeout(timer)
  root.dataset.engine = target.engine
  shell.name.textContent = target.label
  shell.chip.textContent = PROVIDER_LABEL[target.engine] ?? target.engine
  shell.elapsed.textContent = target.elapsed
  shell.status.textContent = '…'
  shell.stats.textContent = headerStats(null)
  shell.note.hidden = true
  shell.transcript.textContent = ''
  list = createFullList(shell.transcript)
  document.body.classList.add(OPEN_CLASS)
  shell.close.focus()
  void tick()
}

export function installDrawer(): void {
  if (document.getElementById('mc-drawer') === null) return
  document.getElementById('mc-dim')?.addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeDrawer()
  })
}
