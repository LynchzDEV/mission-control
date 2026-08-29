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

export type MiniRow = {
  key: string
  cls: string
  glyph: string
  title: string
  text: string
}

export type FullRow = {
  key: string
  cls: string
  glyph: string
  title: string
  detail: string
  text: string
  result: string
  isError: boolean
  collapsible: boolean
}

export type ThreadCounts = { tools: number; thoughts: number }

export const MINI_ROW_LIMIT = 6
export const CARD_POLL_MS = 3_000
export const DRAWER_POLL_MS = 2_000
export const RESULT_EXCERPT_LINES = 200
export const WAITING_TEXT = 'waiting for response'
export const NO_OUTPUT_TEXT = '(no output)'

const ENGINE_ACCENT: Record<string, string> = {
  claude: 'c-claude',
  glm: 'c-glm',
  codex: 'c-white',
}

export function engineClass(engine: string): string {
  return ENGINE_ACCENT[engine] ?? 'c-white'
}

export type ThreadMember = {
  id: string
  threadRoot: string
  startedAt: number | null
  status: string
}

export type ThreadGroup<T extends ThreadMember> = {
  threadRoot: string
  newestJob: T
  runningJob: T | null
  jobCount: number
}

function rootOf(job: ThreadMember): string {
  return job.threadRoot === '' ? job.id : job.threadRoot
}

// Every job that ever shares a thread root collapses into one card: the newest job (by
// startedAt) drives the displayed status/elapsed/engine, and the newest still-running job (if
// any) is the target for KILL — the two coincide except mid-reply, when a fresh turn hasn't
// started yet but an earlier one in the same thread is still running.
export function groupByThread<T extends ThreadMember>(jobs: readonly T[]): ThreadGroup<T>[] {
  const byRoot = new Map<string, T[]>()
  for (const job of jobs) {
    const root = rootOf(job)
    const members = byRoot.get(root)
    if (members === undefined) byRoot.set(root, [job])
    else members.push(job)
  }
  const groups: ThreadGroup<T>[] = []
  for (const [threadRoot, members] of byRoot) {
    const sorted = [...members].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    const newestJob = sorted[0] as T
    const runningJob = sorted.find((job) => job.status === 'running') ?? null
    groups.push({ threadRoot, newestJob, runningJob, jobCount: sorted.length })
  }
  return groups
}

