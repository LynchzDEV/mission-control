import { afterAll, beforeAll, expect, test } from 'bun:test'

let plainActivity: (text: string) => string
const requested: string[] = []
const realFetch = globalThis.fetch
const realInterval = globalThis.setInterval
let allJobs: Record<string, unknown>[] = []
let chatJobs: Record<string, unknown>[] = []
const elements = new Map<string, any>()
const element = (id: string): any => elements.get(id) ?? elements.set(id, make()).get(id)
const make = (): any => ({ hidden: false, open: false, textContent: '', value: '', dataset: {} as Record<string, string>, children: [] as any[], listeners: {} as Record<string, (() => void)[]>, classList: { add() {}, remove() {} }, append(...nodes: any[]) { this.children.push(...nodes) }, prepend() {}, after() {}, remove() {}, contains: () => false, replaceChildren(...nodes: any[]) { this.children = nodes }, querySelector: make, querySelectorAll: () => [], addEventListener(type: string, listener: () => void) { (this.listeners[type] ??= []).push(listener) }, getAttribute: () => null, setAttribute() {}, focus() {} })
const fire = (id: string, type: string): void => { for (const listener of element(id).listeners[type] ?? []) listener() }

beforeAll(async () => {
  ;(globalThis as any).document = { hidden: false, body: { dataset: { chat: 'c0' } }, createElement: make, querySelectorAll: () => [], getElementById: element }
  element('agents').open = true
  ;(globalThis as any).setInterval = () => 0
  globalThis.fetch = (async (url: string) => { requested.push(url); return Response.json({ jobs: url === '/api/jobs' ? allJobs : url.startsWith('/api/jobs?chat=') ? chatJobs : [] }) }) as typeof fetch
  ;({ plainActivity } = await import('../client/shell-activity'))
})

afterAll(() => {
  delete (globalThis as any).document
  globalThis.setInterval = realInterval
  globalThis.fetch = realFetch
})

test('a chat already open before the drawer script loads is picked up', () => {
  expect(requested).toContain('/api/jobs?chat=c0')
})

test('the Agents drawer loads the agents of the chat it was pointed at', () => {
  element('agents').open = true
  dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: 'c1' }))
  expect(requested).toContain('/api/jobs?chat=c1')
  expect(element('live-agents').hidden).toBe(false)
})

test('clearing the scope empties the drawer and stops chat requests', () => {
  requested.length = 0
  dispatchEvent(new CustomEvent('quiet:activity-scope', { detail: null }))
  expect(requested).toEqual([])
  expect(element('live-agents').hidden).toBe(true)
})

test('an agent step reads in plain words', () => {
  expect(plainActivity('Read client/chat.ts')).toBe('Reading client/chat.ts')
  expect(plainActivity('Bash bun test')).toBe('Running bun test')
  expect(plainActivity('Thinking')).toBe('Thinking')
})

const missing = (): string[] => {
  const ids: string[] = []
  addEventListener('quiet:agent-open-missing', (event) => ids.push((event as CustomEvent<{ jobId: string }>).detail.jobId))
  return ids
}

test('opening a step whose job is outside the list adds that job as a row instead of saying it is gone', async () => {
  element('agents').open = true
  dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: 'c2' }))
  await Bun.sleep(0)
  allJobs = [{ id: 'finished', label: 'Plan', engine: 'claude', model: null, status: 'done', reviewedAt: null, startedAt: 1, endedAt: 2 }]
  const gone = missing()
  requested.length = 0
  dispatchEvent(new CustomEvent('quiet:agent-open', { detail: { jobId: 'finished' } }))
  await Bun.sleep(5)
  expect(requested).toEqual(['/api/jobs?chat=c2', '/api/jobs'])
  expect(element('live-agents-list').children.map((item: any) => item.dataset.job)).toEqual(['finished'])
  expect(gone).toEqual([])
})

test('a step whose job no longer exists anywhere is reported missing', async () => {
  allJobs = []
  const gone = missing()
  dispatchEvent(new CustomEvent('quiet:agent-open', { detail: { jobId: 'vanished' } }))
  await Bun.sleep(5)
  expect(gone).toEqual(['vanished'])
})

const finished = (status = 'done') => ({ id: 'finished', label: 'Plan', engine: 'claude', model: null, status, reviewedAt: null, startedAt: 1, endedAt: status === 'running' ? null : 2 })
const rows = (): string[] => element('live-agents-list').children.map((item: any) => item.dataset.job)
const showOutsideJob = async (chat: string): Promise<void> => {
  element('agents').open = true
  chatJobs = []
  dispatchEvent(new CustomEvent('quiet:chat-agents', { detail: chat }))
  await Bun.sleep(0)
  allJobs = [finished()]
  dispatchEvent(new CustomEvent('quiet:agent-open', { detail: { jobId: 'finished' } }))
  await Bun.sleep(5)
  expect(rows()).toEqual(['finished'])
}
const refreshAgents = async (): Promise<void> => { fire('open-agents', 'click'); await Bun.sleep(5) }
const clickRow = (item: any): void => item.onclick({ target: { closest: () => null } })

test('the row added for an outside job goes away when that row is closed', async () => {
  await showOutsideJob('c3')
  const item = element('live-agents-list').children[0]
  clickRow(item)
  expect(rows()).toEqual(['finished'])
  clickRow(item)
  expect(rows()).toEqual([])
  await refreshAgents()
  expect(rows()).toEqual([])
})

test('the row added for an outside job goes away when the Agents panel closes', async () => {
  await showOutsideJob('c4')
  element('agents').open = false
  fire('agents', 'close')
  expect(rows()).toEqual([])
  element('agents').open = true
  await refreshAgents()
  expect(rows()).toEqual([])
})

test('the row added for an outside job gives way once a refresh lists that job itself', async () => {
  await showOutsideJob('c5')
  chatJobs = [finished()]
  await refreshAgents()
  expect(rows()).toEqual(['finished'])
  chatJobs = []
  await refreshAgents()
  expect(rows()).toEqual([])
})

test('the row added for an outside job is rebuilt from the job list on each refresh', async () => {
  await showOutsideJob('c6')
  allJobs = [finished('running')]
  requested.length = 0
  await refreshAgents()
  expect(requested).toContain('/api/jobs')
  const [line] = element('live-agents-list').children[0].children
  expect(line.children[3].textContent).toBe('Working')
  allJobs = []
  await refreshAgents()
  expect(rows()).toEqual([])
})
