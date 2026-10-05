import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import type { QueueItem } from '../server/queue-store'

const { window } = new JSDOM('<body><main><section id="queue" class="studio" aria-label="Queue"></section></main></body>', { url: 'http://127.0.0.1:7777/' })
const doc = window.document
const section = () => doc.getElementById('queue') as HTMLElement

class FakeSource {
  static last: FakeSource
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeSource.last = this }
  close() {}
  send(items: QueueItem[]) { this.onmessage?.({ data: JSON.stringify({ items }) }) }
}

type Call = { method: string; url: string; body: unknown }
const calls: Call[] = []
const replies = new Map<string, () => Response>()
const toasts: string[] = []
const studioRuns: unknown[] = []
const realFetch = globalThis.fetch
const flush = async (times = 3) => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }

const NOW = Date.now()
const item = (patch: Partial<QueueItem>): QueueItem => ({
  id: 'i0', source: 'clickup-board', externalId: '86d3k1a2b', title: 'Army settings: show export columns', url: 'https://app.clickup.com/t/86d3k1a2b', repo: '/Users/me/api', flowId: null,
  state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null,
  createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000, ...patch,
})
const building = item({ id: 'b1', state: 'building', title: 'Moni export: filter by call result', runIds: ['r-b1'], currentRunId: 'r-b1', updatedAt: NOW - 12 * 60_000 })
const queuedA = item({ id: 'q1', title: 'Army settings: show export columns' })
const queuedB = item({ id: 'q2', title: 'Backoffice: add tax ID to invoice', flowId: 'plan-only' })
const waiting = item({ id: 'w1', state: 'waiting-info', title: 'Bulk import contacts from CSV', questions: ['Which CSV columns are required?', 'Should duplicates be skipped?'], runIds: ['r-w1'], updatedAt: NOW - 5 * 3_600_000 })
const ready = item({ id: 'r1', state: 'ready', title: 'Invoice PDF footer', runIds: ['r-old', 'r-ready'], updatedAt: NOW - 20 * 60_000 })
const failed = item({ id: 'f1', state: 'failed', title: 'Kood queue retry', runIds: ['r-failed'], error: 'Review failed 3 times' })
const all = [building, queuedA, queuedB, waiting, ready, failed]

const plugins = [{ id: 'clickup-board', name: 'ClickUp board', icon: 'icon.svg', enabled: true }, { id: 'jira-board', name: 'Jira board', enabled: true }, { id: 'off-board', name: 'Off board', enabled: false }]
const flows = [{ id: 'plan-only', name: 'Plan only' }, { id: 'default', name: 'Default' }]
const context = (patch: Record<string, unknown> = {}) => ({ plugins, flows, now: NOW, checkedAt: null, openIds: new Set<string>(), ...patch })

let queue: typeof import('../client/queue')

const rows = (root: ParentNode = section()) => [...root.querySelectorAll<HTMLElement>('.q-row')]
const rowOf = (id: string) => rows().find(row => row.dataset.id === id) as HTMLElement
const buttonNamed = (text: string, root: ParentNode = doc) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text) as HTMLButtonElement
const click = (element: Element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const drag = (type: string, element: Element) => element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }))

beforeAll(async () => {
  const dialogProto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>
  dialogProto.showModal = function (this: HTMLDialogElement): void { this.open = true }
  dialogProto.close = function (this: HTMLDialogElement): void { if (!this.open) return; this.open = false; this.dispatchEvent(new window.Event('close')) }
  Object.assign(globalThis, { window, document: doc, EventSource: FakeSource, localStorage: window.localStorage, Element: window.Element, HTMLElement: window.HTMLElement, location: window.location })
  window.localStorage.setItem('mc.term.recentCwd', JSON.stringify(['/Users/me/api', '/Users/me/web']))
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null }
    calls.push(call)
    const reply = replies.get(`${call.method} ${call.url}`)
    if (reply) return reply()
    if (call.url === '/api/plugins') return Response.json({ plugins })
    if (call.url === '/api/studio/workflows') return Response.json({ workflows: flows, selected: flows[1] })
    return Response.json({ ok: true })
  }) as typeof fetch
  addEventListener('quiet:toast', (event) => toasts.push(String((event as CustomEvent).detail)))
  addEventListener('quiet:studio-run', (event) => studioRuns.push((event as CustomEvent).detail))
  queue = await import('../client/queue')
  await flush()
})

