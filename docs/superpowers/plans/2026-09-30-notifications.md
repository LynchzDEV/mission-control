# Notifications ("Waiting on you") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `osascript` popups with one saved "Waiting on you" list, a bell in the top bar, and browser Mac alerts whose buttons answer or open the exact chat/job.

**Architecture:** `server/attention.ts` is a small saved store that also acts as a `RunEvents` source, so the existing `eventStreamResponse` streams full snapshots of it. Existing trigger points raise and resolve items. The cockpit (`client/attention.ts`) renders the bell and the panel from the stream, diffs snapshots to show or close notifications, and a service worker (`client/sw.ts`, served at `/sw.js`) handles alert clicks. All decision logic lives in DOM-free `client/attention-core.ts` so it can be unit-tested.

**Tech Stack:** Bun + Elysia server, plain TS client islands transpiled on request, `bun test`, jsdom for DOM tests, Playwright for the browser check.

**Spec:** `docs/superpowers/specs/2026-09-30-notifications-design.md` · UI decision: `../visualizer/notifications/DECISION.md` (variant A), mock `../visualizer/notifications/a.html`.

## Global Constraints

- Work in a detached worktree: `git worktree add --detach .worktree/notifications main`. No new branch. Land by cherry-picking onto `main`.
- Never edit `client/*.ts` in the main checkout while building: the live cockpit on :7777 transpiles it on every page load.
- No new polling timers or intervals (acceptance concern 6). Ages are computed on render.
- Comments: at most 1 line, only for a trap no refactor can express.
- No emoji anywhere in UI copy.
- Permission raise wiring is deferred until `chat-upgrade-23` lands. Everything else about the permission kind (store, UI, alert actions, click handling) ships now.
- Permission decisions sent to `POST /api/jobs/:id/permission` are exactly `allow_once` and `deny` (`.worktree/chat-upgrade-23/server/routes/jobs.ts:870`).
- Deviation from the spec: the stream sends full snapshots through the existing `eventStreamResponse` (`server/run-events.ts:11`), not separate `raise` / `resolve` events. The client diffs snapshots, which gives the same behavior with no new stream code.
- Deviation from the spec: rail dots are unchanged. The sidebar already marks chats that need you from job state (`client/sidebar.ts:57`).
- After any throwaway server or `bun test` from the worktree, restore the global skill link: `ln -sfn /Users/lynchz/Desktop/kingpinggroup/mission-control/skills/mc-dispatch ~/.claude/skills/mc-dispatch`.

## Review Focus

1. Reloading the cockpit must not re-alert everything already waiting. The first snapshot primes the list silently (Task 5 test).
2. Two open cockpit tabs must not double-alert. Same `tag`, `renotify: false` (Task 4 test on `alertFor`).
3. A chat agent's own report turn (`source: 'agent'`) must not clear that chat's needs-you item; only a user turn or a new agent job does (Task 3 test).
4. A permission answered from the chat card, then clicked on the stale alert, returns 409. That must close quietly, not show "Couldn't allow" (Task 4 test).
5. A server restart must drop permission and loop items whose job is no longer running, but keep needs items (Task 1 test).

---

### Task 1: The attention store

**Files:**
- Create: `server/attention.ts`
- Test: `test/attention.test.ts`
- Setup first: `cd /Users/lynchz/Desktop/kingpinggroup/mission-control && git worktree add --detach .worktree/notifications main && cd .worktree/notifications && bun install`

**Interfaces:**
- Produces:
  - `type AttentionKind = 'permission' | 'needs' | 'loop'`
  - `type AttentionItem = { key; kind; title; detail; command: string | null; chatId: string | null; jobId: string | null; requestId: string | null; createdAt: number }`
  - `type AttentionStore = RunEvents & { list(); raise(item: Omit<AttentionItem, 'createdAt'>): Promise<void>; resolve(key): Promise<boolean>; resolveWhere(match): Promise<number>; prune(isRunning: (jobId: string) => boolean): Promise<void> }`
  - `attentionKey.{permission(jobId, requestId), needs(chatId), loop(jobId)}`
  - `chatOfJob(record: Pick<JobRecord, 'purpose' | 'threadRoot' | 'chatId'>): string | null`
  - `attentionPath()`, `createAttentionStore(path = attentionPath(), clock = Date.now)`

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attentionKey, chatOfJob, createAttentionStore, type AttentionItem } from '../server/attention'

const file = () => join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json')
const needs = (chatId: string): Omit<AttentionItem, 'createdAt'> => ({ key: attentionKey.needs(chatId), kind: 'needs', title: 'Login fix', detail: 'Needs you: Build it', command: null, chatId, jobId: null, requestId: null })
const loop = (jobId: string): Omit<AttentionItem, 'createdAt'> => ({ key: attentionKey.loop(jobId), kind: 'loop', title: 'Army export', detail: 'May be stuck: 81 turns in 20 min', command: null, chatId: null, jobId, requestId: null })

test('raising the same key twice keeps one item, its first time and the newest detail', async () => {
  let now = 1000
  const store = createAttentionStore(file(), () => now)
  await store.raise(needs('c1'))
  now = 2000
  await store.raise({ ...needs('c1'), detail: 'Needs you: Build it, Ship it' })
  expect(store.list()).toEqual([{ ...needs('c1'), detail: 'Needs you: Build it, Ship it', createdAt: 1000 }])
})

test('resolve removes by key and reports whether anything was there', async () => {
  const store = createAttentionStore(file())
  await store.raise(needs('c1'))
  expect(await store.resolve(attentionKey.needs('c1'))).toBe(true)
  expect(await store.resolve(attentionKey.needs('c1'))).toBe(false)
  expect(store.list()).toEqual([])
})

test('resolveWhere removes every match and returns the count', async () => {
  const store = createAttentionStore(file())
  await store.raise(loop('j1'))
  await store.raise(needs('c1'))
  expect(await store.resolveWhere(item => item.jobId === 'j1')).toBe(1)
  expect(store.list().map(item => item.key)).toEqual([attentionKey.needs('c1')])
})

