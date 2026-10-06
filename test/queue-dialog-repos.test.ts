import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import type { QueueItemView } from '../client/queue-view'

const { window } = new JSDOM('<body></body>', { url: 'http://127.0.0.1:7777/' })
const doc = window.document

type Call = { method: string; url: string; body: unknown }
const calls: Call[] = []
const pending = new Map<string, (response: Response) => void>()
let answer: (call: Call) => Response | null = () => null
const flush = async (times = 4) => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const folderUrl = (path: string) => `/api/queue/folder?path=${encodeURIComponent(path)}`

const realFetch = globalThis.fetch
let dialogs: typeof import('../client/queue-dialog')
let items: QueueItemView[] = []
const toasts: string[] = []

beforeAll(async () => {
  const dialogProto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>
  dialogProto.showModal = function (this: HTMLDialogElement): void { this.open = true }
  dialogProto.close = function (this: HTMLDialogElement): void { if (!this.open) return; this.open = false; this.dispatchEvent(new window.Event('close')) }
  Object.assign(globalThis, { window, document: doc, localStorage: window.localStorage, Element: window.Element, HTMLElement: window.HTMLElement })
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null }
    calls.push(call)
    const now = answer(call)
    if (now !== null) return now
    return new Promise<Response>(resolve => { pending.set(call.url, resolve) })
  }) as typeof fetch
  dialogs = await import('../client/queue-dialog')
})

beforeEach(() => {
  calls.length = 0
  pending.clear()
  items = []
  answer = call => (call.method === 'POST' ? Response.json({ item: { title: 'Fix login' } }) : null)
  doc.body.replaceChildren()
})
afterEach(() => { doc.querySelector('dialog')?.remove() })
afterAll(() => {
  globalThis.fetch = realFetch
  for (const key of ['window', 'document', 'localStorage', 'Element', 'HTMLElement']) Reflect.deleteProperty(globalThis, key)
})

const open = () => {
  for (const old of doc.querySelectorAll('dialog')) old.remove()
  const dialog = dialogs.createAddDialog(() => ({ plugins: [{ id: 'clickup-board', name: 'ClickUp board', enabled: true }], flows: [], items }), text => toasts.push(text))
  dialog.open()
  return doc.querySelector('dialog') as HTMLDialogElement
}
const field = <T extends HTMLElement>(root: ParentNode, name: string) => root.querySelector(`[name="${name}"]`) as T
const addButton = (root: ParentNode) => root.querySelector('button[type="submit"].primary') as HTMLButtonElement
const submit = (root: ParentNode) => root.querySelector('form.q-add-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
const alertText = (root: ParentNode) => {
  const alert = root.querySelector('.q-add-error') as HTMLElement
  return alert.hidden ? '' : alert.textContent
}
const repoBoxes = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement>('.q-repos input[type="checkbox"]')]

function typeFolder(root: ParentNode, path: string, how: 'blur' | 'input' = 'blur') {
  const input = field<HTMLInputElement>(root, 'repo')
  input.value = path
  input.dispatchEvent(new window.Event(how === 'blur' ? 'blur' : 'input', { bubbles: true }))
}
const reply = (path: string, body: unknown, status = 200) => pending.get(folderUrl(path))!(Response.json(body, { status }))

test('checking a folder marks Add as waiting and says so until the answer arrives', async () => {
  const dialog = open()
  typeFolder(dialog, '/Users/me/api')
  await flush()
  expect(calls.map(call => call.url)).toEqual([folderUrl('/Users/me/api')])
  expect(addButton(dialog).getAttribute('aria-disabled')).toBe('true')
  expect(addButton(dialog).disabled).toBe(false)
  expect((dialog.querySelector('.q-folder-check') as HTMLElement).textContent).toBe('Checking folder…')
  reply('/Users/me/api', { path: '/Users/me/api', isRepo: true, repos: [] })
  await flush()
  expect(addButton(dialog).getAttribute('aria-disabled')).toBe('false')
  expect((dialog.querySelector('.q-folder-check') as HTMLElement).hidden).toBe(true)
  expect(dialog.querySelector('.q-repos')).toBeNull()
  expect(alertText(dialog)).toBe('')
})

const pickButton = (root: ParentNode) => root.querySelector('button.q-pick') as HTMLButtonElement