beforeEach(async () => {
  FakeSource.last.send(all)
  await flush()
  calls.length = 0
  toasts.length = 0
  studioRuns.length = 0
  replies.clear()
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const key of ['window', 'document', 'EventSource', 'localStorage', 'Element', 'HTMLElement', 'location']) Reflect.deleteProperty(globalThis, key)
  window.close()
})

test('renders one row per item in order with the right pill text', () => {
  const view = queue.renderQueue(all, context())
  expect(rows(view).map(row => row.querySelector('.q-main strong')?.textContent)).toEqual(all.map(entry => entry.title))
  expect(rows(view).map(row => row.querySelector('.pill-state')?.textContent)).toEqual(['Building', 'Queued', 'Queued', 'Waiting info', 'Ready', 'Failed'])
  expect(view.querySelector('.studio-heading h1')?.textContent).toBe('Queue')
  expect([...view.querySelectorAll('.q-bar > .pill-state')].map(pill => pill.textContent)).toEqual(['1 building', '2 queued', '1 waiting', '1 ready', '1 failed'])
})

test('progress text follows each state', () => {
  const view = queue.renderQueue(all, context())
  const progress = rows(view).map(row => row.querySelector('.q-meta > span:last-child')?.textContent)
  expect(progress).toEqual(['Building', 'Next up', '3rd in line', 'Asked 2 questions · 5h ago', 'Built · 20 min ago', 'Review failed 3 times'])
  expect(rows(view)[2]?.querySelector('.q-meta')?.textContent).toContain('Plan only')
  expect(rows(view)[1]?.querySelector('.q-meta')?.textContent).toContain('Default flow')
})

test('summary only counts states that have items', () => {
  const view = queue.renderQueue([queuedA], context())
  expect([...view.querySelectorAll('.q-bar > .pill-state')].map(pill => pill.textContent)).toEqual(['1 queued'])
})

test('empty queue shows how to add an item', () => {
  const view = queue.renderQueue([], context())
  expect(rows(view)).toHaveLength(0)
  const empty = view.querySelector('.q-empty') as HTMLElement
  expect(empty.querySelector('h2')?.textContent).toBe('Nothing in the queue')
  expect(empty.textContent).toContain('Items come from a source plugin')
  expect(empty.textContent).toContain('mctl queue add')
  expect(buttonNamed('Add item', view)).toBeDefined()
})

test('an item from an unknown source still renders', () => {
  const view = queue.renderQueue([item({ id: 'u1', source: 'gone-plugin' })], context())
  const badge = view.querySelector('.q-src') as HTMLElement
  expect(badge.textContent).toBe('gone-plugin')
  expect(badge.querySelector('img')).toBeNull()
  expect(view.querySelector('.q-main strong')?.textContent).toBe('Army settings: show export columns')
})

test('a known source shows its icon and name, linking only http links', () => {
  const view = queue.renderQueue([queuedA, item({ id: 'x1', url: 'javascript:alert(1)' }), item({ id: 'j1', source: 'jira-board' })], context())
  const [linked, plain, noIcon] = [...view.querySelectorAll<HTMLElement>('.q-src')]
  expect(linked?.tagName).toBe('A')
  expect(linked?.getAttribute('href')).toBe('https://app.clickup.com/t/86d3k1a2b')
  expect(linked?.querySelector('img')?.getAttribute('src')).toBe('/api/plugins/clickup-board/icon')
  expect(linked?.textContent).toBe('ClickUp board')
  expect(plain?.tagName).toBe('SPAN')
  expect(plain?.hasAttribute('href')).toBe(false)
  expect(noIcon?.querySelector('img')).toBeNull()
  expect(noIcon?.textContent).toBe('Jira board')
})

