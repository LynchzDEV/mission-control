import { getJson, readArray } from './shared'

export type TranscriptRow = { kind: string; text: string; title: string; detail: string; input: string; result: string; isError: boolean }
export type TranscriptHandle = { root: HTMLElement; start(): void; stop(): void; refresh(): Promise<void>; focus(): void }

const POLL_MS = 2000
const PINNED_PX = 80
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' && value !== '' ? value : fallback)

export function transcriptRows(messages: unknown): TranscriptRow[] {
  return readArray(messages).map((raw) => ({ kind: str(raw.kind, 'text'), text: str(raw.text), title: str(raw.title), detail: str(raw.detail), input: str(raw.input), result: str(raw.result), isError: raw.isError === true }))
}

export function rowKey(row: TranscriptRow): string {
  return `${row.kind}|${row.title}|${row.detail.length}|${row.text.length}|${row.result.length}|${row.isError}`
}

export function pasteSequence(text: string): string {
  return `\x1b[200~${text}\x1b[201~\r`
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== '') node.textContent = text
  return node
}

export function renderRow(row: TranscriptRow): HTMLElement {
  if (row.kind === 'prompt') { const p = el('p', 'command'); p.append(el('span', 'prompt', '›'), document.createTextNode(row.text)); return p }
  if (row.kind === 'thinking') { const box = el('details', 'thought'); box.append(el('summary', '', 'Thinking'), el('p', '', row.text)); return box }
  if (row.kind === 'result') return el('p', `result${row.isError ? ' err' : ''}`, row.text)
  if (row.kind === 'tool') {
    const wrap = el('div', 'tool-row')
    const line = el('div', `file-line${row.result ? ' has-result' : ''}`)
    line.append(el('span', '', row.title), el('code', '', row.detail || row.input))
    wrap.append(line)
    if (row.result) {
      const output = el('pre', `tool-result${row.isError ? ' err' : ''}`, row.result)
      output.hidden = true
      line.onclick = () => { output.hidden = !output.hidden }
      wrap.append(output)
    }
    return wrap
  }
  return el('p', 'reply', row.text)
}

export function createTranscript(terminalId: string, send: (data: string) => void): TranscriptHandle {
  const root = el('div', 'transcript-pane')
  const log = el('div', 'transcript')
  log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite')
  const empty = el('p', 'transcript-empty', 'Waiting for the session to start writing its transcript…')
  const cursor = el('span', 'cursor'); cursor.setAttribute('aria-hidden', 'true')
  log.append(empty, cursor)
  const composer = el('div', 'input-line')
  const input = document.createElement('textarea')
  input.rows = 1; input.placeholder = 'Give a direction…'; input.setAttribute('aria-label', 'Send to this session')
  composer.append(el('span', 'input-prompt', '›'), input, el('kbd', '', '↵'))
  root.append(log, composer)

  const nodes: HTMLElement[] = []
  const keys: string[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let generation = 0

  const submit = (): void => {
    const text = input.value.trim()
    if (text === '') return
    send(pasteSequence(text))
    input.value = ''
    input.style.height = ''
  }
  input.onkeydown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submit()
  }
  input.oninput = () => { input.style.height = ''; input.style.height = `${Math.min(160, input.scrollHeight)}px` }

  const sync = (rows: TranscriptRow[], bound: boolean): void => {
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < PINNED_PX
    empty.textContent = bound ? 'No messages yet.' : 'Waiting for the session to start writing its transcript…'
    empty.hidden = rows.length > 0
    for (let index = 0; index < rows.length; index++) {
      const key = rowKey(rows[index]!)
      if (keys[index] === key) continue
      const node = renderRow(rows[index]!)
      if (nodes[index]) nodes[index]!.replaceWith(node)
      else log.insertBefore(node, cursor)
      nodes[index] = node; keys[index] = key
    }
    while (nodes.length > rows.length) { nodes.pop()!.remove(); keys.pop() }
    if (pinned) log.scrollTop = log.scrollHeight
  }

  async function refresh(): Promise<void> {
    const request = ++generation
    const result = await getJson(`/api/terminals/${encodeURIComponent(terminalId)}/thread`)
    if (request !== generation || !result.ok) return
    sync(transcriptRows(result.data.messages), result.data.bound === true)
  }

  return {
    root,
    start() { if (timer !== undefined) return; void refresh(); timer = setInterval(() => { if (!document.hidden) void refresh() }, POLL_MS) },
    stop() { clearInterval(timer); timer = undefined; generation++ },
    refresh,
    focus() { input.focus() },
  }
}