test('items survive a restart', async () => {
  const path = file()
  await createAttentionStore(path).raise(needs('c1'))
  expect(createAttentionStore(path).list().map(item => item.key)).toEqual([attentionKey.needs('c1')])
})

test('prune drops permission and loop items for jobs no longer running and keeps needs items', async () => {
  const store = createAttentionStore(file())
  await store.raise(loop('gone'))
  await store.raise(loop('alive'))
  await store.raise({ key: attentionKey.permission('gone', 'r1'), kind: 'permission', title: 'Chat', detail: 'Wants to run a command', command: 'ls', chatId: 'c9', jobId: 'gone', requestId: 'r1' })
  await store.raise(needs('c1'))
  await store.prune(jobId => jobId === 'alive')
  expect(store.list().map(item => item.key).sort()).toEqual([attentionKey.loop('alive'), attentionKey.needs('c1')].sort())
})

test('a corrupt file starts empty instead of throwing', () => {
  const path = file()
  writeFileSync(path, '{not json')
  expect(createAttentionStore(path).list()).toEqual([])
})

test('every change notifies subscribers and the file holds the list', async () => {
  const path = file()
  const store = createAttentionStore(path)
  let calls = 0
  store.subscribe(() => { calls += 1 })
  await store.raise(needs('c1'))
  await store.resolve(attentionKey.needs('c1'))
  expect(calls).toBe(2)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ items: [] })
})

