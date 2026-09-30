import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import type { AttentionItem } from '../server/attention'

const markup = `<button id="open-attention" aria-expanded="false"><span id="attention-count" class="count" hidden></span></button>
<section id="attention" class="nt-panel" hidden>
  <header class="nt-head"><h2>Waiting on you</h2><span class="nt-n" id="attention-n"></span></header>
  <div class="nt-off" id="attention-off" hidden><div><strong id="attention-off-title"></strong><span id="attention-off-text"></span></div><button type="button" id="attention-on">Turn on</button></div>
  <div class="nt-list" id="attention-list"></div>
  <div class="nt-empty" id="attention-empty"></div>
  <footer class="nt-foot" id="attention-foot" hidden><button type="button" id="attention-mute">Turn off</button></footer>
</section>
<main id="elsewhere"></main>`

const { window } = new JSDOM(`<body>${markup}</body>`, { url: 'http://127.0.0.1:7777/' })
const doc = window.document
const $ = (id: string) => doc.getElementById(id) as HTMLElement

class FakeSource {
  static last: FakeSource
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(readonly url: string) { FakeSource.last = this }
  close() {}
  send(items: AttentionItem[]) { this.onmessage?.({ data: JSON.stringify({ items }) }) }
}

const shown: Array<{ title: string; options: { tag: string; actions: unknown[] } }> = []
const closedTags: string[] = []
const registration = {
  showNotification: async (title: string, options: { tag: string; actions: unknown[] }) => { shown.push({ title, options }) },
  getNotifications: async ({ tag }: { tag: string }) => { closedTags.push(tag); return [] },
}
const fakeNotification = { permission: 'granted', requestPermission: async () => { fakeNotification.permission = 'granted'; return 'granted' } }
const posted: Array<{ url: string; body: unknown }> = []
let reply = (): Response => Response.json({ ok: true })
const opened: unknown[] = []
const realFetch = globalThis.fetch

const item = (patch: Partial<AttentionItem>): AttentionItem => ({ key: 'needs:c1', kind: 'needs', title: 'Login fix', detail: 'Needs you: Build it', command: null, chatId: 'c1', jobId: null, requestId: null, createdAt: Date.now() - 120_000, ...patch })
const perm = item({ key: 'perm:j1:r1', kind: 'permission', title: 'check segment', detail: 'Wants to run a command', command: 'bun test', jobId: 'j1', requestId: 'r1' })
const loop = item({ key: 'loop:j2', kind: 'loop', title: 'Army export', detail: 'May be stuck: 81 turns in 20 min', chatId: null, jobId: 'j2' })
const needs = item({})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeAll(async () => {
  Object.assign(globalThis, { window, document: doc, EventSource: FakeSource, Notification: fakeNotification, localStorage: window.localStorage, HTMLElement: window.HTMLElement, location: window.location })
  Object.defineProperty(globalThis.navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration, addEventListener() {} } })
  globalThis.fetch = (async (url: string, init?: RequestInit) => { posted.push({ url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }); return reply() }) as typeof fetch
  addEventListener('quiet:open-chat', (event) => opened.push(['chat', (event as CustomEvent).detail]))
  addEventListener('quiet:agent-open', (event) => opened.push(['job', (event as CustomEvent).detail]))
  doc.hasFocus = () => false
  await import('../client/attention')
})

afterAll(() => {
  globalThis.fetch = realFetch
  Reflect.deleteProperty(globalThis.navigator, 'serviceWorker')
  for (const key of ['window', 'document', 'EventSource', 'Notification', 'localStorage', 'HTMLElement', 'location']) Reflect.deleteProperty(globalThis, key)
  window.close()
})

test('the first snapshot fills the bell and the tab title without alerting', async () => {
  FakeSource.last.send([perm, loop])
  await flush()
  expect(FakeSource.last.url).toBe('/api/attention/stream')
  expect($('attention-count').hidden).toBe(false)
  expect($('attention-count').textContent).toBe('2')
  expect(doc.title).toBe('(2) Mission Control')
  expect(shown).toHaveLength(0)
})