test('only queued rows are draggable', () => {
  const view = queue.renderQueue(all, context())
  expect(rows(view).filter(row => row.getAttribute('draggable') === 'true').map(row => row.dataset.id)).toEqual(['q1', 'q2'])
  expect(rows(view).filter(row => row.hasAttribute('data-movable')).map(row => row.dataset.id)).toEqual(['q1', 'q2'])
})

test('each state offers its own actions', () => {
  const view = queue.renderQueue(all, context())
  const actions = (id: string) => [...(rows(view).find(row => row.dataset.id === id)?.querySelectorAll('.q-acts button') ?? [])].map(button => button.textContent)
  expect(actions('b1')).toEqual([])
  expect(actions('q1')).toEqual(['Remove'])
  expect(actions('w1')).toEqual(['Requeue'])
  expect(actions('r1')).toEqual(['Requeue', 'Open run'])
  expect(actions('f1')).toEqual(['Requeue', 'Open run'])
  expect(buttonNamed('Git tree', view).disabled).toBe(true)
  expect(buttonNamed('List', view).getAttribute('aria-pressed')).toBe('true')
})

test('the live stream fills the screen', () => {
  expect(FakeSource.last.url).toBe('/api/queue/stream')
  expect(rows().map(row => row.dataset.id)).toEqual(all.map(entry => entry.id))
})

test('dropping a queued row onto another queued row moves it there', async () => {
  drag('dragstart', rowOf('q2'))
  const over = new window.Event('dragover', { bubbles: true, cancelable: true })
  rowOf('q1').dispatchEvent(over)
  expect(over.defaultPrevented).toBe(true)
  drag('drop', rowOf('q1'))
  await flush()
  expect(calls).toEqual([{ method: 'POST', url: '/api/queue/q2/move', body: { to: 1 } }])
})

test('a queued row cannot be dropped onto a row that is not queued', async () => {
  drag('dragstart', rowOf('q2'))
  const over = new window.Event('dragover', { bubbles: true, cancelable: true })
  rowOf('r1').dispatchEvent(over)
  expect(over.defaultPrevented).toBe(false)
  drag('drop', rowOf('r1'))
  drag('dragend', rowOf('q2'))
  await flush()
  expect(calls).toEqual([])
})

test('requeue, remove and check call their routes', async () => {
  replies.set('POST /api/queue/check', () => Response.json({ checked: 3, resumed: 1 }))
  click(buttonNamed('Requeue', rowOf('f1')))
  click(buttonNamed('Requeue', rowOf('r1')))
  click(buttonNamed('Requeue', rowOf('w1')))
  click(buttonNamed('Remove', rowOf('q1')))
  click(buttonNamed('Check replies', section()))
  await flush()
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue/f1/requeue', 'POST /api/queue/r1/requeue', 'POST /api/queue/w1/requeue', 'DELETE /api/queue/q1', 'POST /api/queue/check'])
  expect(toasts).toContain('Checked 3, 1 resumed')
  expect(section().querySelector('.q-checked')?.textContent).toBe('Checked just now')
})

test('a refused action says why', async () => {
  replies.set('POST /api/queue/f1/requeue', () => Response.json({ error: 'It is building now' }, { status: 409 }))
  replies.set('DELETE /api/queue/q1', () => Response.json({ error: 'Stop its run in Studio first' }, { status: 409 }))
  click(buttonNamed('Requeue', rowOf('f1')))
  click(buttonNamed('Remove', rowOf('q1')))
  await flush()
  expect(toasts).toEqual(['It is building now', 'Stop its run in Studio first'])
})

test('Open run opens the latest run in Studio', () => {
  click(buttonNamed('Open run', rowOf('r1')))
  expect(studioRuns).toEqual([{ runId: 'r-ready' }])
})