test('chatOfJob points chat turns at their thread root and agent jobs at their chat', () => {
  expect(chatOfJob({ purpose: 'chat', threadRoot: 'root1', chatId: undefined })).toBe('root1')
  expect(chatOfJob({ purpose: undefined, threadRoot: 'j1', chatId: 'root2' })).toBe('root2')
  expect(chatOfJob({ purpose: undefined, threadRoot: 'j1', chatId: undefined })).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `bun test test/attention.test.ts`. Expected: FAIL, cannot find module `../server/attention`.

- [ ] **Step 3: Implement `server/attention.ts`**

```ts
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { JobRecord } from './jobs'
import type { RunEvents } from './run-events'
import { configDir } from './secrets'
import { atomicJson } from './workflows'

export const ATTENTION_FILE = 'attention.json'

export type AttentionKind = 'permission' | 'needs' | 'loop'

export type AttentionItem = {
  key: string
  kind: AttentionKind
  title: string
  detail: string
  command: string | null
  chatId: string | null
  jobId: string | null
  requestId: string | null
  createdAt: number
}

export type AttentionStore = RunEvents & {
  list(): AttentionItem[]
  raise(item: Omit<AttentionItem, 'createdAt'>): Promise<void>
  resolve(key: string): Promise<boolean>
  resolveWhere(match: (item: AttentionItem) => boolean): Promise<number>
  prune(isRunning: (jobId: string) => boolean): Promise<void>
}

export const attentionKey = {
  permission: (jobId: string, requestId: string) => `perm:${jobId}:${requestId}`,
  needs: (chatId: string) => `needs:${chatId}`,
  loop: (jobId: string) => `loop:${jobId}`,
}

export function chatOfJob(record: Pick<JobRecord, 'purpose' | 'threadRoot' | 'chatId'>): string | null {
  if (record.purpose === 'chat') return record.threadRoot
  return record.chatId ?? null
}

export function attentionPath(): string {
  return join(configDir(), ATTENTION_FILE)
}

const KINDS = new Set<string>(['permission', 'needs', 'loop'])
const text = (value: unknown): value is string => typeof value === 'string'
const textOrNull = (value: unknown): boolean => value === null || typeof value === 'string'

function isItem(value: unknown): value is AttentionItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return text(item.key) && KINDS.has(item.kind as string) && text(item.title) && text(item.detail)
    && textOrNull(item.command) && textOrNull(item.chatId) && textOrNull(item.jobId) && textOrNull(item.requestId)
    && typeof item.createdAt === 'number'
}

function load(path: string): AttentionItem[] {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  try {
    const parsed = JSON.parse(raw) as { items?: unknown }
    return Array.isArray(parsed.items) ? parsed.items.filter(isItem) : []
  } catch (error) {
    console.error(`attention list unreadable, starting empty: ${path}`, error)
    return []
  }
}

export function createAttentionStore(path = attentionPath(), clock: () => number = Date.now): AttentionStore {
  let items = load(path)
  const listeners = new Set<() => void>()
  let writing: Promise<void> = Promise.resolve()

  const changed = () => { for (const listener of listeners) listener() }
  const save = (next: AttentionItem[]): Promise<void> => {
    items = next
    changed()
    const snapshot = items
    writing = writing
      .then(async () => { await mkdir(dirname(path), { recursive: true }); await atomicJson(path, { items: snapshot }) })
      .catch(error => console.error('attention list save failed', error))
    return writing
  }

  return {
    changed,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    list: () => items,
    raise: async item => {
      const existing = items.find(entry => entry.key === item.key)
      const next = { ...item, createdAt: existing?.createdAt ?? clock() }
      await save(existing ? items.map(entry => (entry.key === item.key ? next : entry)) : [...items, next])
    },
    resolve: async key => {
      if (!items.some(item => item.key === key)) return false
      await save(items.filter(item => item.key !== key))
      return true
    },
    resolveWhere: async match => {
      const kept = items.filter(item => !match(item))
      const removed = items.length - kept.length
      if (removed > 0) await save(kept)
      return removed
    },
    prune: async isRunning => {
      const kept = items.filter(item => item.kind === 'needs' || (item.jobId !== null && isRunning(item.jobId)))
      if (kept.length !== items.length) await save(kept)
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `bun test test/attention.test.ts`. Expected: 8 pass, 0 fail.
- [ ] **Step 5: Commit.** `git add server/attention.ts test/attention.test.ts && git commit -m "feat(attention): a saved list of what is waiting on you"`

### Task 2: Attention routes and the stream

**Files:**
- Create: `server/routes/attention.ts`
- Modify: `server/index.ts` (create the store, prune on start, mount the routes)
- Test: `test/attention-routes.test.ts`

**Interfaces:**
- Consumes: `AttentionStore`, `attentionKey` (Task 1); `eventStreamResponse` (`server/run-events.ts:11`); `requireLocal` (`server/auth.ts:40`).
- Produces:
  - `attentionRoutes(store: AttentionStore): Elysia`;
  - `GET /api/attention` → `{ items }`;
  - `GET /api/attention/stream` (SSE `data: {"items":[…]}`);
  - `POST /api/attention/:key/dismiss` → 200 `{ ok: true }` / 404 / 409.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import { attentionKey, createAttentionStore } from '../server/attention'
import { attentionRoutes } from '../server/routes/attention'

const store = () => createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))
const call = (app: Elysia, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777' } }))
const needs = { key: attentionKey.needs('c1'), kind: 'needs' as const, title: 'Login fix', detail: 'Needs you: Build it', command: null, chatId: 'c1', jobId: null, requestId: null }
const perm = { key: attentionKey.permission('j1', 'r1'), kind: 'permission' as const, title: 'Chat', detail: 'Wants to run a command', command: 'ls', chatId: 'c1', jobId: 'j1', requestId: 'r1' }

test('GET lists the items', async () => {
  const items = store()
  await items.raise(needs)
  const response = await call(new Elysia().use(attentionRoutes(items)), '/api/attention')
  expect((await response.json()).items.map((item: { key: string }) => item.key)).toEqual([needs.key])
})

test('the stream sends a snapshot, then a new snapshot after a change', async () => {
  const items = store()
  const controller = new AbortController()
  const response = await new Elysia().use(attentionRoutes(items)).handle(new Request('http://127.0.0.1:7777/api/attention/stream', { headers: { host: '127.0.0.1:7777' }, signal: controller.signal }))
  const reader = response.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).toBe('data: {"items":[]}\n\n')
  await items.raise(needs)
  const second = new TextDecoder().decode((await reader.read()).value)
  expect(JSON.parse(second.slice('data: '.length)).items[0].key).toBe(needs.key)
  controller.abort()
})

test('dismiss clears a needs item, refuses a permission item, and 404s an unknown key', async () => {
  const items = store()
  await items.raise(needs)
  await items.raise(perm)
  const app = new Elysia().use(attentionRoutes(items))
  expect((await call(app, `/api/attention/${encodeURIComponent(needs.key)}/dismiss`, { method: 'POST' })).status).toBe(200)
  expect((await call(app, `/api/attention/${encodeURIComponent(perm.key)}/dismiss`, { method: 'POST' })).status).toBe(409)
  expect((await call(app, `/api/attention/${encodeURIComponent('needs:nope')}/dismiss`, { method: 'POST' })).status).toBe(404)
  expect(items.list().map(item => item.key)).toEqual([perm.key])
})

test('a request from outside this machine is refused', async () => {
  const response = await new Elysia().use(attentionRoutes(store())).handle(new Request('http://evil.example/api/attention', { headers: { host: 'evil.example' } }))
  expect(response.status).toBe(403)
})
```

- [ ] **Step 2: Run to verify it fails.** `bun test test/attention-routes.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `server/routes/attention.ts`**

```ts
import { Elysia } from 'elysia'

import type { AttentionStore } from '../attention'
import { requireLocal } from '../auth'
import { eventStreamResponse } from '../run-events'

export function attentionRoutes(store: AttentionStore): Elysia {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/attention', () => ({ items: store.list() }))
    .get('/api/attention/stream', ({ request }) => eventStreamResponse(store, () => ({ items: store.list() }), request.signal))
    .post('/api/attention/:key/dismiss', async ({ params, set }) => {
      const key = decodeURIComponent(params.key)
      const item = store.list().find(entry => entry.key === key)
      if (item === undefined) { set.status = 404; return { error: 'Nothing waiting under that key' } }
      if (item.kind === 'permission') { set.status = 409; return { error: 'Answer the permission request instead' } }
      await store.resolve(key)
      return { ok: true }
    })
}
```

If Elysia already decodes `params.key`, `decodeURIComponent` of an already-decoded `needs:c1` is a no-op; the test pins it.

- [ ] **Step 4: Wire `server/index.ts`.** Import `createAttentionStore` and `attentionRoutes`. At the top of `createApp()`, after `const runEvents = createRunEvents()`, add `const attention = createAttentionStore()`. After `await workflowBuilder.recover()`, add `await attention.prune(jobId => jobManager.getJob(jobId)?.status === 'running')`. Add `.use(attentionRoutes(attention))` after `.use(outcomesRoutes(outcomeLedger))`.
- [ ] **Step 5: Run.** `bun test test/attention-routes.test.ts test/attention.test.ts`. Expected: all pass.
- [ ] **Step 6: Commit.** `git add server/routes/attention.ts server/index.ts test/attention-routes.test.ts && git commit -m "feat(attention): list, live stream and dismiss routes"`

### Task 3: Raise and resolve from the real events; delete `osascript`

**Files:**
- Modify: `server/index.ts` (`onJobSlow`, `onJobStarted`, `onJobSettled`, `chatFlusher` options, `jobsRoutes` options, import lines)
- Modify: `server/chat-reports.ts` (option `notify` becomes `needsYou`; lines 35, 200, 216)
- Modify: `server/routes/jobs.ts` (remove `notifyChat` import and `notify` option; land resolves needs; lines 16, 196, 204, 434)
- Delete: `server/notify.ts`, `test/notify.test.ts`
- Create: `server/attention-events.ts` (the pure mapping from job events to store calls, so index.ts stays thin and the rules are testable)
- Test: `test/attention-events.test.ts`; update `test/chat-reports.test.ts` (lines 192, 212, 300, 319, 460, 572 and their expectations) and `test/jobs-routes.test.ts:885-895`

**Interfaces:**
- Consumes: `AttentionStore`, `attentionKey`, `chatOfJob` (Task 1).
- Produces:
  - `attentionEvents(store): { slow(record: JobRecord): Promise<void>; started(record: JobRecord): Promise<void>; settled(record: JobRecord): Promise<void>; needsYou(root: JobRecord, detail: string): Promise<void> }`;
  - `ChatFlusherOptions.needsYou?: (root: JobRecord, detail: string) => Promise<void> | void`;
  - `JobsRoutesOptions.attention?: AttentionStore`.

- [ ] **Step 1: Write the failing tests** (`test/attention-events.test.ts`)

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attentionKey, createAttentionStore } from '../server/attention'
import { attentionEvents } from '../server/attention-events'
import type { JobRecord } from '../server/jobs'

const store = () => createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))
const job = (patch: Partial<JobRecord>): JobRecord => ({ id: 'j1', label: 'Army export', threadRoot: 'j1', turns: 81, startedAt: 0, slowAt: 20 * 60_000, status: 'running', ...patch } as JobRecord)

test('a slow job raises one loop item that links to its chat', async () => {
  const items = store()
  await attentionEvents(items).slow(job({ chatId: 'c1' }))
  expect(items.list()).toMatchObject([{ key: attentionKey.loop('j1'), kind: 'loop', title: 'Army export', detail: 'May be stuck: 81 turns in 20 min', chatId: 'c1', jobId: 'j1' }])
})

test('needsYou raises one item per chat', async () => {
  const items = store()
  const events = attentionEvents(items)
  await events.needsYou(job({ id: 'root1', label: 'Login fix', purpose: 'chat', threadRoot: 'root1' }), 'Needs you: Build it')
  await events.needsYou(job({ id: 'root1', label: 'Login fix', purpose: 'chat', threadRoot: 'root1' }), 'Needs you: Ship it')
  expect(items.list()).toMatchObject([{ key: attentionKey.needs('root1'), title: 'Login fix', detail: 'Needs you: Ship it', chatId: 'root1' }])
})

test('a user turn or a new agent job in the chat clears its needs item; an agent report turn does not', async () => {
  const items = store()
  const events = attentionEvents(items)
  const root = job({ id: 'root1', label: 'Login fix', purpose: 'chat', threadRoot: 'root1' })
  await events.needsYou(root, 'Needs you: Build it')
  await events.started(job({ id: 't2', purpose: 'chat', threadRoot: 'root1', source: 'agent' }))
  expect(items.list()).toHaveLength(1)
  await events.started(job({ id: 't3', purpose: 'chat', threadRoot: 'root1', source: 'user' }))
  expect(items.list()).toEqual([])
  await events.needsYou(root, 'Needs you: Build it')
  await events.started(job({ id: 'retry', chatId: 'root1' }))
  expect(items.list()).toEqual([])
})

test('a job that ends clears its loop and permission items but not its chat needs item', async () => {
  const items = store()
  const events = attentionEvents(items)
  await events.slow(job({ chatId: 'root1' }))
  await items.raise({ key: attentionKey.permission('j1', 'r1'), kind: 'permission', title: 'Chat', detail: 'Wants to run a command', command: 'ls', chatId: 'root1', jobId: 'j1', requestId: 'r1' })
  await events.needsYou(job({ id: 'root1', label: 'Login fix', purpose: 'chat', threadRoot: 'root1' }), 'Needs you: Build it')
  await events.settled(job({ status: 'failed', chatId: 'root1' }))
  expect(items.list().map(item => item.kind)).toEqual(['needs'])
})
```

- [ ] **Step 2: Run to verify it fails.** `bun test test/attention-events.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `server/attention-events.ts`**

```ts
import { attentionKey, chatOfJob, type AttentionStore } from './attention'
import type { JobRecord } from './jobs'

export function attentionEvents(store: AttentionStore) {
  return {
    slow: async (record: JobRecord): Promise<void> => {
      const minutes = Math.floor(((record.slowAt ?? Date.now()) - record.startedAt) / 60_000)
      console.error(`job slow: ${record.label} · ${record.turns} turns · ${minutes} min`.replace(/[\r\n]+/g, ' '))
      await store.raise({ key: attentionKey.loop(record.id), kind: 'loop', title: record.label, detail: `May be stuck: ${record.turns} turns in ${minutes} min`, command: null, chatId: chatOfJob(record), jobId: record.id, requestId: null })
    },
    needsYou: async (root: JobRecord, detail: string): Promise<void> => {
      await store.raise({ key: attentionKey.needs(root.id), kind: 'needs', title: root.label, detail, command: null, chatId: root.id, jobId: null, requestId: null })
    },
    started: async (record: JobRecord): Promise<void> => {
      const chat = chatOfJob(record)
      if (chat === null || (record.purpose === 'chat' && record.source === 'agent')) return
      await store.resolve(attentionKey.needs(chat))
    },
    settled: async (record: JobRecord): Promise<void> => {
      await store.resolveWhere(item => item.jobId === record.id && item.kind !== 'needs')
    },
  }
}
```

- [ ] **Step 4: `server/chat-reports.ts`.**
  - In the options type (line ~35), replace `notify?: (title: string, body: string) => Promise<void>` with `needsYou?: (root: JobRecord, detail: string) => Promise<void> | void`.
  - Line 200 becomes `if (needing.length > 0) await opts.needsYou?.(root, \`Needs you: ${needing.join(', ')}\`)`.
  - Line 216 becomes `await opts.needsYou?.(root, \`Needs you: waiting after ${AGENT_ROUNDS_MAX} agent rounds\`)`.
- [ ] **Step 5: Update `test/chat-reports.test.ts`.**
  - Replace each `notify: async (title, body) => { notes.push(\`${title}|${body}\`) }` with `needsYou: (root, detail) => { notes.push(\`${root.label}|${detail}\`) }`.
  - Change the expectations to `'Login fix|Needs you: Build it'` (lines 213, 304), `'Login fix|Needs you: waiting after 12 agent rounds'` (line 321) and `'Login fix|Needs you: workflow Shipping'` (line 578).
  - The `[]` expectations stay.
- [ ] **Step 6: `server/routes/jobs.ts`.**
  - Delete the `notifyChat` import (line 16).
  - Change `JobsRoutesOptions` to `{ attention?: AttentionStore; queue?: ChatQueue; terminals?: TerminalSessions }`, importing `attentionKey` and `type AttentionStore` from `'../attention'`.
  - Delete `const notify = options.notify ?? notifyChat`.
  - Replace line 434 with `if (landed?.chatId) await options.attention?.resolve(attentionKey.needs(landed.chatId))`.
- [ ] **Step 7: Update `test/jobs-routes.test.ts:885-895`.** Rename the test to `'landing a chat-spawned job clears that chat's waiting item'`.
  - Build the store with `createAttentionStore(join(mkdtempSync(join(tmpdir(), 'mc-attention-')), 'attention.json'))` and pass `{ attention }` to `jobsRoutes`.
  - After creating `root`, call `await attention.raise({ key: attentionKey.needs(root.id), kind: 'needs', title: 'chat', detail: 'Needs you: land-me', command: null, chatId: root.id, jobId: null, requestId: null })`.
  - Replace the final expectation with `expect(attention.list()).toEqual([])`.
  - Add the imports this needs.
- [ ] **Step 8: `server/index.ts`.**
  - Remove the `./notify` import and add `import { attentionEvents } from './attention-events'`.
  - After `const attention = createAttentionStore()`, add `const attentionOn = attentionEvents(attention)`.
  - `onJobSlow: record => { void attentionOn.slow(record).catch(error => console.error('Attention raise failed', error)) }`.
  - At the end of `onJobStarted`, add `void attentionOn.started(record).catch(() => {})`.
  - At the top of `onJobSettled`, after `runEvents.changed()`, add `void attentionOn.settled(record).catch(() => {})`.
  - In `createChatFlusher` options, replace `notify: notifyChat` with `needsYou: attentionOn.needsYou`.
  - In `.use(jobsRoutes(...))`, pass `{ queue: chatQueue, terminals: terminalRegistry, attention }`.
- [ ] **Step 9: Delete** `server/notify.ts` and `test/notify.test.ts`. Run `grep -rn "notify'" server test client` and expect no hits.
- [ ] **Step 10: Run.** `bun test test/attention-events.test.ts test/chat-reports.test.ts test/jobs-routes.test.ts test/attention.test.ts test/attention-routes.test.ts`. Expected: all pass.
- [ ] **Step 11: Commit.** `git add -A server test && git commit -m "feat(attention): slow jobs, needs-you and land feed the list; osascript popups removed"`

### Task 4: Client decision logic (DOM-free)

**Files:**
- Create: `client/attention-core.ts`
- Modify: `tsconfig.shell.json` (add `client/attention-core.ts`, `client/attention.ts`)
- Test: `test/attention-core.test.ts`

**Interfaces:**
- Consumes: `type AttentionItem` from `../server/attention` (type-only import).
- Produces:
  - `tabTitle(count: number): string`;
  - `diffItems(before, after): { raised: AttentionItem[]; resolved: string[] }`;
  - `shouldAlert(state: { permission: string; enabled: boolean; visible: boolean; focused: boolean }): boolean`;
  - `alertFor(item): { title: string; options: AlertOptions }`;
  - `type AlertData = Pick<AttentionItem, 'key' | 'kind' | 'chatId' | 'jobId' | 'requestId'>`;
  - `linkFor(data: AlertData): string`;
  - `requestFor(action: string, data: AlertData): { url: string; body: unknown; verb: string } | null`;
  - `ageText(ms: number): string`;
  - `handleAlertClick(action, data, deps: ClickDeps): Promise<void>`, where `ClickDeps = { post(url: string, body: unknown): Promise<{ ok: boolean; status: number }>; windows(): Promise<Array<{ focus(): Promise<unknown>; postMessage(message: unknown): void }>>; open(url: string): Promise<unknown>; show(title: string, options: AlertOptions): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'

import { ageText, alertFor, diffItems, handleAlertClick, linkFor, requestFor, shouldAlert, tabTitle, type AlertData } from '../client/attention-core'
import type { AttentionItem } from '../server/attention'

const item = (patch: Partial<AttentionItem>): AttentionItem => ({ key: 'needs:c1', kind: 'needs', title: 'Login fix', detail: 'Needs you: Build it', command: null, chatId: 'c1', jobId: null, requestId: null, createdAt: 0, ...patch })
const perm = item({ key: 'perm:j1:r1', kind: 'permission', detail: 'Wants to run a command', command: 'bun test', jobId: 'j1', requestId: 'r1' })
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

test('links open the chat when there is one, else the job', () => {
  expect(linkFor(perm)).toBe('/?chat=c1')
  expect(linkFor(loop)).toBe('/?job=j2')
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

function deps(status: number) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      post: async (url: string) => { calls.push(`post ${url}`); return { ok: status >= 200 && status < 300, status } },
      windows: async () => [] as Array<{ focus(): Promise<unknown>; postMessage(message: unknown): void }>,
      open: async (url: string) => { calls.push(`open ${url}`) },
      show: async (title: string) => { calls.push(`show ${title}`) },
    },
  }
}

test('Allow on the alert answers the job and shows nothing else', async () => {
  const run = deps(200)
  await handleAlertClick('allow', perm as AlertData, run.deps)
  expect(run.calls).toEqual(['post /api/jobs/j1/permission'])
})

test('an already-answered request (409) closes quietly', async () => {
  const run = deps(409)
  await handleAlertClick('allow', perm as AlertData, run.deps)
  expect(run.calls).toEqual(['post /api/jobs/j1/permission'])
})

test('a failed answer shows one follow-up alert pointing at the chat', async () => {
  const run = deps(500)
  await handleAlertClick('deny', perm as AlertData, run.deps)
  expect(run.calls).toEqual(['post /api/jobs/j1/permission', "show Couldn't deny · Open the chat"])
})

test('a body click focuses an open tab and asks it to open the link, else opens a new tab', async () => {
  const run = deps(200)
  const seen: unknown[] = []
  await handleAlertClick('', perm as AlertData, { ...run.deps, windows: async () => [{ focus: async () => { seen.push('focus') }, postMessage: (message: unknown) => { seen.push(message) } }] })
  expect(seen).toEqual(['focus', { type: 'mc:open', link: '/?chat=c1' }])
  await handleAlertClick('', loop as AlertData, run.deps)
  expect(run.calls).toEqual(['open /?job=j2'])
})
```

- [ ] **Step 2: Run to verify it fails.** `bun test test/attention-core.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `client/attention-core.ts`**

```ts
import type { AttentionItem } from '../server/attention'

export type AlertData = Pick<AttentionItem, 'key' | 'kind' | 'chatId' | 'jobId' | 'requestId'>
export type AlertOptions = { body: string; tag: string; renotify: boolean; icon: string; data: AlertData; actions: Array<{ action: string; title: string }> }
export type ClickDeps = {
  post(url: string, body: unknown): Promise<{ ok: boolean; status: number }>
  windows(): Promise<Array<{ focus(): Promise<unknown>; postMessage(message: unknown): void }>>
  open(url: string): Promise<unknown>
  show(title: string, options: AlertOptions): Promise<void>
}

const ACTIONS: Record<AttentionItem['kind'], AlertOptions['actions']> = {
  permission: [{ action: 'allow', title: 'Allow once' }, { action: 'deny', title: 'Deny' }],
  loop: [{ action: 'stop', title: 'Stop job' }],
  needs: [],
}

export const tabTitle = (count: number): string => (count > 0 ? `(${count}) Mission Control` : 'Mission Control')

export function diffItems(before: readonly AttentionItem[], after: readonly AttentionItem[]): { raised: AttentionItem[]; resolved: string[] } {
  const was = new Set(before.map(item => item.key))
  const now = new Set(after.map(item => item.key))
  return { raised: after.filter(item => !was.has(item.key)), resolved: [...was].filter(key => !now.has(key)) }
}

export const shouldAlert = (state: { permission: string; enabled: boolean; visible: boolean; focused: boolean }): boolean =>
  state.permission === 'granted' && state.enabled && !(state.visible && state.focused)

export const dataOf = (item: AlertData): AlertData => ({ key: item.key, kind: item.kind, chatId: item.chatId, jobId: item.jobId, requestId: item.requestId })

export function alertFor(item: AttentionItem): { title: string; options: AlertOptions } {
  const body = item.kind === 'permission' && item.command !== null ? `Wants to run: ${item.command}` : item.detail
  return { title: item.title, options: { body, tag: item.key, renotify: false, icon: '/favicon.svg', data: dataOf(item), actions: ACTIONS[item.kind] } }
}

export const linkFor = (data: AlertData): string =>
  data.chatId !== null ? `/?chat=${encodeURIComponent(data.chatId)}` : data.jobId !== null ? `/?job=${encodeURIComponent(data.jobId)}` : '/'

export function requestFor(action: string, data: AlertData): { url: string; body: unknown; verb: string } | null {
  if (data.jobId === null) return null
  const job = encodeURIComponent(data.jobId)
  if ((action === 'allow' || action === 'deny') && data.requestId !== null) return { url: `/api/jobs/${job}/permission`, body: { requestId: data.requestId, decision: action === 'allow' ? 'allow_once' : 'deny' }, verb: action }
  if (action === 'stop') return { url: `/api/jobs/${job}/kill`, body: null, verb: 'stop the job' }
  return null
}

export function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`
}

export async function handleAlertClick(action: string, data: AlertData, deps: ClickDeps): Promise<void> {
  const request = requestFor(action, data)
  if (request !== null) {
    const response = await deps.post(request.url, request.body).catch(() => ({ ok: false, status: 0 }))
    if (response.ok || response.status === 409) return
    await deps.show(`Couldn't ${request.verb} · Open the chat`, { body: 'Answer it in Mission Control instead.', tag: `${data.key}:failed`, renotify: false, icon: '/favicon.svg', data, actions: [] })
    return
  }
  const link = linkFor(data)
  const [tab] = await deps.windows()
  if (tab === undefined) { await deps.open(link); return }
  await tab.focus()
  tab.postMessage({ type: 'mc:open', link })
}
```

- [ ] **Step 4: Run.** `bun test test/attention-core.test.ts`. Expected: all pass.
- [ ] **Step 5: Commit.** `git add client/attention-core.ts test/attention-core.test.ts tsconfig.shell.json && git commit -m "feat(attention): alert and click rules for the cockpit"`

### Task 5: Service worker, favicon and page head

**Files:**
- Create: `client/sw.ts`, `public/favicon.svg` (copy `../visualizer/notifications/favicon.svg`)
- Modify: `server/index.ts` (add `GET /sw.js`), `server/views/shell.ts:181` (favicon link) and the script list (add `<script src="/js/attention.js" type="module" defer></script>` after `access.js`)
- Test: add to `test/attention-routes.test.ts`, one test that `createApp()` serves `/sw.js` as JavaScript. Mirror the style of the existing `/js/:file` tests in `test/transpile.test.ts`: call `transpileClientModule('sw.js')` and expect it to contain `notificationclick`.

**Interfaces:**
- Consumes: `handleAlertClick`, `type AlertOptions` (Task 4).
- Produces: `/sw.js` served with `content-type: text/javascript`; the service worker posts `{ type: 'mc:open', link }` to an open tab.

- [ ] **Step 1: Write the failing test**

```ts
import { transpileClientModule } from '../server/index'

test('the service worker bundles with its click handler', async () => {
  const code = await transpileClientModule('sw.js')
  expect(code).toContain('notificationclick')
  expect(code).toContain('mc:open')
})
```

- [ ] **Step 2: Run.** Expected: FAIL (`code` is null).
- [ ] **Step 3: Implement `client/sw.ts`**

```ts
import { handleAlertClick, type AlertData, type AlertOptions } from './attention-core'

type WindowClient = { focus(): Promise<unknown>; postMessage(message: unknown): void }
type ClickEvent = { action: string; notification: { data: AlertData; close(): void }; waitUntil(promise: Promise<unknown>): void }
type Scope = {
  addEventListener(type: 'notificationclick', listener: (event: ClickEvent) => void): void
  addEventListener(type: 'install' | 'activate', listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void): void
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void>; matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>; openWindow(url: string): Promise<unknown> }
  registration: { showNotification(title: string, options: AlertOptions): Promise<void> }
}

