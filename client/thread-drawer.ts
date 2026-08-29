import {
  DRAWER_POLL_MS,
  createFullList,
  engineClass,
  fetchThread,
  sendReply,
  threadCounts,
  type ThreadModel,
  type ThreadRow,
} from './thread-view'

export type DrawerTarget = { id: string; label: string; engine: string; elapsed: string }

export const HINT_TEXT = '↵ SEND · ⇧↵ NEWLINE · continues the same session (resume)'
export const SINGLE_TURN_NOTE = 'SINGLE-TURN ENGINE · NO REPLY'
export const NO_SESSION_NOTE = 'NO SESSION ID YET · REPLY OPENS WHEN THE ENGINE REPORTS ONE'
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
  if (model === null) return 'ESC CLOSE'
  const counts = threadCounts(model)
  return `${counts.tools} TOOLS · ${counts.thoughts} THOUGHTS · ESC CLOSE`
}

export function statusLabel(model: ThreadModel | null): string {
  if (model === null) return '…'
  return model.running ? 'RUNNING' : 'DONE'
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
}

let shell: Shell | null = null
let openId = ''
let timer: ReturnType<typeof setTimeout> | undefined
let last: ThreadModel | null = null
let list: ReturnType<typeof createFullList> | null = null
let nonce = 0

function buildShell(root: HTMLElement): Shell {
  root.textContent = ''
  const name = el('b')
  const chip = el('span')
  const elapsed = el('span', 'mcd-el')
  const status = el('span', 'st')
  const left = el('div')
  left.append(name, el('span', 'mcd-sep', '·'), chip, el('span', 'mcd-sep', '·'), elapsed, el('span', 'mcd-sep', '·'), status)
  const stats = el('div', 'mcd-stats')
  const head = el('div', 'mcd-head')
  head.append(left, stats)

  const transcript = el('div', 'mcd-tx')
  const hint = el('div', 'mcd-hint', HINT_TEXT)
  const note = el('div', 'mcd-note')
  note.hidden = true

  const input = document.createElement('textarea')
  input.placeholder = 'reply to this agent…'
  const send = document.createElement('button')
  send.type = 'button'
  send.textContent = 'SEND'
  const foot = el('div', 'mcd-foot')
  foot.append(input, send)

  root.append(head, transcript, note, hint, foot)
  return { root, name, chip, elapsed, status, stats, transcript, note, input, send }
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
  clearTimeout(timer)
  document.body.classList.remove(OPEN_CLASS)
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

  openId = target.id
  last = null
  clearTimeout(timer)
  shell.name.textContent = target.label
  shell.chip.className = engineClass(target.engine)
  shell.chip.textContent = target.engine.toUpperCase()
  shell.elapsed.textContent = target.elapsed
  shell.status.textContent = '…'
  shell.stats.textContent = headerStats(null)
  shell.note.hidden = true
  shell.transcript.textContent = ''
  list = createFullList(shell.transcript)
  document.body.classList.add(OPEN_CLASS)
  void tick()
}

export function installDrawer(): void {
  if (document.getElementById('mc-drawer') === null) return
  document.getElementById('mc-dim')?.addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeDrawer()
  })
}
