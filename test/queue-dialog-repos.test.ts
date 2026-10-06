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

test('checking a folder disables Add and says so until the answer arrives', async () => {
  const dialog = open()
  typeFolder(dialog, '/Users/me/api')
  await flush()
  expect(calls.map(call => call.url)).toEqual([folderUrl('/Users/me/api')])
  expect(addButton(dialog).disabled).toBe(true)
  expect((dialog.querySelector('.q-folder-check') as HTMLElement).textContent).toBe('Checking folder…')
  reply('/Users/me/api', { path: '/Users/me/api', isRepo: true, repos: [] })
  await flush()
  expect(addButton(dialog).disabled).toBe(false)
  expect((dialog.querySelector('.q-folder-check') as HTMLElement).hidden).toBe(true)
  expect(dialog.querySelector('.q-repos')).toBeNull()
  expect(alertText(dialog)).toBe('')
})

test('a parent folder offers its repos as checkboxes, none ticked, with clickable labels', async () => {
  const dialog = open()
  typeFolder(dialog, '/Users/me/klangtech')
  await flush()
  reply('/Users/me/klangtech', { path: '/Users/me/klangtech', isRepo: false, repos: ['api', 'backoffice', 'portal'] })
  await flush()
  const group = dialog.querySelector('fieldset.q-repos') as HTMLFieldSetElement
  expect(group.querySelector('legend')?.textContent).toBe('Repos this ticket touches')
  expect(repoBoxes(dialog).map(box => [box.value, box.checked])).toEqual([['api', false], ['backoffice', false], ['portal', false]])
  const label = repoBoxes(dialog)[1]!.closest('label') as HTMLLabelElement
  expect(label.textContent).toBe('backoffice')
  label.click()
  expect(repoBoxes(dialog)[1]!.checked).toBe(true)
})

test('Add with no repo ticked asks for one and posts nothing; ticked repos are posted', async () => {
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '86abc'
  typeFolder(dialog, '/Users/me/klangtech')
  await flush()
  reply('/Users/me/klangtech', { path: '/Users/me/klangtech', isRepo: false, repos: ['api', 'backoffice'] })
  await flush()
  submit(dialog)
  await flush()
  expect(alertText(dialog)).toBe('Tick at least one repo this ticket touches')
  expect(calls.filter(call => call.method === 'POST')).toEqual([])
  repoBoxes(dialog)[1]!.click()
  repoBoxes(dialog)[0]!.click()
  submit(dialog)
  await flush()
  const posted = calls.filter(call => call.method === 'POST')
  expect(posted.map(call => call.body)).toEqual([{ source: 'clickup-board', externalId: '86abc', repo: '/Users/me/klangtech', repos: ['api', 'backoffice'], position: 'end' }])
  expect(dialog.open).toBe(false)
})

test('a folder with one repo inside has it ticked already', async () => {
  const dialog = open()
  typeFolder(dialog, '/Users/me/solo-parent')
  await flush()
  reply('/Users/me/solo-parent', { path: '/Users/me/solo-parent', isRepo: false, repos: ['api'] })
  await flush()
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
  expect(addButton(dialog).disabled).toBe(false)
})

test('Add for a folder not checked yet posts it as a repo, then offers its repos when it turns out to be a parent', async () => {
  answer = call => (call.method === 'POST' ? Response.json({ error: 'cwd is not a git repository' }, { status: 400 }) : Response.json({ path: '/Users/me/klangtech', isRepo: false, repos: ['api', 'web'] }))
  const dialog = open()
  field<HTMLInputElement>(dialog, 'ref').value = '1'
  field<HTMLInputElement>(dialog, 'repo').value = '/Users/me/klangtech'
  submit(dialog)
  await flush(8)
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST /api/queue', `GET ${folderUrl('/Users/me/klangtech')}`])
  expect(calls[0]!.body).toEqual({ source: 'clickup-board', externalId: '1', repo: '/Users/me/klangtech', position: 'end' })
  expect(repoBoxes(dialog).map(box => box.value)).toEqual(['api', 'web'])
  expect(alertText(dialog)).toBe('Tick at least one repo this ticket touches')
  expect(dialog.open).toBe(true)
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
  ])
  expect(read.map(entry => [entry.id, entry.repos ?? null])).toEqual([['m1', ['api', 'backoffice']], ['s1', null], ['bad', null]])
  const screen = renderQueue(read, { plugins: [], flows: [], now: 0, checkedAt: null, openIds: new Set() })
  const row = (id: string) => screen.querySelector(`.q-row[data-id="${id}"]`) as HTMLElement
  const folder = row('m1').querySelector('.q-folder') as HTMLElement
  expect(folder.getAttribute('title')).toBe('/Users/me/klangtech')
  expect([...folder.querySelectorAll('.q-chip')].map(chip => chip.textContent)).toEqual(['api', 'backoffice'])
  expect(folder.textContent).toBe('klangtechapibackoffice')
  expect(row('s1').querySelector('.q-folder')).toBeNull()
})
