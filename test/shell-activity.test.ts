import { afterAll, beforeAll, expect, test } from 'bun:test'

let plainActivity: (text: string) => string
const requested: string[] = []
const realFetch = globalThis.fetch
const realInterval = globalThis.setInterval
let allJobs: Record<string, unknown>[] = []
const elements = new Map<string, any>()
const element = (id: string): any => elements.get(id) ?? elements.set(id, make()).get(id)
const make = (): any => ({ hidden: false, open: false, textContent: '', value: '', dataset: {} as Record<string, string>, children: [] as any[], append(...nodes: any[]) { this.children.push(...nodes) }, replaceChildren(...nodes: any[]) { this.children = nodes }, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, focus() {} })

beforeAll(async () => {
  ;(globalThis as any).document = { hidden: false, body: { dataset: { chat: 'c0' } }, createElement: make, querySelectorAll: () => [], getElementById: element }
  element('agents').open = true
  ;(globalThis as any).setInterval = () => 0
  globalThis.fetch = (async (url: string) => { requested.push(url); return Response.json({ jobs: url === '/api/jobs' ? allJobs : [] }) }) as typeof fetch
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