const scope = self as unknown as Scope

scope.addEventListener('install', event => { event.waitUntil(scope.skipWaiting()) })
scope.addEventListener('activate', event => { event.waitUntil(scope.clients.claim()) })
scope.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(handleAlertClick(event.action, event.notification.data, {
    post: (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === null ? undefined : JSON.stringify(body) }),
    windows: () => scope.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    open: url => scope.clients.openWindow(url),
    show: (title, options) => scope.registration.showNotification(title, options),
  }))
})
```

- [ ] **Step 4: Serve it.** In `server/index.ts`, next to the `/js/:file` route:

```ts
    .get('/sw.js', async ({ set }) => {
      const code = await transpileClientModule('sw.js')
      if (code === null) { set.status = 404; return { error: 'not found' } }
      return new Response(code, { headers: JS_HEADERS })
    })
```

- [ ] **Step 5: Favicon and head.** Copy the favicon: `cp ../../../visualizer/notifications/favicon.svg public/favicon.svg`. In `server/views/shell.ts:181`, replace `<link rel="icon" href="data:,">` with `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`. Add the `attention.js` script tag. Then run `grep -rn 'data:,' test` and update any view test that pinned the old icon.
- [ ] **Step 6: Run.** `bun test test/attention-routes.test.ts test/views.test.ts test/shell.test.ts`. Expected: all pass.
- [ ] **Step 7: Commit.** `git add client/sw.ts public/favicon.svg server/index.ts server/views/shell.ts test && git commit -m "feat(attention): service worker for alert clicks and a real favicon"`

### Task 6: Bell and "Waiting on you" panel

**Files:**
- Modify:
  - `server/views/shell.ts`: add `<symbol id="bell-icon">` next to `agents-icon` (line 11);
  - `server/views/shell.ts`: add the bell button after `#open-agents` (line 63);
  - `server/views/shell.ts`: add the panel `<section id="attention">` just before the closing `</main>`.