export function sortThreadsByActivity<T extends ThreadMember>(
  groups: readonly ThreadGroup<T>[],
): ThreadGroup<T>[] {
  return [...groups].sort((left, right) => (right.newestJob.startedAt ?? 0) - (left.newestJob.startedAt ?? 0))
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

export function oneLine(text: string): string {
  const head = firstLine(text)
  if (head === '') return ''
  return head === text.trim() ? head : `${head}…`
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

export function threadCounts(model: ThreadModel): ThreadCounts {
  return {
    tools: model.rows.filter((row) => row.kind === 'tool').length,
    thoughts: model.rows.filter((row) => row.kind === 'thinking').length,
  }
}

function isResponse(row: ThreadRow): boolean {
  return row.kind === 'text' || row.kind === 'result'
}

function newestJobId(model: ThreadModel): string {
  const last = model.rows[model.rows.length - 1]
  return last === undefined ? '' : last.jobId
}

function miniOf(row: ThreadRow, running: boolean): MiniRow[] {
  if (row.kind === 'prompt') {
    return [{ key: row.key, cls: 'req', glyph: '›', title: '', text: oneLine(row.text) }]
  }
  if (row.kind === 'thinking') {
    return [{ key: row.key, cls: 'think', glyph: '✻', title: '', text: oneLine(row.text) }]
  }
  if (row.kind === 'tool') {
    const live = isPendingTool(row, running)
    const head: MiniRow = {
      key: row.key,
      cls: live ? 'live' : '',
      glyph: live ? '●' : '⏺',
      title: row.title,
      text: row.detail,
    }
    if (!row.isError) return [head]
    return [head, { key: `${row.key}=`, cls: 'err', glyph: '⎿', title: '', text: oneLine(row.result) }]
  }
  return [{ key: row.key, cls: 'resp', glyph: '✓', title: '', text: oneLine(row.text) }]
}

export function miniRows(model: ThreadModel, limit: number = MINI_ROW_LIMIT): MiniRow[] {
  const rows: MiniRow[] = []
  for (const row of model.rows) {
    for (const mini of miniOf(row, model.running)) {
      const previous = rows[rows.length - 1]
      const echo = previous !== undefined && previous.cls === 'resp' && mini.cls === 'resp'
      if (echo && previous.text === mini.text) continue
      rows.push(mini)
    }
  }
  const newest = newestJobId(model)
  const answered = model.rows.some((row) => row.jobId === newest && isResponse(row))
  if (model.running && !answered) {
    rows.push({ key: 'wait', cls: 'resp wait', glyph: '…', title: '', text: WAITING_TEXT })
  }
  if (limit < 0 || rows.length <= limit) return rows
  // The opening request is pinned: a card that starts mid-thought stops reading as an exchange.
  const opening = rows[0] as MiniRow
  return opening.cls === 'req' ? [opening, ...rows.slice(-(limit - 1))] : rows.slice(-limit)
}

export function miniFooter(model: ThreadModel, limit: number = MINI_ROW_LIMIT): string {
  if (model.running) {
    const hidden = Math.max(0, miniRows(model, -1).length - limit)
    return `▸ OPEN FULL TRANSCRIPT · ${hidden} more`
  }
  const counts = threadCounts(model)
  return `▸ OPEN FULL TRANSCRIPT · ${counts.tools} tools · ${counts.thoughts} thoughts`
}

export function fullRows(model: ThreadModel): FullRow[] {
  return model.rows.map((row) => {
    const base = {
      key: row.key,
      title: '',
      detail: '',
      text: row.text,
      result: '',
      isError: row.isError,
      collapsible: false,
    }
    if (row.kind === 'prompt') return { ...base, cls: 'user', glyph: '›' }
    if (row.kind === 'thinking') return { ...base, cls: 'think', glyph: '✻', collapsible: true }
    if (row.kind === 'tool') {
      return {
        ...base,
        cls: 'tool',
        glyph: '⏺',
        title: row.title,
        detail: row.detail,
        text: '',
        result: row.result === '' ? NO_OUTPUT_TEXT : excerpt(row.result),
        collapsible: true,
      }
    }
    if (row.kind === 'result') return { ...base, cls: 'final', glyph: '✓' }
    return { ...base, cls: 'text', glyph: '⏺' }
  })
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== '') node.textContent = text
  return node
}

function miniSignature(row: MiniRow): string {
  return `${row.cls}|${row.glyph}|${row.title}|${row.text}`
}

function buildMini(row: MiniRow): HTMLElement {
  const node = el('div', `ml ${row.cls}`.trim())
  node.dataset.key = row.key
  node.dataset.sig = miniSignature(row)
  const body = el('span')
  if (row.title === '') body.textContent = row.text
  else if (row.text === '') body.appendChild(el('b', '', row.title))
  else body.append(el('b', '', row.title), document.createTextNode(` ${row.text}`))
  node.append(el('i', '', row.glyph), body)
  return node
}

export type RowList = { sync(model: ThreadModel): void }

// Rows are reconciled by key so a poll appends instead of rebuilding the list, which would drop
// the reader's scroll position and every open expander.
function reconcile<T extends { key: string }>(
  host: HTMLElement,
  rows: T[],
  signature: (row: T) => string,
  build: (row: T) => HTMLElement,
  nodes: Map<string, HTMLElement>,
): void {
  const live = new Set(rows.map((row) => row.key))
  for (const [key, node] of nodes) {
    if (live.has(key)) continue
    node.remove()
    nodes.delete(key)
  }
  let cursor: ChildNode | null = host.firstChild
  for (const row of rows) {
    const existing = nodes.get(row.key)
    const stale = existing === undefined || existing.dataset.sig !== signature(row)
    const node = stale ? build(row) : existing
    if (stale && existing !== undefined) {
      if (cursor === existing) cursor = existing.nextSibling
      existing.replaceWith(node)
    }
    nodes.set(row.key, node)
    if (cursor === node) cursor = node.nextSibling
    else host.insertBefore(node, cursor)
  }
}

export function createMiniList(host: HTMLElement, limit: number = MINI_ROW_LIMIT): RowList {
  const nodes = new Map<string, HTMLElement>()
  return {
    sync(model: ThreadModel): void {
      reconcile(host, miniRows(model, limit), miniSignature, buildMini, nodes)
    },
  }
}

function fullSignature(row: FullRow): string {
  return `${row.cls}|${row.glyph}|${row.title}|${row.detail}|${row.text.length}|${row.result.length}|${row.isError}`
}

function expandable(node: HTMLElement): HTMLElement {
  node.onclick = () => node.classList.toggle('open')
  return node
}

function buildFull(row: FullRow): HTMLElement {
  const node = el('div', `mcd-row ${row.cls}`)
  node.dataset.key = row.key
  node.dataset.sig = fullSignature(row)
  node.appendChild(el('div', 'mcd-g', row.glyph))

  if (row.cls === 'tool') {
    const body = el('div')
    body.append(el('span', 'mcd-nm', row.title), el('span', 'mcd-arg', `(${row.detail})`))
    const result = el('div', `mcd-res${row.isError ? ' err' : ''}`, `⎿ ${row.result}`)
    body.appendChild(expandable(result))
    node.appendChild(body)
    return node
  }
  if (row.cls === 'think') {
    node.appendChild(expandable(el('div', 'mcd-think', row.text)))
    return node
  }
  node.appendChild(el('div', row.cls === 'user' ? 'mcd-user' : 'mcd-text', row.text))
  return node
}

export type FullList = { sync(model: ThreadModel): void }

export function createFullList(host: HTMLElement): FullList {
  const nodes = new Map<string, HTMLElement>()
  const cursor = el('div', 'mcd-row working')
  cursor.append(el('div', 'mcd-g', '●'), el('div', 'mcd-text', '…working'))
  return {
    sync(model: ThreadModel): void {
      const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 80
      cursor.remove()
      reconcile(host, fullRows(model), fullSignature, buildFull, nodes)
      if (model.running) host.appendChild(cursor)
      if (atBottom) host.scrollTop = host.scrollHeight
    },
  }
}

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

export type Feed = { root: HTMLElement; start(): void; stop(): void; refresh(): Promise<void> }

// Lanes shows the same transcript the drawer does, minus the reply box — the decision of what to
// say next belongs on /terminals and /dispatch, not on the board.
export function createFullFeed(jobId: string, pollMs: number = DRAWER_POLL_MS): Feed {
  const root = el('div', 'mcd-tx inline')
  const list = createFullList(root)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = true

  async function tick(): Promise<void> {
    const model = await fetchThread(jobId)
    if (stopped || model === null) return
    list.sync(model)
    clearTimeout(timer)
    if (model.running) timer = setTimeout(() => void tick(), pollMs)
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
    refresh: tick,
  }
}

export type MiniFeed = Feed

export type MiniFeedOptions = { onOpen(): void; pollMs?(): number }

export function createMiniFeed(jobId: string, options: MiniFeedOptions): MiniFeed {
  const root = el('div', 'mini')
  root.hidden = true
  const rows = el('div', 'mlist')
  const more = el('div', 'more')
  more.onclick = () => options.onOpen()
  root.append(rows, more)
  const list = createMiniList(rows)

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = true

  async function tick(): Promise<void> {
    const model = await fetchThread(jobId)
    if (stopped || model === null) return
    root.hidden = model.rows.length === 0
    list.sync(model)
    more.textContent = miniFooter(model)
    if (!model.running) return
    clearTimeout(timer)
    timer = setTimeout(() => void tick(), options.pollMs?.() ?? CARD_POLL_MS)
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
    refresh: tick,
  }
}
