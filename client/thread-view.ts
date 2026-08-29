import { getJson, postJson, readArray, type JsonRecord } from './shared'

export type ThreadRow = {
  key: string
  jobId: string
  role: string
  kind: string
  text: string
  title: string
  detail: string
  input: string
  result: string
  isError: boolean
}

export type ThreadModel = {
  rows: ThreadRow[]
  running: boolean
  canReply: boolean
  engine: string
}

export const THREAD_POLL_MS = 2_000
export const RESULT_EXCERPT_LINES = 6

const ROW_GLYPH: Record<string, string> = {
  prompt: '›',
  thinking: '◦',
  tool: '▸',
  text: '·',
  result: '✓',
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

export function rowGlyph(row: ThreadRow): string {
  if (row.kind === 'result' && row.isError) return '✕'
  return ROW_GLYPH[row.kind] ?? '·'
}

export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

export function excerpt(text: string, maxLines: number = RESULT_EXCERPT_LINES): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n… +${lines.length - maxLines} more lines`
}

// Keys stay stable across polls because a job's log only ever grows at the end, so the nth
// message of a job is always the nth message of that job.
export function toThreadRows(messages: JsonRecord[]): ThreadRow[] {
  const seen = new Map<string, number>()
  const rows: ThreadRow[] = []
  for (const message of messages) {
    const jobId = str(message.jobId, '?')
    const index = seen.get(jobId) ?? 0
    seen.set(jobId, index + 1)
    rows.push({
      key: `${jobId}#${index}`,
      jobId,
      role: str(message.role, 'assistant'),
      kind: str(message.kind, 'text'),
      text: str(message.text),
      title: str(message.title),
      detail: str(message.detail),
      input: str(message.input),
      result: str(message.result),
      isError: message.isError === true || message.resultIsError === true,
    })
  }
  return rows
}

export function toThreadModel(data: JsonRecord): ThreadModel {
  return {
    rows: toThreadRows(readArray(data.messages)),
    running: data.running === true,
    canReply: data.canReply === true,
    engine: str(data.engine, '?'),
  }
}

export function rowSignature(row: ThreadRow): string {
  return `${row.kind}|${row.text.length}|${row.detail}|${row.result.length}|${row.isError}`
}

// A tool row with no result yet, in a still-running thread, is the step happening right now.
export function isPendingTool(row: ThreadRow, running: boolean): boolean {
  return running && row.kind === 'tool' && row.result === ''
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== '') node.textContent = text
  return node
}

function expandableBody(row: ThreadRow): HTMLElement | null {
  if (row.kind === 'thinking') return el('div', 'tbody think', row.text)
  if (row.kind !== 'tool') return null
  const body = el('div', 'tbody')
  if (row.input !== '') {
    body.append(el('div', 'tlab', 'INPUT'), el('pre', 'tpre', row.input))
  }
  if (row.result !== '') {
    body.append(
      el('div', 'tlab', row.isError ? 'RESULT · ERROR' : 'RESULT'),
      el('pre', 'tpre', excerpt(row.result)),
    )
  }
  return body.childElementCount === 0 ? null : body
}

function toolHead(row: ThreadRow): HTMLElement {
  const head = el('div', 'thead')
  head.append(
    el('i', 'glyph', rowGlyph(row)),
    el('b', 'title', row.title),
    el('span', 'detail', row.detail),
  )
  const summary = firstLine(row.result)
  if (summary !== '') head.appendChild(el('span', 'tres', summary))
  return head
}

function buildRow(row: ThreadRow, expanded: Set<string>): HTMLElement {
  const node = el('div', `trow ${row.kind}${row.isError ? ' err' : ''}`)
  node.dataset.key = row.key
  node.dataset.sig = rowSignature(row)

  if (row.kind === 'prompt') {
    node.appendChild(el('div', 'tsay', row.text))
    return node
  }
  if (row.kind === 'text' || row.kind === 'result') {
    node.append(el('i', 'glyph', rowGlyph(row)), el('div', 'ttext', row.text))
    return node
  }

  const head =
    row.kind === 'tool'
      ? toolHead(row)
      : (() => {
          const line = el('div', 'thead')
          line.append(
            el('i', 'glyph', rowGlyph(row)),
            el('b', 'title', 'thinking'),
            el('span', 'detail', firstLine(row.text)),
          )
          return line
        })()

  const body = expandableBody(row)
  if (body === null) {
    node.appendChild(head)
    return node
  }

  const open = expanded.has(row.key)
  body.hidden = !open
  head.classList.add('open-able')
  head.prepend(el('i', 'caret', open ? '▾' : '▸'))
  head.onclick = () => {
    const next = body.hidden
    body.hidden = !next
    if (next) expanded.add(row.key)
    else expanded.delete(row.key)
    const caret = head.querySelector('.caret')
    if (caret !== null) caret.textContent = next ? '▾' : '▸'
  }
  node.append(head, body)
  return node
}

export type ThreadList = { sync(model: ThreadModel): void }

// Rows are reconciled by key so a poll appends instead of rebuilding the list, which would
// drop the reader's scroll position and every open expander.
export function createThreadList(host: HTMLElement): ThreadList {
  const expanded = new Set<string>()
  const nodes = new Map<string, HTMLElement>()
  const cursor = el('div', 'trow working', '…working')

  return {
    sync(model: ThreadModel): void {
      const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 80
      const live = new Set(model.rows.map((row) => row.key))
      for (const [key, node] of nodes) {
        if (live.has(key)) continue
        node.remove()
        nodes.delete(key)
      }

      for (const row of model.rows) {
        const existing = nodes.get(row.key)
        if (existing !== undefined && existing.dataset.sig === rowSignature(row)) {
          existing.classList.toggle('pending', isPendingTool(row, model.running))
          continue
        }
        const built = buildRow(row, expanded)
        built.classList.toggle('pending', isPendingTool(row, model.running))
        if (existing === undefined) host.appendChild(built)
        else existing.replaceWith(built)
        nodes.set(row.key, built)
      }

      if (model.running) host.appendChild(cursor)
      else cursor.remove()
      if (nearBottom) host.scrollTop = host.scrollHeight
    },
  }
}

export type ThreadMount = { stop(): void; refresh(): Promise<void> }

export type ThreadOptions = { reply: boolean; pollMs?: number }

export async function fetchThread(jobId: string): Promise<ThreadModel | null> {
  const result = await getJson(`/api/jobs/${jobId}/thread`)
  return result.ok ? toThreadModel(result.data) : null
}

export async function sendReply(jobId: string, message: string): Promise<string> {
  const result = await postJson(`/api/jobs/${jobId}/reply`, { message })
  if (result.ok) return ''
  const error = result.data.error
  return typeof error === 'string' && error !== '' ? error.toUpperCase() : 'REPLY FAILED'
}