- Modify: `public/quiet.css` (append the `.nt-*` rules from `../visualizer/notifications/notif.css`, excluding `.nt-new`, `.nt-tag`, `.nt-island*`, `.viz-*` and the `body[data-nt=…]` state rules. The panel is `position: fixed; top: 72px; right: 20px;` with `[hidden] { display: none }`.)
- Create: `client/attention.ts`
- Test: `test/attention-dom.test.ts` (jsdom, FakeSource; pattern from `test/flow-drawer-dom.test.ts:1-30`)

**Markup:**

```html
<symbol id="bell-icon" viewBox="0 0 20 20"><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z"/><path d="M8.5 17a1.6 1.6 0 0 0 3 0"/></symbol>
```

```html
<button id="open-attention" class="round quiet-control nt-bell" type="button" aria-expanded="false" aria-controls="attention" aria-label="Waiting on you" title="Waiting on you"><svg><use href="#bell-icon"/></svg><span id="attention-count" class="count" hidden></span></button>
```

```html
<section id="attention" class="nt-panel" aria-label="Waiting on you" hidden>
  <header class="nt-head"><h2>Waiting on you</h2><span class="nt-n" id="attention-n"></span></header>
  <div class="nt-off" id="attention-off" hidden><span class="nt-ico"><svg><use href="#bell-icon"/></svg></span><div><strong id="attention-off-title">Mac alerts are off</strong><span id="attention-off-text">Get an alert with buttons when something needs you, even with this tab hidden.</span></div><button class="pill" type="button" id="attention-on">Turn on</button></div>
  <div class="nt-list" id="attention-list"></div>
  <div class="nt-empty" id="attention-empty"><span class="nt-ico"><svg><use href="#check-icon"/></svg></span><strong>Nothing is waiting on you</strong><span>When a chat needs an answer, it shows up here and as a Mac alert.</span></div>
  <footer class="nt-foot" id="attention-foot" hidden><span>Mac alerts on · quiet while you're here</span><button class="text-button" type="button" id="attention-mute">Turn off</button></footer>
</section>
```