async function parentFolder(dialog: HTMLDialogElement, repos: string[]) {
  typeFolder(dialog, '/Users/me/klangtech')
  await flush()
  reply('/Users/me/klangtech', { path: '/Users/me/klangtech', isRepo: false, repos })
  await flush()
}

test('a folder of repos says the plan picks them and hides the checkbox list', async () => {
  const dialog = open()
  await parentFolder(dialog, ['api', 'backoffice', 'portal'])
  expect((dialog.querySelector('.q-plan-picks') as HTMLElement).textContent).toBe('The plan picks the repos it needs from these 3.Pick them yourself')
  expect(pickButton(dialog).getAttribute('type')).toBe('button')
  expect(pickButton(dialog).getAttribute('aria-expanded')).toBe('false')
  expect(repoBoxes(dialog)).toEqual([])
})

test('Pick them yourself shows the checkboxes, none ticked, with clickable labels; Let the plan pick hides them and clears ticks', async () => {
  const dialog = open()
  await parentFolder(dialog, ['api', 'backoffice', 'portal'])
  pickButton(dialog).click()
  expect(pickButton(dialog).textContent).toBe('Let the plan pick')
  expect(pickButton(dialog).getAttribute('aria-expanded')).toBe('true')
  const group = dialog.querySelector('fieldset.q-repos') as HTMLFieldSetElement
  expect(group.querySelector('legend')?.textContent).toBe('Repos this ticket touches')
  expect(repoBoxes(dialog).map(box => [box.value, box.checked])).toEqual([['api', false], ['backoffice', false], ['portal', false]])
  const label = repoBoxes(dialog)[1]!.closest('label') as HTMLLabelElement
  expect(label.textContent).toBe('backoffice')
  label.click()
  expect(repoBoxes(dialog)[1]!.checked).toBe(true)
  pickButton(dialog).click()
  expect(repoBoxes(dialog)).toEqual([])
  expect(pickButton(dialog).textContent).toBe('Pick them yourself')
  pickButton(dialog).click()
  expect(repoBoxes(dialog).map(box => box.checked)).toEqual([false, false, false])
})

test('Add for a folder of repos posts an empty list unless repos are ticked', async () => {
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '86abc'
  await parentFolder(dialog, ['api', 'backoffice'])
  submit(dialog)
  await flush()
  const body = { source: 'clickup-board', externalId: '86abc', repo: '/Users/me/klangtech', position: 'end' }
  expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([{ ...body, repos: [] }])
  const again = open()
  field<HTMLInputElement>(again, 'ref').value = '86abc'
  calls.length = 0
  await parentFolder(again, ['api', 'backoffice'])
  pickButton(again).click()
  submit(again)
  await flush()
  repoBoxes(again)[1]!.click()
  repoBoxes(again)[0]!.click()
  submit(again)
  await flush()
  expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([{ ...body, repos: [] }, { ...body, repos: ['api', 'backoffice'] }])
})

test('a folder with one repo inside has it ticked once the list is shown', async () => {
  const dialog = open()
  await parentFolder(dialog, ['api'])
  expect((dialog.querySelector('.q-plan-picks') as HTMLElement).textContent).toBe('The plan picks from the 1 repo here.Pick them yourself')
  pickButton(dialog).click()
  expect(repoBoxes(dialog).map(box => box.checked)).toEqual([true])
})

test('a folder that is neither a repo nor holds repos says so in plain words', async () => {
  const dialog = open()
  typeFolder(dialog, '/Users/me/Downloads')
  await flush()
  reply('/Users/me/Downloads', { path: '/Users/me/Downloads', isRepo: false, repos: [] })
  await flush()
  expect(alertText(dialog)).toBe("This folder isn't a git repo and has no repos inside it.")
  expect(dialog.querySelector('.q-repos')).toBeNull()
})

test('a missing folder or one outside home is explained in plain words', async () => {
  const dialog = open()
  typeFolder(dialog, '/nope')
  await flush()
  reply('/nope', { error: 'cwd does not exist' }, 400)
  await flush()
  expect(alertText(dialog)).toBe("This folder doesn't exist.")
  typeFolder(dialog, '/tmp')
  await flush()
  reply('/tmp', { error: 'cwd must be under $HOME' }, 400)
  await flush()
  expect(alertText(dialog)).toBe('Pick a folder inside your home folder.')
})

