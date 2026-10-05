import { expect, test } from 'bun:test'

import { ageText, alertFor, diffItems, handleAlertClick, linkFor, requestFor, shouldAlert, tabTitle, type ClickDeps } from '../client/attention-core'
import type { AttentionItem } from '../server/attention'

const item = (patch: Partial<AttentionItem>): AttentionItem => ({ key: 'needs:c1', kind: 'needs', title: 'Login fix', detail: 'Needs you: Build it', command: null, chatId: 'c1', jobId: null, requestId: null, createdAt: 0, ...patch })
const perm = item({ key: 'perm:j1:r1', kind: 'permission', detail: 'Wants to run a command', command: 'bun test', jobId: 'j1', requestId: 'r1' })
const queued = item({ key: 'queue:i1', kind: 'queue', title: 'Login copy', detail: 'Built and ready for review', chatId: null, jobId: null, requestId: null })
const loop = item({ key: 'loop:j2', kind: 'loop', title: 'Army export', detail: 'May be stuck: 81 turns in 20 min', chatId: null, jobId: 'j2' })

test('tab title carries the count only when something waits', () => {
  expect(tabTitle(0)).toBe('Mission Control')
  expect(tabTitle(3)).toBe('(3) Mission Control')
})

test('diff reports new keys as raised and missing keys as resolved', () => {
  expect(diffItems([item({})], [perm])).toEqual({ raised: [perm], resolved: ['needs:c1'] })
  expect(diffItems([perm], [{ ...perm, detail: 'changed' }])).toEqual({ raised: [], resolved: [] })
})

test('alerts fire only when granted, enabled and the user is not looking', () => {
  const base = { permission: 'granted', enabled: true, visible: false, focused: false }
  expect(shouldAlert(base)).toBe(true)
  expect(shouldAlert({ ...base, visible: true, focused: false })).toBe(true)
  expect(shouldAlert({ ...base, visible: true, focused: true })).toBe(false)
  expect(shouldAlert({ ...base, enabled: false })).toBe(false)
  expect(shouldAlert({ ...base, permission: 'default' })).toBe(false)
  expect(shouldAlert({ ...base, permission: 'denied' })).toBe(false)
})

test('each kind gets its title, second line, tag and buttons', () => {
  expect(alertFor(perm)).toEqual({ title: 'Login fix', options: { body: 'Wants to run: bun test', tag: 'perm:j1:r1', renotify: false, icon: '/favicon.svg', data: { key: 'perm:j1:r1', kind: 'permission', chatId: 'c1', jobId: 'j1', requestId: 'r1' }, actions: [{ action: 'allow', title: 'Allow once' }, { action: 'deny', title: 'Deny' }] } })
  expect(alertFor(loop).options.actions).toEqual([{ action: 'stop', title: 'Stop job' }])
  expect(alertFor(loop).options.body).toBe('May be stuck: 81 turns in 20 min')
  expect(alertFor(item({})).options.actions).toEqual([])
})

test('a queue alert has no buttons and reads its reason', () => {
  const queued = item({ key: 'queue:i1', kind: 'queue', title: 'Login copy', detail: 'Built and ready for review', chatId: null, jobId: null, requestId: null })
  expect(alertFor(queued).options.actions).toEqual([])
  expect(alertFor(queued).options.body).toBe('Built and ready for review')
})

test('links open the chat when there is one, else the job; a queue alert links to the Queue screen', () => {
  expect(linkFor(perm)).toBe('/?chat=c1')
  expect(linkFor(loop)).toBe('/?job=j2')
  expect(linkFor(queued)).toBe('/#queue')
})

test('buttons map to the real endpoints and decisions', () => {
  expect(requestFor('allow', perm)).toEqual({ url: '/api/jobs/j1/permission', body: { requestId: 'r1', decision: 'allow_once' }, verb: 'allow' })
  expect(requestFor('deny', perm)).toEqual({ url: '/api/jobs/j1/permission', body: { requestId: 'r1', decision: 'deny' }, verb: 'deny' })
  expect(requestFor('stop', loop)).toEqual({ url: '/api/jobs/j2/kill', body: null, verb: 'stop the job' })
  expect(requestFor('', perm)).toBeNull()
})

test('ages read as now, minutes, hours, days', () => {
  expect(ageText(30_000)).toBe('now')
  expect(ageText(2 * 60_000)).toBe('2 min')
  expect(ageText(3 * 3_600_000)).toBe('3 h')
  expect(ageText(2 * 86_400_000)).toBe('2 d')
})

function recorder(status: number): { calls: string[]; deps: ClickDeps } {
  const calls: string[] = []
  return {
    calls,
    deps: {
      post: async (url) => { calls.push(`post ${url}`); return { ok: status >= 200 && status < 300, status } },
      windows: async () => [],
      open: async (url) => { calls.push(`open ${url}`) },
      show: async (title) => { calls.push(`show ${title}`) },
    },
  }
}

test('Allow on the alert answers the job and shows nothing else', async () => {
  const run = recorder(200)
  await handleAlertClick('allow', perm, run.deps)
  expect(run.calls).toEqual(['post /api/jobs/j1/permission'])
})

test('an already-answered request (409) closes quietly', async () => {
  const run = recorder(409)
  await handleAlertClick('allow', perm, run.deps)
  expect(run.calls).toEqual(['post /api/jobs/j1/permission'])
})

test('a failed answer shows one follow-up alert pointing at the chat', async () => {
  const run = recorder(500)
  await handleAlertClick('deny', perm, run.deps)
  expect(run.calls).toEqual(['post /api/jobs/j1/permission', "show Couldn't deny · Open the chat"])
})

test('a network error counts as a failed answer', async () => {
  const run = recorder(200)
  await handleAlertClick('stop', loop, { ...run.deps, post: async () => { throw new Error('offline') } })
  expect(run.calls).toEqual(["show Couldn't stop the job · Open the chat"])
})

test('a body click focuses an open tab and asks it to open the link, else opens a new tab', async () => {
  const run = recorder(200)
  const seen: unknown[] = []
  await handleAlertClick('', perm, { ...run.deps, windows: async () => [{ focus: async () => { seen.push('focus') }, postMessage: (message) => { seen.push(message) } }] })
  expect(seen).toEqual(['focus', { type: 'mc:open', link: '/?chat=c1' }])
  await handleAlertClick('', loop, run.deps)
  expect(run.calls).toEqual(['open /?job=j2'])
})

test('a queue alert click asks an open tab to show the Queue screen, else opens the cockpit on it', async () => {
  const run = recorder(200)
  const seen: unknown[] = []
  await handleAlertClick('', queued, { ...run.deps, windows: async () => [{ focus: async () => { seen.push('focus') }, postMessage: (message) => { seen.push(message) } }] })
  expect(seen).toEqual(['focus', { type: 'mc:open', link: '/#queue' }])
  await handleAlertClick('', queued, run.deps)
  expect(run.calls).toEqual(['open /#queue'])
})