**Interfaces:**
- Consumes:
  - from Task 4: `tabTitle`, `diffItems`, `shouldAlert`, `alertFor`, `requestFor`, `linkFor`, `ageText`, `type AttentionItem`;
  - `/api/attention/stream`;
  - `POST /api/attention/:key/dismiss`.
- Events it emits:
  - `quiet:open-chat` (detail: chat id; `client/chat.ts:644`);
  - `quiet:show` (detail: `'conversation'`);
  - `quiet:agent-open` (detail: `{ jobId }`; `client/shell.ts:47`).
- Produces:
  - DOM behavior;
  - `localStorage['mc.alerts']` (`'off'` mutes);
  - handles `?job=<id>` on load and `mc:open` messages from the service worker.

**Behavior:**
- **Stream:** `new EventSource('/api/attention/stream')`. `onmessage` parses `{ items }`. The first message only primes the list (no alerts). Later messages diff against the previous list:
  - `raised` → if `shouldAlert({ permission: Notification.permission, enabled: muted() === false, visible: document.visibilityState === 'visible', focused: document.hasFocus() })`, call `(await navigator.serviceWorker.ready).showNotification(title, options)`;
  - `resolved` → `(await registration.getNotifications({ tag })).forEach(n => n.close())`;
  - then render.
- **Render:**
  - count badge: text = count, hidden when 0;
  - `document.title = tabTitle(count)`;
  - `#attention-n` = count, hidden when 0;
  - list items newest first, markup as in `a.html` (`article.nt-item[data-k]`);
  - the empty block is shown only when the list is empty;
  - the alerts-off banner shows when `Notification.permission !== 'granted'` or muted. When permission is `denied`, the title is "Mac alerts are blocked", the text is "Allow notifications for this site in your browser's settings.", and the Turn on button is hidden;
  - the footer shows when granted and not muted, and there are items.
