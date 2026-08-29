import {
  THREAD_POLL_MS,
  createThreadList,
  fetchThread,
  sendReply,
  type ThreadModel,
  type ThreadRow,
} from './thread-view'

export type ThreadPanel = {
  root: HTMLElement
  start(): void
  stop(): void
}

export type ThreadPanelOptions = { reply: boolean; pollMs?: number }

export const SINGLE_TURN_NOTE = 'SINGLE-TURN ENGINE · NO REPLY'
export const NO_SESSION_NOTE = 'NO SESSION ID YET · REPLY OPENS WHEN THE ENGINE REPORTS ONE'

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
  if (model === null) return ''
  if (model.canReply) return ''
  return model.engine === 'codex' || model.engine === 'claude' || model.engine === 'glm'
    ? NO_SESSION_NOTE
    : SINGLE_TURN_NOTE
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== '') node.textContent = text
  return node
}

export function createThreadPanel(jobId: string, options: ThreadPanelOptions): ThreadPanel {
  const pollMs = options.pollMs ?? THREAD_POLL_MS
  const root = el('div', 'tpanel')
  const listHost = el('div', 'tlist')
  const list = createThreadList(listHost)
  root.appendChild(listHost)

  const input = document.createElement('textarea')
  const send = document.createElement('button')
  const note = el('div', 'tnote')
  const form = el('div', 'tform')
  if (options.reply) {
    input.className = 'tinput'
    input.rows = 1
    input.placeholder = 'reply to this agent…'
    send.className = 'btn xs go'
    send.type = 'button'
    send.textContent = 'SEND'
    form.append(input, send)
    note.hidden = true
    root.append(form, note)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = true
  let last: ThreadModel | null = null
  let nonce = 0

  function applyReplyState(model: ThreadModel | null): void {
    if (!options.reply) return
    const message = replyNote(model)
    note.hidden = message === ''
    note.textContent = message
    const blocked = model === null || !model.canReply
    input.disabled = blocked
    send.disabled = blocked
  }

  function schedule(): void {
    clearTimeout(timer)
    if (stopped) return
    timer = setTimeout(() => void tick(), pollMs)
  }

  async function tick(): Promise<void> {
    const model = await fetchThread(jobId)
    if (stopped || model === null) return
    last = model
    list.sync(model)
    applyReplyState(model)
    if (model.running) schedule()
  }

  async function submit(): Promise<void> {
    const message = input.value.trim()
    if (message === '' || input.disabled) return
    input.value = ''
    if (last !== null) {
      nonce += 1
      last = { ...last, rows: [...last.rows, optimisticRow(jobId, message, nonce)], running: true }
      list.sync(last)
    }
    const error = await sendReply(jobId, message)
    if (error !== '') {
      note.hidden = false
      note.textContent = error
      return
    }
    stopped = false
    await tick()
  }

  if (options.reply) {
    send.onclick = () => void submit()
    input.onkeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      void submit()
    }
  }

  return {
    root,
    start(): void {
      stopped = false
      void tick()
    },
    stop(): void {
      stopped = true
      clearTimeout(timer)
    },
  }
}
