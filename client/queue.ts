import { createAddDialog } from './queue-dialog'
import { readQueueItems, renderQueue, type QueueFlow, type QueueItemView, type QueuePlugin } from './queue-view'
import { errorText, getJson, postJson, readArray, readRecord, type ApiResult } from './shared'

export { parseItemRef } from './queue-dialog'
export { renderQueue } from './queue-view'

const REFRESH_MS = 30_000
const FOCUS_MS = 1600

let items: QueueItemView[] = []
let plugins: QueuePlugin[] = []
let flows: QueueFlow[] = []
let checkedAt: number | null = null
let loaded = false
let dragId: string | null = null
let focusId: string | null = null
const openIds = new Set<string>()

const toast = (text: string): void => { dispatchEvent(new CustomEvent('quiet:toast', { detail: text })) }

async function deleteJson(url: string): Promise<ApiResult> {
  try {
    const response = await fetch(url, { method: 'DELETE' })
    const data: unknown = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data: readRecord(data) }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
}

function readPlugins(value: unknown): QueuePlugin[] {
  return readArray(value).filter(entry => typeof entry.id === 'string').map(entry => ({
    id: String(entry.id),
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : String(entry.id),
    enabled: entry.enabled === true,
    ...(typeof entry.icon === 'string' ? { icon: entry.icon } : {}),
  }))
}

function readFlows(value: unknown): QueueFlow[] {
  return readArray(value).filter(entry => typeof entry.id === 'string' && typeof entry.name === 'string').map(entry => ({ id: String(entry.id), name: String(entry.name) }))
}

function start(section: HTMLElement): void {
  const rowsOf = (): HTMLElement[] => [...section.querySelectorAll<HTMLElement>('.q-row')]
  const rowFor = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>('.q-row') : null)
  const itemFor = (id: string | undefined): QueueItemView | undefined => items.find(item => item.id === id)
  const dialog = createAddDialog(() => ({ plugins, flows, items }), toast)

  function applyFocus(): void {
    const row = rowsOf().find(entry => entry.dataset.id === focusId)
    if (row === undefined) return
    focusId = null
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    row.setAttribute('data-focus', '')
    setTimeout(() => row.removeAttribute('data-focus'), FOCUS_MS)
  }

  function paint(): void {
    if (!loaded) return
    section.replaceChildren(renderQueue(items, { plugins, flows, now: Date.now(), checkedAt, openIds }))
    applyFocus()
  }

  function showStatus(text: string): void {
    const line = document.createElement('p')
    line.className = 'muted q-status'
    line.textContent = text
    section.replaceChildren(line)
  }

  async function loadContext(): Promise<void> {
    const [pluginResult, flowResult] = await Promise.all([getJson('/api/plugins'), getJson('/api/studio/workflows')])
    if (pluginResult.ok) plugins = readPlugins(pluginResult.data.plugins)
    if (flowResult.ok) flows = readFlows(flowResult.data.workflows)
    paint()
  }

  async function act(button: HTMLElement, work: () => Promise<ApiResult>, done: string): Promise<void> {
    button.setAttribute('disabled', '')
    const result = await work()
    button.removeAttribute('disabled')
    toast(result.ok ? done : errorText(result))
  }

  async function checkReplies(button: HTMLElement): Promise<void> {
    button.setAttribute('disabled', '')
    const result = await postJson('/api/queue/check', {})
    button.removeAttribute('disabled')
    if (!result.ok) { toast(errorText(result)); return }
    checkedAt = Date.now()
    toast(`Checked ${Number(result.data.checked ?? 0)}, ${Number(result.data.resumed ?? 0)} resumed`)
    paint()
  }

  section.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLElement>('[data-act]')
    const item = itemFor(button?.dataset.id)
    const action = button?.dataset.act
    if (button && action === 'check') { void checkReplies(button); return }
    if (button && action === 'add') { dialog.open(); return }
    if (button && item && action === 'requeue') { void act(button, () => postJson(`/api/queue/${encodeURIComponent(item.id)}/requeue`, {}), `Requeued ${item.title}`); return }
    if (button && item && action === 'remove') { void act(button, () => deleteJson(`/api/queue/${encodeURIComponent(item.id)}`), `Removed ${item.title}`); return }
    if (button && item && action === 'open-run') { dispatchEvent(new CustomEvent('quiet:studio-run', { detail: { runId: item.runIds.at(-1) } })); return }
    if (target?.closest('a, button')) return
    const row = rowFor(target)
    if (row?.hasAttribute('data-openable') !== true || row.dataset.id === undefined) return
    if (openIds.has(row.dataset.id)) openIds.delete(row.dataset.id)
    else openIds.add(row.dataset.id)
    paint()
  })

  const dropTarget = (event: Event): HTMLElement | null => {
    const row = rowFor(event.target)
    return row?.hasAttribute('data-movable') === true && dragId !== null && row.dataset.id !== dragId ? row : null
  }
  const clearDrop = (): void => { for (const row of rowsOf()) row.removeAttribute('data-drop') }
  section.addEventListener('dragstart', (event) => {
    const row = rowFor(event.target)
    if (row?.hasAttribute('data-movable') !== true) return
    dragId = row.dataset.id ?? null
    const transfer = (event as DragEvent).dataTransfer
    transfer?.setData('text/plain', dragId ?? '')
    if (transfer) transfer.effectAllowed = 'move'
  })
  section.addEventListener('dragover', (event) => {
    const row = dropTarget(event)
    if (row === null) return
    event.preventDefault()
    if (!row.hasAttribute('data-drop')) { clearDrop(); row.setAttribute('data-drop', '') }
  })
  section.addEventListener('drop', (event) => {
    const row = dropTarget(event)
    const moving = dragId
    dragId = null
    clearDrop()
    if (row === null || moving === null) return
    event.preventDefault()
    const to = items.findIndex(item => item.id === row.dataset.id)
    void postJson(`/api/queue/${encodeURIComponent(moving)}/move`, { to }).then((result) => { if (!result.ok) toast(errorText(result)) })
  })
  section.addEventListener('dragend', () => { dragId = null; clearDrop() })

  addEventListener('quiet:queue-focus', (event) => {
    focusId = String((event as CustomEvent<string>).detail)
    if (section.hidden) dispatchEvent(new CustomEvent('quiet:show', { detail: 'queue' }))
    applyFocus()
  })
  addEventListener('quiet:screen', (event) => { if ((event as CustomEvent<string>).detail === 'queue') void loadContext() })
  setInterval(() => { if (!section.hidden && dragId === null) paint() }, REFRESH_MS)

  showStatus('Loading the queue…')
  const stream = new EventSource('/api/queue/stream')
  stream.onmessage = (event: MessageEvent) => {
    try {
      items = readQueueItems(readRecord(JSON.parse(String(event.data))).items)
    } catch { return }
    loaded = true
    paint()
  }
  stream.onerror = () => { if (!loaded) showStatus('Could not load the queue. Mission Control keeps trying.') }
  void loadContext()
}

const section = document.getElementById('queue')
if (section !== null) start(section)