test('the server\'s git-repo error is shown in plain words', async () => {
  answer = call => (call.method === 'POST' ? Response.json({ error: 'cwd is not a git repository' }, { status: 400 }) : Response.json({ path: '/Users/me/x', isRepo: true, repos: [] }))
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '86abc'
  typeFolder(dialog, '/Users/me/x')
  await flush()
  submit(dialog)
  await flush()
  expect(alertText(dialog)).toBe("This folder isn't a git repo and has no repos inside it.")
})

test('typing checks the folder once, after a pause', async () => {
  const dialog = open()
  for (const path of ['/Users/me/k', '/Users/me/kl', '/Users/me/klangtech']) typeFolder(dialog, path, 'input')
  await flush()
  expect(calls).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 450))
  expect(calls.map(call => call.url)).toEqual([folderUrl('/Users/me/klangtech')])
})

test('an answer for a folder no longer in the field is ignored', async () => {
  const dialog = open()
  typeFolder(dialog, '/Users/me/old')
  await flush()
  typeFolder(dialog, '/Users/me/new')
  await flush()
  reply('/Users/me/new', { path: '/Users/me/new', isRepo: true, repos: [] })
  await flush()
  reply('/Users/me/old', { path: '/Users/me/old', isRepo: false, repos: ['a', 'b'] })
  await flush()
  expect(dialog.querySelector('.q-repos')).toBeNull()
  expect(addButton(dialog).getAttribute('aria-disabled')).toBe('false')
})

test('Add for a folder not checked yet posts it, and explains in plain words if it is no repo at all', async () => {
  answer = call => (call.method === 'POST' ? Response.json({ error: 'cwd is not a git repository' }, { status: 400 }) : Response.json({ path: '/Users/me/notes', isRepo: false, repos: [] }))
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '1'
  field<HTMLInputElement>(dialog, 'repo').value = '/Users/me/notes'
  submit(dialog)
  await flush(8)
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue', `GET ${folderUrl('/Users/me/notes')}`])
  expect(calls[0]!.body).toEqual({ source: 'clickup-board', externalId: '1', repo: '/Users/me/notes', position: 'end' })
  expect(alertText(dialog)).toBe("This folder isn't a git repo and has no repos inside it.")
  expect(dialog.open).toBe(true)
})

test('Add pressed while a folder check is running waits for it and then adds, with one click', async () => {
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '9'
  typeFolder(dialog, '/Users/me/api')
  await flush()
  submit(dialog)
  await flush()
  expect(calls.filter(call => call.method === 'POST')).toEqual([])
  reply('/Users/me/api', { path: '/Users/me/api', isRepo: true, repos: [] })
  await flush(8)
  expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([{ source: 'clickup-board', externalId: '9', repo: '/Users/me/api', position: 'end' }])
  expect(dialog.open).toBe(false)
})

test('Add pressed while typing is still settling checks the folder first and then adds', async () => {
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '9'
  typeFolder(dialog, '/Users/me/solo-parent', 'input')
  submit(dialog)
  await flush()
  expect(calls.map(call => call.url)).toEqual([folderUrl('/Users/me/solo-parent')])
  reply('/Users/me/solo-parent', { path: '/Users/me/solo-parent', isRepo: false, repos: ['api'] })
  await flush(8)
  expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([{ source: 'clickup-board', externalId: '9', repo: '/Users/me/solo-parent', repos: [], position: 'end' }])
})

test('Add pressed during a check of a folder of repos adds it for the plan to pick', async () => {
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '9'
  typeFolder(dialog, '/Users/me/klangtech')
  await flush()
  submit(dialog)
  reply('/Users/me/klangtech', { path: '/Users/me/klangtech', isRepo: false, repos: ['api', 'web'] })
  await flush(8)
  expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([{ source: 'clickup-board', externalId: '9', repo: '/Users/me/klangtech', repos: [], position: 'end' }])
})

test('folders whose check took too long are named as left out', async () => {
  const dialog = open()
  typeFolder(dialog, '/Users/me/klangtech')
  await flush()
  reply('/Users/me/klangtech', { path: '/Users/me/klangtech', isRepo: false, repos: ['api'], skipped: 2 })
  await flush()
  expect((dialog.querySelector('.q-folder-skipped') as HTMLElement).textContent).toBe('2 folders took too long to check and were left out.')
  typeFolder(dialog, '/Users/me/slow')
  await flush()
  reply('/Users/me/slow', { path: '/Users/me/slow', isRepo: false, repos: [], skipped: 1 })
  await flush()
  expect(alertText(dialog)).toBe("This folder isn't a git repo and has no repos inside it.")
  expect((dialog.querySelector('.q-folder-skipped') as HTMLElement).textContent).toBe('1 folder took too long to check and was left out.')
})