- **Actions:** buttons carry `data-act`:
  - `allow` / `deny` / `stop` go through `requestFor(act, item)` + `fetch` POST;
  - `open` closes the panel, then dispatches `quiet:show` `'conversation'` and `quiet:open-chat` with `item.chatId` when there is one, else `quiet:agent-open` `{ jobId }`;
  - `dismiss` (× on needs and loop items) POSTs `/api/attention/${encodeURIComponent(key)}/dismiss`.
  - While a request runs, that item's buttons are disabled. On a non-ok, non-409 response, append `<p class="nt-fail">` "Couldn't {verb}: {server error or 'try again'}".
  - Add `.nt-fail { grid-column: 2; margin: 0; font-size: 12px; color: var(--danger); }` to quiet.css.
- **Bell:** toggles `hidden` and `aria-expanded`. Escape or a click outside the panel and the bell closes it.
- **Turn on:** `await Notification.requestPermission()`, then `localStorage.removeItem('mc.alerts')`, then render. **Turn off** sets `'off'`. Wrap `localStorage` in try/catch.
- **Load:** if `'serviceWorker' in navigator`, call `navigator.serviceWorker.register('/sw.js')`, and on its `message` with `type === 'mc:open'` apply the link in place:
  - parse `chat` / `job` from the link, then dispatch the same events as `open`;
  - on load, if `?job=` is present, dispatch `quiet:agent-open` for it.