test('a new item alerts once while the user is away', async () => {
  FakeSource.last.send([perm, loop, needs])
  await flush()
  expect(shown.map(entry => [entry.title, entry.options.tag])).toEqual([['Login fix', 'needs:c1']])
})

test('a resolved item closes its alert', async () => {
  FakeSource.last.send([loop, needs])
  await flush()
  expect(closedTags).toContain('perm:j1:r1')
  FakeSource.last.send([perm, loop, needs])
  await flush()
})

test('the bell opens the list, newest first, with the command and buttons for each kind', () => {
  $('open-attention').click()
  expect($('attention').hidden).toBe(false)
  expect($('open-attention').getAttribute('aria-expanded')).toBe('true')
  const cards = [...$('attention-list').querySelectorAll('.nt-item')] as HTMLElement[]
  expect(cards.map(card => card.dataset.key)).toContain('perm:j1:r1')
  const permCard = cards.find(card => card.dataset.key === 'perm:j1:r1')!
  expect(permCard.querySelector('.nt-cmd')?.textContent).toBe('$bun test')
  expect([...permCard.querySelectorAll('button[data-act]')].map(button => (button as HTMLElement).dataset.act)).toEqual(['deny', 'open', 'allow'])
  expect(permCard.querySelector('.nt-top time')?.textContent).toBe('2 min')
  const loopCard = cards.find(card => card.dataset.key === 'loop:j2')!
  expect([...loopCard.querySelectorAll('button[data-act]')].map(button => (button as HTMLElement).dataset.act)).toEqual(['dismiss', 'stop', 'open'])
})

test('Allow once posts allow_once for that request and keeps the list open', async () => {
  posted.length = 0
  ;($('attention-list').querySelector('[data-key="perm:j1:r1"] [data-act="allow"]') as HTMLElement).click()
  await flush()
  expect(posted).toEqual([{ url: '/api/jobs/j1/permission', body: { requestId: 'r1', decision: 'allow_once' } }])
  expect($('attention').hidden).toBe(false)
})

test('a failed answer shows a red line on that item', async () => {
  reply = () => Response.json({ error: 'The job already ended' }, { status: 500 })
  ;($('attention-list').querySelector('[data-key="perm:j1:r1"] [data-act="deny"]') as HTMLElement).click()
  await flush()
  await flush()
  expect($('attention-list').querySelector('[data-key="perm:j1:r1"] .nt-fail')?.textContent).toBe("Couldn't deny: The job already ended")
  reply = () => Response.json({ ok: true })
})

test('Open chat closes the list and opens that chat; Open job opens the agents panel', () => {
  ;($('attention-list').querySelector('[data-key="needs:c1"] [data-act="open"]') as HTMLElement).click()
  expect($('attention').hidden).toBe(true)
  $('open-attention').click()
  ;($('attention-list').querySelector('[data-key="loop:j2"] [data-act="open"]') as HTMLElement).click()
  expect(opened).toEqual([['chat', 'c1'], ['job', { jobId: 'j2' }]])
})

test('Escape and a click elsewhere close the list', () => {
  $('open-attention').click()
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
  expect($('attention').hidden).toBe(true)
  $('open-attention').click()
  $('elsewhere').click()
  expect($('attention').hidden).toBe(true)
})

test('nothing waiting shows the empty state, hides the badge and resets the title', async () => {
  FakeSource.last.send([])
  await flush()
  expect($('attention-empty').hidden).toBe(false)
  expect($('attention-count').hidden).toBe(true)
  expect(doc.title).toBe('Mission Control')
})

test('with alerts not yet allowed, the banner offers Turn on and asks the browser', async () => {
  fakeNotification.permission = 'default'
  FakeSource.last.send([needs])
  await flush()
  expect($('attention-off').hidden).toBe(false)
  $('attention-on').click()
  await flush()
  expect(fakeNotification.permission).toBe('granted')
  expect($('attention-off').hidden).toBe(true)
  expect($('attention-foot').hidden).toBe(false)
})

test('Turn off mutes alerts until turned on again', async () => {
  $('attention-mute').click()
  expect($('attention-off').hidden).toBe(false)
  shown.length = 0
  FakeSource.last.send([needs, loop])
  await flush()
  expect(shown).toHaveLength(0)
})