const view = (patch: Partial<QueueItemView>): QueueItemView => ({ id: 'x', source: 's', externalId: '1', title: 't', url: '', flowId: null, state: 'queued', runIds: [], questions: [], error: null, updatedAt: 0, ...patch })

test('the Position hint describes where the selected option puts the item', async () => {
  items = [view({ id: 'b', state: 'building' }), view({ id: 'q1' }), view({ id: 'q2' })]
  const dialog = open()
  const hint = () => (dialog.querySelector('.mk-seg')!.nextElementSibling as HTMLElement).textContent
  expect(hint()).toBe('4th in line. Replies from requesters still jump ahead.')
  ;(dialog.querySelector('[data-position="next"]') as HTMLButtonElement).click()
  expect(hint()).toBe('Next up. Replies from requesters still jump ahead.')
  dialog.close()
  items = [view({ id: 'b', state: 'building' })]
  const empty = open()
  expect((empty.querySelector('.mk-seg')!.nextElementSibling as HTMLElement).textContent).toBe('Next up. Replies from requesters still jump ahead.')
})

test('a multi-repo row shows its folder with one chip per repo; a single-repo row shows neither', async () => {
  const { renderQueue, readQueueItems } = await import('../client/queue-view')
  const read = readQueueItems([
    { ...view({ id: 'm1' }), repo: '/Users/me/klangtech', repos: ['api', 'backoffice'] },
    { ...view({ id: 's1' }), repo: '/Users/me/api' },
    { ...view({ id: 'bad' }), repo: '/Users/me/x', repos: 'api' },
    { ...view({ id: 'p1' }), repo: '/Users/me/klangtech', repos: [] },
  ])
  expect(read.map(entry => [entry.id, entry.repos ?? null])).toEqual([['m1', ['api', 'backoffice']], ['s1', null], ['bad', null], ['p1', []]])
  const screen = renderQueue(read, { plugins: [], flows: [], now: 0, checkedAt: null, openIds: new Set() })
  const row = (id: string) => screen.querySelector(`.q-row[data-id="${id}"]`) as HTMLElement
  const folder = row('m1').querySelector('.q-folder') as HTMLElement
  expect(folder.getAttribute('title')).toBe('/Users/me/klangtech')
  expect([...folder.querySelectorAll('.q-chip')].map(chip => chip.textContent)).toEqual(['api', 'backoffice'])
  expect(folder.textContent).toBe('klangtechapibackoffice')
  expect(row('s1').querySelector('.q-folder')).toBeNull()
  expect([...row('p1').querySelectorAll('.q-folder .q-chip')].map(chip => chip.textContent)).toEqual(['repos: plan picks'])
})

test('Pick them yourself with every tick removed still lets the plan pick', async () => {
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '5'
  await parentFolder(dialog, ['api', 'web'])
  pickButton(dialog).click()
  repoBoxes(dialog)[0]!.click()
  repoBoxes(dialog)[0]!.click()
  submit(dialog)
  await flush()
  expect(calls.filter(call => call.method === 'POST').map(call => (call.body as { repos: unknown }).repos)).toEqual([[]])
})

test('a row warns when a real repo changed while the item was building', async () => {
  const { renderQueue, readQueueItems } = await import('../client/queue-view')
  const read = readQueueItems([{ ...view({ id: 'w1', state: 'ready' }), repo: '/Users/me/klangtech', repos: ['api'], realChanged: ['web'] }, { ...view({ id: 'ok' }), repo: '/Users/me/klangtech', repos: ['api'] }])
  const screen = renderQueue(read, { plugins: [], flows: [], now: 0, checkedAt: null, openIds: new Set() })
  const warn = screen.querySelector('.q-row[data-id="w1"] .q-real-changed') as HTMLElement
  expect(warn.textContent).toBe('web changed during the build')
  expect(warn.getAttribute('title')).toBe("web in /Users/me/klangtech changed while this item was building — check it wasn't the agent")
  expect(screen.querySelector('.q-row[data-id="ok"] .q-real-changed')).toBeNull()
})