test('opening a waiting row shows its questions', () => {
  expect(rowOf('w1').querySelector('.q-thread')).toBeNull()
  click(rowOf('w1').querySelector('.q-main') as Element)
  expect(rowOf('w1').hasAttribute('data-open')).toBe(true)
  expect([...rowOf('w1').querySelectorAll('.q-bubble')].map(bubble => bubble.textContent)).toEqual(waiting.questions)
  click(rowOf('w1').querySelector('.q-main') as Element)
  expect(rowOf('w1').querySelector('.q-thread')).toBeNull()
})

test('focusing an item outlines its row', () => {
  dispatchEvent(new CustomEvent('quiet:queue-focus', { detail: 'q2' }))
  expect(rowOf('q2').hasAttribute('data-focus')).toBe(true)
})

test('parseItemRef reads ids out of links', () => {
  expect(queue.parseItemRef('https://app.clickup.com/t/86d3j4f8q')).toBe('86d3j4f8q')
  expect(queue.parseItemRef('  86d3j4f8q  ')).toBe('86d3j4f8q')
  expect(queue.parseItemRef('https://example.com/board/items/42/?view=1#top')).toBe('42')
  expect(queue.parseItemRef('https://example.com/')).toBe('')
  expect(queue.parseItemRef('')).toBe('')
})

const dialog = () => doc.querySelector('dialog.access-dialog.flat') as HTMLDialogElement
const field = <T extends HTMLElement>(name: string) => dialog().querySelector(`[name="${name}"]`) as T

test('the Add form posts the item and closes', async () => {
  click(buttonNamed('Add item', section()))
  await flush()
  expect(dialog().open).toBe(true)
  const sources = [...field<HTMLSelectElement>('source').options].map(option => option.value)
  expect(sources).toEqual(['clickup-board', 'jira-board'])
  expect([...field<HTMLSelectElement>('flow').options].map(option => option.textContent)).toEqual(['Default flow', 'Plan only', 'Default'])
  expect([...dialog().querySelectorAll('datalist option')].map(option => option.getAttribute('value'))).toEqual(['/Users/me/api', '/Users/me/web'])
  field<HTMLInputElement>('ref').value = 'https://app.clickup.com/t/86d3j4f8q'
  field<HTMLInputElement>('repo').value = '/Users/me/api'
  field<HTMLSelectElement>('flow').value = 'plan-only'
  click(buttonNamed('Next up', dialog()))
  replies.set('POST /api/queue', () => Response.json({ item: item({ id: 'n1', title: 'Products v2' }) }))
  dialog().querySelector('form.field-stack')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await flush()
  expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', url: '/api/queue', body: { source: 'clickup-board', externalId: '86d3j4f8q', repo: '/Users/me/api', flowId: 'plan-only', position: 'next' } }])
  expect(dialog().open).toBe(false)
  expect(toasts).toEqual(['Added Products v2'])
})

test('the Add form leaves out a default flow and shows the source error inline', async () => {
  click(buttonNamed('Add item', section()))
  await flush()
  field<HTMLInputElement>('ref').value = '86d3j4f8q'
  field<HTMLInputElement>('repo').value = '/Users/me/api'
  replies.set('POST /api/queue', () => Response.json({ error: 'No method source.item' }, { status: 502 }))
  dialog().querySelector('form.field-stack')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await flush()
  expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', url: '/api/queue', body: { source: 'clickup-board', externalId: '86d3j4f8q', repo: '/Users/me/api', position: 'end' } }])
  expect(dialog().open).toBe(true)
  const error = dialog().querySelector('[role="alert"]') as HTMLElement
  expect(error.hidden).toBe(false)
  expect(error.textContent).toBe('No method source.item')
  dialog().close()
})

test('the Add form refuses a link with no id before posting', async () => {
  click(buttonNamed('Add item', section()))
  await flush()
  field<HTMLInputElement>('ref').value = 'https://example.com/'
  field<HTMLInputElement>('repo').value = '/Users/me/api'
  dialog().querySelector('form.field-stack')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await flush()
  expect(calls.filter(call => call.method === 'POST')).toEqual([])
  expect((dialog().querySelector('[role="alert"]') as HTMLElement).textContent).toBe('Paste a task link or id')
  dialog().close()
})