- [ ] **Step 1: Write the failing DOM test** (`test/attention-dom.test.ts`). Use jsdom with the markup above plus a `#open-agents` stub.
  - Stub `EventSource` with a FakeSource class (`send(items)` calls `onmessage`), stub `fetch` to record calls, and stub a `Notification` object with a settable `permission` and `requestPermission`.
  - Stub `navigator.serviceWorker = { ready: Promise.resolve(registration), register: async () => registration, addEventListener() {} }`, where `registration.showNotification` and `getNotifications` record calls.
  - Import `../client/attention`. Then pin:
    - (a) the first `send([perm, loop])` sets the badge to `2` and the title to `(2) Mission Control`, and calls `showNotification` 0 times;
    - (b) with permission `granted`, `document.hasFocus = () => false` and `send([perm, loop, needs])`, `showNotification` is called once with title `Login fix` and tag `needs:c1`;
    - (c) `send([loop, needs])` calls `getNotifications` with `{ tag: 'perm:j1:r1' }`;
    - (d) clicking the bell unhides the panel, and clicking `[data-act="allow"]` POSTs `/api/jobs/j1/permission` with body `{ requestId: 'r1', decision: 'allow_once' }`;
    - (e) a 500 response adds `.nt-fail` text beginning with `Couldn't allow`;
    - (f) `send([])` shows `#attention-empty`, hides the badge, and sets the title to `Mission Control`;
    - (g) with permission `default`, `#attention-off` is visible, and clicking `#attention-on` calls `requestPermission`.
- [ ] **Step 2: Run.** `bun test test/attention-dom.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `client/attention.ts`** per the behavior above. Keep each function under 40 lines: `render()`, `itemView(item)`, `act(item, act)`, `onSnapshot(items)`, `alert(raised)`, `closeAlerts(keys)`, `openTarget({ chatId, jobId })`, `muted()`. Add `client/attention.ts` to `tsconfig.shell.json`.
- [ ] **Step 4: CSS.** Append the `.nt-*` rules to `public/quiet.css`.
- [ ] **Step 5: Run.** `bun test test/attention-dom.test.ts test/shell-typecheck.test.ts test/views.test.ts`. Expected: all pass.
- [ ] **Step 6: Commit.** `git add client/attention.ts public/quiet.css server/views/shell.ts tsconfig.shell.json test/attention-dom.test.ts && git commit -m "feat(attention): bell and Waiting-on-you panel in the top bar"`

### Task 7: Full suite, browser check, land

- [ ] **Step 1: Full suite in the worktree.** `bun test 2>&1 | tail -5`. Expected: 0 fail. Then restore the skill link (Global Constraints).
- [ ] **Step 2: Throwaway server.**
  - Make a temp config dir: `mkdir -p /tmp/mc-attn-check`.
  - Seed it: `printf '%s' '{"items":[{"key":"needs:seed","kind":"needs","title":"what'"'"'s hermez reaper job?","detail":"Needs you: the reply stopped with an error","command":null,"chatId":"seed","jobId":null,"requestId":null,"createdAt":0}]}' > /tmp/mc-attn-check/attention.json`.
  - Probe the port: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7791/api/health` must print `000`.
  - Start in the background from the worktree: `MISSION_CONTROL_PORT=7791 MISSION_CONTROL_CONFIG_DIR=/tmp/mc-attn-check bun server/index.ts`.
- [ ] **Step 3: Browser check (Playwright MCP) at `http://127.0.0.1:7791/`.**
  - The tab title is `(1) Mission Control` and the favicon is the purple spark.
  - The bell shows `1`. Clicking it opens the panel. Take a screenshot and compare it side by side with `http://localhost:5791/a.html` (restart the mockup server if needed).
  - The × on the seeded item clears it: the badge disappears, the empty state shows, and `/tmp/mc-attn-check/attention.json` now has `"items": []`.
  - Use `page.route('**/api/attention/stream', …)` to serve a crafted snapshot with one permission, one loop and one needs item. Check that all three render as mocked and that Allow once POSTs `allow_once` (`page.route` on `**/api/jobs/**/permission` records the body).
  - With `context.grantPermissions(['notifications'])` and `registration.showNotification` wrapped via `page.evaluate` to record calls, emit a second snapshot while `document.hasFocus` is stubbed false. The call carries `tag` and `actions`.
- [ ] **Step 4: Stop the throwaway server by its PID only** (never `pkill`), `rm -rf /tmp/mc-attn-check`, and restore the skill link.
- [ ] **Step 5: Land.**
  - `cd /Users/lynchz/Desktop/kingpinggroup/mission-control && git fetch origin && git status --short`: only the known foreign files may show.
  - `git cherry-pick <task commits in order>`, then `bun test 2>&1 | tail -5`. Expected: 0 fail.
  - Restore the skill link.
  - Do not push; report and ask.
- [ ] **Step 6: Manual Arc check, reported to the user.** After they restart the live cockpit, trigger a real alert and confirm whether Arc shows the Options buttons.
