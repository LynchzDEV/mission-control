# Card Queue 1a — Queue Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless, generic work queue in Mission Control: items from a source plugin are built one at a time as Studio runs in their own worktrees; a run that ends blocked with questions posts them to the source and parks the item until replies arrive; driven by `/api/queue` and `mctl queue`.

**Architecture:** A persisted queue store (`queue-store.ts`), a source contract with a plugin-backed adapter (`queue-source.ts`), pure prompt/result helpers (`queue-prompts.ts`), and an event-driven engine (`queue-engine.ts`) that reacts to "item added", "run settled", "replies checked" and restart recovery. All engine state changes run through one serial lane so only one item is ever building. Routes and CLI are thin.

**Tech Stack:** Bun 1.4, TypeScript, Elysia, zod, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-05-card-queue-design.md` (phase 1). This plan is 1a of three: 1a engine (this), 1b ClickUp plugin implements the source contract, 1c Queue screen (sidebar placement D, List + Git tree) and the `queue` attention kind.

## Global Constraints

- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- Commits on `main`, one per task, conventional format (`feat(queue): …`). No `Co-Authored-By` trailers. Never `git merge`. Do not push.
- Only stage the files the task names. Other sessions edit this checkout: never `git add -A` / `git add .`; `skills/mc-dispatch/SKILL.md` is someone else's change, never stage it.
- Never kill or restart the cockpit on :7777; never `pkill`. Do not start servers.
- Tests: `bun test <file>`; the whole suite with `bun test` must stay green.
- Files stay under 400 lines; functions under 50 lines; no `any`; no emoji in code or copy.
- Phase 1a has no preview, no requester approval loop and no landing: a passed run makes the item `ready`.
- Agents never talk to the source: MC writes context files into the worktree and posts on the agent's behalf (spec decision 6).

## Review Focus

1. A run that settles while `runner.start` is still returning (instant failure) must not leave its item stuck in `building` — Task 4 test "a run that settles before start returns still settles its item".
2. Server restart while an item is building — Task 4 test "recover settles an item whose run finished while MC was down" and "recover fails an item whose run is gone".
3. Two adds in the same tick must still build only one item — Task 4 test "two adds at once build only the first".
4. The source throwing during a reply check must not crash the sweep or lose the item; after 3 failures in a row the user is told — Task 5 test "a failing source keeps the item waiting and asks for you after three failures".
5. A reply image path that escapes the plugin's data folder (`../../.ssh/id_rsa`) must never be copied — Task 5 test "images outside the plugin data folder are skipped".

---

## File Structure

| File | Responsibility |
|---|---|
| `server/queue-store.ts` (create) | `QueueItem` type, ordered persisted list, change events |
| `server/queue-source.ts` (create) | `QueueSource` contract, zod parsing of plugin results, `pluginSource()` adapter over the plugin runtimes |
| `server/queue-prompts.ts` (create) | Pure: run request text, questions from a settled run, answers markdown, branch label |
| `server/queue-engine.ts` (create) | Serial lane; add / startNext / settle / recover / checkReplies / image import |
| `server/routes/queue.ts` (create) | `/api/queue` HTTP surface |
| `server/index.ts` (modify) | Build store + engine, hook `onRunSettled`, recover at boot, 15-min reply sweep, mount routes |
| `cli/commands/queue.ts` (create), `cli/mctl.ts` (modify) | `mctl queue …` |
| Tests | `test/queue-store.test.ts`, `test/queue-source.test.ts`, `test/queue-prompts.test.ts`, `test/queue-engine.test.ts`, `test/queue-replies.test.ts`, `test/queue-routes.test.ts`, `test/cli-queue.test.ts` |

## Source contract (spec delta)

The spec listed `source.templates()`. 1a folds wording into the source: the engine sends the *kind* and the *lines*, the source writes the comment in its own language with its own marker. Contract used by every task:

```ts
source.item({ id })                         → { title, url, contextMarkdown }
source.post({ id, kind: 'ask', lines })     → { commentId }
source.replies({ id, sinceId })             → { replies: [{ id, author, text, images: [{ name, path }] }], lastId }
```

`images[].path` is relative to the plugin's data folder (`<configDir>/plugin-data/<pluginId>/files`). The host copies images into the item worktree.

---

### Task 1: Queue store

**Files:**
- Create: `server/queue-store.ts`
- Test: `test/queue-store.test.ts`

**Interfaces:**
- Consumes: `atomicJson` from `server/workflows.ts`, `configDir` from `server/secrets.ts`, `RunEvents` from `server/run-events.ts`.
- Produces:
  ```ts
  export type QueueState = 'queued' | 'building' | 'waiting-info' | 'ready' | 'failed'
  export type QueueItem = { id: string; source: string; externalId: string; title: string; url: string; repo: string; flowId: string | null; state: QueueState; worktree: string | null; contextPath: string | null; answerPaths: string[]; runIds: string[]; currentRunId: string | null; questions: string[]; lastSeenId: string | null; error: string | null; createdAt: number; updatedAt: number }
  export type NewQueueItem = Pick<QueueItem, 'source' | 'externalId' | 'title' | 'url' | 'repo' | 'flowId'>
  export type QueuePatch = Partial<Omit<QueueItem, 'id' | 'createdAt' | 'updatedAt'>>
  export type QueueStore = RunEvents & { list(): QueueItem[]; get(id: string): QueueItem | undefined; add(item: NewQueueItem, position: 'end' | 'next'): Promise<QueueItem>; update(id: string, patch: QueuePatch): Promise<QueueItem>; remove(id: string): Promise<boolean>; move(id: string, to: number): Promise<boolean>; toFront(id: string): Promise<void> }
  export const QUEUE_FILE = 'queue.json'
  export function queuePath(): string
  export function createQueueStore(path: string, clock?: () => number): QueueStore
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueStore, type NewQueueItem } from '../server/queue-store'

let dir: string
let path: string
const item = (externalId: string): NewQueueItem => ({ source: 'clickup-board', externalId, title: `Task ${externalId}`, url: `https://app.clickup.com/t/${externalId}`, repo: '/repo', flowId: null })

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-')); path = join(dir, 'nested', 'queue.json') })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('a missing file is an empty queue', () => {
  expect(createQueueStore(path).list()).toEqual([])
})

test('added items start queued, keep order, and survive a new instance', async () => {
  const store = createQueueStore(path, () => 1000)
  const a = await store.add(item('a'), 'end')
  await store.add(item('b'), 'end')
  expect(a).toMatchObject({ state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: 1000, updatedAt: 1000 })
  expect(createQueueStore(path).list().map(entry => entry.externalId)).toEqual(['a', 'b'])
})

test('next puts the item first', async () => {
  const store = createQueueStore(path)
  await store.add(item('a'), 'end')
  await store.add(item('b'), 'next')
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'a'])
})

test('update patches fields and bumps updatedAt; unknown ids throw', async () => {
  let now = 1
  const store = createQueueStore(path, () => now)
  const a = await store.add(item('a'), 'end')
  now = 5
  const updated = await store.update(a.id, { state: 'building', currentRunId: 'run-1' })
  expect(updated).toMatchObject({ state: 'building', currentRunId: 'run-1', createdAt: 1, updatedAt: 5 })
  expect(store.update('nope', { state: 'failed' })).rejects.toThrow('No queue item nope')
})

test('move and toFront reorder; remove deletes', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  const b = await store.add(item('b'), 'end')
  const c = await store.add(item('c'), 'end')
  expect(await store.move(c.id, 0)).toBe(true)
  expect(store.list().map(entry => entry.externalId)).toEqual(['c', 'a', 'b'])
  await store.toFront(b.id)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'c', 'a'])
  expect(await store.move('nope', 0)).toBe(false)
  expect(await store.remove(a.id)).toBe(true)
  expect(await store.remove(a.id)).toBe(false)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'c'])
})

test('move clamps the target index into range', async () => {
  const store = createQueueStore(path)
  const a = await store.add(item('a'), 'end')
  await store.add(item('b'), 'end')
  await store.move(a.id, 99)
  expect(store.list().map(entry => entry.externalId)).toEqual(['b', 'a'])
})

test('every change notifies subscribers', async () => {
  const store = createQueueStore(path)
  let calls = 0
  store.subscribe(() => { calls += 1 })
  const a = await store.add(item('a'), 'end')
  await store.update(a.id, { state: 'failed' })
  await store.remove(a.id)
  expect(calls).toBe(3)
})

test('a corrupt file or malformed entries load as empty instead of crashing', async () => {
  await rm(dir, { recursive: true, force: true })
  await mkdtemp(dir).catch(() => {})
  await Bun.write(path, '{not json')
  expect(createQueueStore(path).list()).toEqual([])
  await writeFile(path, JSON.stringify({ items: [{ id: 'x' }] }))
  expect(createQueueStore(path).list()).toEqual([])
})

test('the file is written as { items }', async () => {
  const store = createQueueStore(path)
  await store.add(item('a'), 'end')
  expect(JSON.parse(await readFile(path, 'utf8')).items).toHaveLength(1)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/queue-store.test.ts`
Expected: FAIL, `Cannot find module '../server/queue-store'`.

- [ ] **Step 3: Implement**

```ts
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { RunEvents } from './run-events'
import { configDir } from './secrets'
import { atomicJson } from './workflows'

export const QUEUE_FILE = 'queue.json'

export type QueueState = 'queued' | 'building' | 'waiting-info' | 'ready' | 'failed'

export type QueueItem = {
  id: string; source: string; externalId: string; title: string; url: string; repo: string; flowId: string | null
  state: QueueState; worktree: string | null; contextPath: string | null; answerPaths: string[]
  runIds: string[]; currentRunId: string | null; questions: string[]; lastSeenId: string | null; error: string | null
  createdAt: number; updatedAt: number
}

export type NewQueueItem = Pick<QueueItem, 'source' | 'externalId' | 'title' | 'url' | 'repo' | 'flowId'>
export type QueuePatch = Partial<Omit<QueueItem, 'id' | 'createdAt' | 'updatedAt'>>

export type QueueStore = RunEvents & {
  list(): QueueItem[]
  get(id: string): QueueItem | undefined
  add(item: NewQueueItem, position: 'end' | 'next'): Promise<QueueItem>
  update(id: string, patch: QueuePatch): Promise<QueueItem>
  remove(id: string): Promise<boolean>
  move(id: string, to: number): Promise<boolean>
  toFront(id: string): Promise<void>
}

const STATES = new Set<string>(['queued', 'building', 'waiting-info', 'ready', 'failed'])
const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string'
const isTexts = (value: unknown): boolean => Array.isArray(value) && value.every(isText)

function isItem(value: unknown): value is QueueItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return [item.id, item.source, item.externalId, item.title, item.url, item.repo].every(isText)
    && STATES.has(item.state as string)
    && [item.flowId, item.worktree, item.contextPath, item.currentRunId, item.lastSeenId, item.error].every(isTextOrNull)
    && isTexts(item.answerPaths) && isTexts(item.runIds) && isTexts(item.questions)
    && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
}

function load(path: string): QueueItem[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown }
    return Array.isArray(parsed.items) ? parsed.items.filter(isItem) : []
  } catch {
    return []
  }
}

export function queuePath(): string {
  return join(configDir(), QUEUE_FILE)
}

export function createQueueStore(path: string, clock: () => number = Date.now): QueueStore {
  let items = load(path)
  let writes: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) listener() }

  const save = (next: QueueItem[]): Promise<void> => {
    items = next
    changed()
    const snapshot = { items }
    const write = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await atomicJson(path, snapshot)
    })
    writes = write.catch(error => console.error('queue write failed', error))
    return write
  }

  const reorder = (id: string, to: number): QueueItem[] | null => {
    const from = items.findIndex(item => item.id === id)
    if (from === -1) return null
    const rest = items.filter(item => item.id !== id)
    const at = Math.max(0, Math.min(to, rest.length))
    return [...rest.slice(0, at), items[from]!, ...rest.slice(at)]
  }

  return {
    changed,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    list: () => items,
    get: id => items.find(item => item.id === id),
    async add(input, position) {
      const now = clock()
      const item: QueueItem = { ...input, id: crypto.randomUUID(), state: 'queued', worktree: null, contextPath: null, answerPaths: [], runIds: [], currentRunId: null, questions: [], lastSeenId: null, error: null, createdAt: now, updatedAt: now }
      await save(position === 'next' ? [item, ...items] : [...items, item])
      return item
    },
    async update(id, patch) {
      const current = items.find(item => item.id === id)
      if (current === undefined) throw new Error(`No queue item ${id}`)
      const next: QueueItem = { ...current, ...patch, updatedAt: clock() }
      await save(items.map(item => (item.id === id ? next : item)))
      return next
    },
    async remove(id) {
      const rest = items.filter(item => item.id !== id)
      if (rest.length === items.length) return false
      await save(rest)
      return true
    },
    async move(id, to) {
      const next = reorder(id, to)
      if (next === null) return false
      await save(next)
      return true
    },
    async toFront(id) {
      const next = reorder(id, 0)
      if (next !== null) await save(next)
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/queue-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/queue-store.ts test/queue-store.test.ts
git commit -m "feat(queue): persisted, ordered queue store"
```

---

### Task 2: Source contract and plugin adapter

**Files:**
- Create: `server/queue-source.ts`
- Test: `test/queue-source.test.ts`

**Interfaces:**
- Consumes: `getInstalled` + `InstalledPlugin` from `server/plugins/store.ts`; `Runtimes` from `server/plugins/runtimes.ts`; `CallOutcome` from `server/plugins/runtime-trusted.ts`.
- Produces:
  ```ts
  export type SourceItem = { title: string; url: string; contextMarkdown: string }
  export type SourceImage = { name: string; path: string }
  export type SourceReply = { id: string; author: string; text: string; images: SourceImage[] }
  export type SourceReplies = { replies: SourceReply[]; lastId: string | null }
  export type QueueSource = {
    item(input: { id: string }): Promise<SourceItem>
    post(input: { id: string; kind: 'ask'; lines: string[] }): Promise<{ commentId: string }>
    replies(input: { id: string; sinceId: string | null }): Promise<SourceReplies>
  }
  export type SourceDeps = { installed(id: string): Promise<InstalledPlugin | null>; runtimes(): Promise<Pick<Runtimes, 'getRuntime'>> }
  export function pluginSource(pluginId: string, deps: SourceDeps): QueueSource
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'

import type { InstalledPlugin } from '../server/plugins/store'
import { pluginSource, type SourceDeps } from '../server/queue-source'

type Call = { method: string; params: unknown }

function deps(answer: (call: Call) => unknown, options: { installed?: Partial<InstalledPlugin> | null; runtimeError?: string } = {}): { deps: SourceDeps; calls: Call[] } {
  const calls: Call[] = []
  const installed = options.installed === null ? null : ({ id: 'clickup-board', enabled: true, ...options.installed } as InstalledPlugin)
  return {
    calls,
    deps: {
      installed: async () => installed,
      runtimes: async () => ({
        getRuntime: async () => options.runtimeError
          ? { ok: false, status: 503, error: options.runtimeError }
          : { ok: true, runtime: { call: async (method: string, params: unknown) => { calls.push({ method, params }); const result = answer({ method, params }); return result instanceof Error ? { ok: false, status: 500, error: result.message } : { ok: true, result } }, dispose: async () => {} } as never },
      }),
    },
  }
}

test('item calls source.item and returns the parsed item', async () => {
  const { deps: d, calls } = deps(() => ({ title: 'Login copy', url: 'https://x/t/1', contextMarkdown: '# task' }))
  expect(await pluginSource('clickup-board', d).item({ id: '1' })).toEqual({ title: 'Login copy', url: 'https://x/t/1', contextMarkdown: '# task' })
  expect(calls).toEqual([{ method: 'source.item', params: { id: '1' } }])
})

test('post sends kind and lines and returns the comment id', async () => {
  const { deps: d, calls } = deps(() => ({ commentId: 'c9' }))
  expect(await pluginSource('clickup-board', d).post({ id: '1', kind: 'ask', lines: ['Which page?'] })).toEqual({ commentId: 'c9' })
  expect(calls[0]).toEqual({ method: 'source.post', params: { id: '1', kind: 'ask', lines: ['Which page?'] } })
})

test('replies parses replies and images', async () => {
  const { deps: d } = deps(() => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' }))
  expect(await pluginSource('clickup-board', d).replies({ id: '1', sinceId: 'c9' })).toEqual({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' })
})

test('a malformed plugin answer is rejected, not trusted', async () => {
  const { deps: d } = deps(() => ({ title: 3 }))
  await expect(pluginSource('clickup-board', d).item({ id: '1' })).rejects.toThrow('clickup-board returned an unexpected source.item result')
})

test('missing, disabled, unstartable or failing plugins throw readable errors', async () => {
  await expect(pluginSource('clickup-board', deps(() => ({}), { installed: null }).deps).item({ id: '1' })).rejects.toThrow('clickup-board is not installed')
  await expect(pluginSource('clickup-board', deps(() => ({}), { installed: { enabled: false } }).deps).item({ id: '1' })).rejects.toThrow('clickup-board is turned off')
  await expect(pluginSource('clickup-board', deps(() => ({}), { runtimeError: 'needs a newer Bun' }).deps).item({ id: '1' })).rejects.toThrow('needs a newer Bun')
  await expect(pluginSource('clickup-board', deps(() => new Error('No method source.item')).deps).item({ id: '1' })).rejects.toThrow('No method source.item')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/queue-source.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod'

import type { Runtimes } from './plugins/runtimes'
import type { InstalledPlugin } from './plugins/store'

export type SourceItem = { title: string; url: string; contextMarkdown: string }
export type SourceImage = { name: string; path: string }
export type SourceReply = { id: string; author: string; text: string; images: SourceImage[] }
export type SourceReplies = { replies: SourceReply[]; lastId: string | null }

export type QueueSource = {
  item(input: { id: string }): Promise<SourceItem>
  post(input: { id: string; kind: 'ask'; lines: string[] }): Promise<{ commentId: string }>
  replies(input: { id: string; sinceId: string | null }): Promise<SourceReplies>
}

export type SourceDeps = {
  installed(id: string): Promise<InstalledPlugin | null>
  runtimes(): Promise<Pick<Runtimes, 'getRuntime'>>
}

const text = z.string().max(64000)
const itemSchema = z.object({ title: z.string().min(1).max(500), url: z.string().max(2048), contextMarkdown: z.string().max(524288) })
const postSchema = z.object({ commentId: z.string().min(1).max(200) })
const imageSchema = z.object({ name: z.string().min(1).max(200), path: z.string().min(1).max(1024) })
const repliesSchema = z.object({
  replies: z.array(z.object({ id: z.string().min(1).max(200), author: z.string().max(200), text, images: z.array(imageSchema).max(8) })).max(100),
  lastId: z.string().min(1).max(200).nullable(),
})

export function pluginSource(pluginId: string, deps: SourceDeps): QueueSource {
  async function call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const installed = await deps.installed(pluginId)
    if (installed === null) throw new Error(`${pluginId} is not installed`)
    if (!installed.enabled) throw new Error(`${pluginId} is turned off`)
    const runtime = await (await deps.runtimes()).getRuntime(installed)
    if (!runtime.ok) throw new Error(runtime.error)
    const outcome = await runtime.runtime.call(method, params)
    if (!outcome.ok) throw new Error(outcome.error)
    const parsed = schema.safeParse(outcome.result)
    if (!parsed.success) throw new Error(`${pluginId} returned an unexpected ${method} result`)
    return parsed.data
  }
  return {
    item: input => call('source.item', input, itemSchema),
    post: input => call('source.post', input, postSchema),
    replies: input => call('source.replies', input, repliesSchema),
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/queue-source.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/queue-source.ts test/queue-source.test.ts
git commit -m "feat(queue): source contract with a validated plugin adapter"
```

---

### Task 3: Prompt and result helpers

**Files:**
- Create: `server/queue-prompts.ts`
- Test: `test/queue-prompts.test.ts`

**Interfaces:**
- Consumes: `QueueItem` (Task 1), `SourceReply` (Task 2), `WorkflowRun`/`WorkflowAttempt` types from `server/workflow-runner.ts`.
- Produces:
  ```ts
  export type RunView = Pick<WorkflowRun, 'id' | 'status' | 'error' | 'attempts'>
  export const SETTLED: ReadonlySet<WorkflowRun['status']>   // done, failed, blocked, stopped
  export function branchLabel(item: Pick<QueueItem, 'title' | 'externalId'>): string
  export function runRequest(item: Pick<QueueItem, 'title' | 'url' | 'contextPath' | 'answerPaths'>): string
  export function questionsOf(run: RunView): string[]
  export function answersMarkdown(questions: string[], replies: SourceReply[], images: string[]): string
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'

import { answersMarkdown, branchLabel, questionsOf, runRequest, SETTLED, type RunView } from '../server/queue-prompts'
import type { WorkflowAttempt } from '../server/workflow-runner'

const attempt = (over: Partial<WorkflowAttempt>): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: null, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [], ...over })
const run = (status: RunView['status'], attempts: WorkflowAttempt[]): RunView => ({ id: 'r1', status, error: null, attempts })

test('SETTLED holds the four end states', () => {
  expect([...SETTLED].sort()).toEqual(['blocked', 'done', 'failed', 'stopped'])
})

test('branchLabel is queue- plus a short slug of the title and the id', () => {
  expect(branchLabel({ title: 'Login page copy (TH)!', externalId: '86d3j4f8q' })).toBe('queue-login-page-copy-th-86d3j4f8q')
  expect(branchLabel({ title: 'ภาษาไทย', externalId: 'abc' })).toBe('queue-abc')
  expect(branchLabel({ title: 'x'.repeat(80), externalId: 'id' }).length).toBeLessThanOrEqual(60)
})

test('runRequest points at the context, lists answers, and explains how to ask', () => {
  const text = runRequest({ title: 'Login copy', url: 'https://x/t/1', contextPath: '/wt/.mission-control/context/clickup-board/item.md', answerPaths: ['/wt/a1.md'] })
  expect(text).toContain('Work on "Login copy" (https://x/t/1).')
  expect(text).toContain('Read the task context in /wt/.mission-control/context/clickup-board/item.md.')
  expect(text).toContain('The requester answered your earlier questions: read /wt/a1.md.')
  expect(text).toContain('MC_RESULT blocked')
  expect(runRequest({ title: 'T', url: 'u', contextPath: '/c.md', answerPaths: [] })).not.toContain('answered')
})

test('questionsOf reads the evidence of the last settled blocked step', () => {
  const asked = run('blocked', [
    attempt({ nodeId: 'plan', number: 1, endedAt: 5, result: { outcome: 'fail', summary: 'x', evidence: ['old'] } }),
    attempt({ nodeId: 'plan', number: 2, endedAt: 9, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?', '  ', 'Thai or English?'] } }),
  ])
  expect(questionsOf(asked)).toEqual(['Which page?', 'Thai or English?'])
})

test('questionsOf is empty for a cap block, an interrupt, a pass or a run without results', () => {
  expect(questionsOf(run('blocked', [attempt({ result: { outcome: 'fail', summary: 'cap', evidence: ['e'] } })]))).toEqual([])
  expect(questionsOf(run('blocked', [attempt({ interrupted: true, result: { outcome: 'blocked', summary: 'Interrupted before it finished', evidence: ['x'] } })]))).toEqual([])
  expect(questionsOf(run('done', [attempt({ result: { outcome: 'pass', summary: 'ok', evidence: ['e'] } })]))).toEqual([])
  expect(questionsOf(run('failed', []))).toEqual([])
})

test('answersMarkdown pairs the questions with each reply and its images', () => {
  const md = answersMarkdown(['Which page?'], [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }, { id: 'r2', author: 'Ploy', text: 'See screenshot', images: [] }], ['/wt/ctx/shot.png'])
  expect(md).toBe('# Answers from the requester\n\n## Questions asked\n\n- Which page?\n\n## Replies\n\n### Ploy\n\nThe login page\n\n### Ploy\n\nSee screenshot\n\n## Images\n\n- /wt/ctx/shot.png\n')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/queue-prompts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { QueueItem } from './queue-store'
import type { SourceReply } from './queue-source'
import type { WorkflowRun } from './workflow-runner'

export type RunView = Pick<WorkflowRun, 'id' | 'status' | 'error' | 'attempts'>

export const SETTLED: ReadonlySet<WorkflowRun['status']> = new Set(['done', 'failed', 'blocked', 'stopped'])

const MAX_BRANCH = 60

export function branchLabel(item: Pick<QueueItem, 'title' | 'externalId'>): string {
  const id = item.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const room = MAX_BRANCH - 'queue-'.length - id.length - 1
  const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, Math.max(0, room)).replace(/-+$/, '')
  return slug ? `queue-${slug}-${id}` : `queue-${id}`
}

export function runRequest(item: Pick<QueueItem, 'title' | 'url' | 'contextPath' | 'answerPaths'>): string {
  return [
    `Work on "${item.title}" (${item.url}).`,
    `Read the task context in ${item.contextPath}.`,
    ...(item.answerPaths.length > 0 ? [`The requester answered your earlier questions: read ${item.answerPaths.join(', ')}.`] : []),
    'If information you need is missing and you cannot decide it yourself, end the step with MC_RESULT blocked and put each question for the requester as one evidence item.',
  ].join('\n')
}

export function questionsOf(run: RunView): string[] {
  const settled = run.attempts.filter(attempt => attempt.result !== null && attempt.endedAt !== null)
  const last = settled.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).at(-1)
  if (run.status !== 'blocked' || last === undefined || last.interrupted || last.result?.outcome !== 'blocked') return []
  return last.result.evidence.map(line => line.trim()).filter(line => line !== '')
}

export function answersMarkdown(questions: string[], replies: SourceReply[], images: string[]): string {
  const asked = questions.map(question => `- ${question}`).join('\n')
  const answered = replies.map(reply => `### ${reply.author}\n\n${reply.text}`).join('\n\n')
  const pictures = images.length > 0 ? `\n## Images\n\n${images.map(path => `- ${path}`).join('\n')}\n` : ''
  return `# Answers from the requester\n\n## Questions asked\n\n${asked}\n\n## Replies\n\n${answered}\n${pictures}`
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/queue-prompts.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/queue-prompts.ts test/queue-prompts.test.ts
git commit -m "feat(queue): run request, questions and answers helpers"
```

---

### Task 4: Engine — build one at a time, settle, recover

**Files:**
- Create: `server/queue-engine.ts`
- Test: `test/queue-engine.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `TaskContext` from `server/plugins/context-files.ts`.
- Produces (Task 5 adds `checkReplies`; Tasks 6–7 use the rest):
  ```ts
  export type QueueRunner = {
    start(input: { cwd: string; request: string; label: string; workflowId?: string }, context: { startedByUser: boolean }): Promise<{ id: string }>
    get(id: string): RunView | undefined
  }
  export type QueueEngineDeps = {
    store: QueueStore
    runner: QueueRunner
    source(pluginId: string): QueueSource
    prepareWorktree(repo: string, label: string): Promise<{ worktree: string }>
    writeContext(pluginId: string, context: TaskContext, cwd: string): Promise<string>
    pluginFiles(pluginId: string): string
    needsYou(item: QueueItem, reason: string): void
  }
  export type AddInput = { source: string; externalId: string; repo: string; flowId?: string | null; position?: 'end' | 'next' }
  export type QueueEngine = {
    add(input: AddInput): Promise<QueueItem>
    kick(): Promise<void>
    onRunSettled(run: RunView): Promise<void>
    recover(): Promise<void>
    requeue(id: string): Promise<QueueItem>
    checkReplies(): Promise<{ checked: number; resumed: number }>
  }
  export function createQueueEngine(deps: QueueEngineDeps): QueueEngine
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, type QueueEngineDeps, type QueueRunner } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource } from '../server/queue-source'
import { createQueueStore, type QueueItem } from '../server/queue-store'
import type { WorkflowAttempt } from '../server/workflow-runner'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-engine-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const blockedWith = (evidence: string[]): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 'Need info', evidence }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] })

function harness(over: Partial<QueueEngineDeps> = {}, sourceOver: Partial<QueueSource> = {}) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const started: Array<{ cwd: string; request: string; label: string; workflowId?: string }> = []
  const posted: Array<{ id: string; kind: string; lines: string[] }> = []
  const alerts: Array<{ title: string; reason: string }> = []
  let next = 0
  const runner: QueueRunner = {
    start: async input => { started.push(input); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } },
    get: id => runs.get(id),
  }
  const source: QueueSource = {
    item: async ({ id }) => ({ title: `Task ${id}`, url: `https://x/t/${id}`, contextMarkdown: `# ${id}` }),
    post: async input => { posted.push(input); return { commentId: 'c1' } },
    replies: async () => ({ replies: [], lastId: null }),
    ...sourceOver,
  }
  const deps: QueueEngineDeps = {
    store, runner,
    source: () => source,
    prepareWorktree: async (repo, label) => ({ worktree: join(repo, '.worktree', label) }),
    writeContext: async (pluginId, context, cwd) => join(cwd, '.mission-control', 'context', pluginId, `${context.name}.md`),
    pluginFiles: pluginId => join(dir, 'plugin-data', pluginId, 'files'),
    needsYou: (item, reason) => { alerts.push({ title: item.title, reason }) },
    ...over,
  }
  const settle = (id: string, run: Partial<RunView>) => { const done = { ...runs.get(id)!, ...run }; runs.set(id, done); return done }
  return { engine: createQueueEngine(deps), store, runs, started, posted, alerts, settle }
}

const add = { source: 'clickup-board', externalId: '1', repo: '/repo' }
const states = (items: QueueItem[]) => items.map(item => `${item.externalId}:${item.state}`)

test('adding an item fetches its title and starts building it in its own worktree', async () => {
  const h = harness()
  const item = await h.engine.add({ ...add, flowId: 'wf-1' })
  expect(item.title).toBe('Task 1')
  const built = h.store.get(item.id)!
  expect(built).toMatchObject({ state: 'building', currentRunId: 'run-1', runIds: ['run-1'], worktree: '/repo/.worktree/queue-task-1-1' })
  expect(built.contextPath).toBe('/repo/.worktree/queue-task-1-1/.mission-control/context/clickup-board/item-1.md')
  expect(h.started).toEqual([{ cwd: '/repo/.worktree/queue-task-1-1', request: expect.stringContaining('Work on "Task 1"'), label: 'Task 1', workflowId: 'wf-1' }])
})

test('two adds at once build only the first; the second waits queued', async () => {
  const h = harness()
  await Promise.all([h.engine.add(add), h.engine.add({ ...add, externalId: '2' })])
  expect(states(h.store.list())).toEqual(['1:building', '2:queued'])
  expect(h.started).toHaveLength(1)
})

test('a passed run makes the item ready, tells you, and starts the next', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'done' }))
  expect(states(h.store.list())).toEqual(['1:ready', '2:building'])
  expect(h.alerts).toEqual([{ title: 'Task 1', reason: 'Built and ready for review' }])
})

test('a run blocked with questions posts them, parks the item and frees the slot', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['Which page?'])] }))
  expect(h.posted).toEqual([{ id: '1', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.list()[0]).toMatchObject({ state: 'waiting-info', questions: ['Which page?'], lastSeenId: 'c1', currentRunId: null })
  expect(h.store.list()[1]!.state).toBe('building')
})

test('a blocked run without questions, a failed or a stopped run fails the item and tells you', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', error: 'Visit cap reached', attempts: [] }))
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Visit cap reached' })
  expect(h.alerts).toEqual([{ title: 'Task 1', reason: 'Visit cap reached' }])
})

test('posting the questions failing fails the item with the reason', async () => {
  const h = harness({}, { post: async () => { throw new Error('ClickUp is down') } })
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'blocked', attempts: [blockedWith(['Which page?'])] }))
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Could not post the questions: ClickUp is down' })
})

test('a settle for an unknown or already settled run changes nothing', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled({ id: 'other', status: 'done', error: null, attempts: [] })
  const done = h.settle('run-1', { status: 'done' })
  await h.engine.onRunSettled(done)
  await h.engine.onRunSettled(done)
  expect(h.alerts).toHaveLength(1)
})

test('a run that settles before start returns still settles its item', async () => {
  const h = harness()
  const instant: QueueRunner = { start: async () => { h.runs.set('run-x', { id: 'run-x', status: 'failed', error: 'No agent for plan', attempts: [] }); return { id: 'run-x' } }, get: id => h.runs.get(id) }
  const fast = harness({ runner: instant, store: h.store })
  await fast.engine.add(add)
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'No agent for plan' })
})

test('a start error fails that item and moves on to the next', async () => {
  let calls = 0
  const h = harness({ prepareWorktree: async (repo, label) => { calls += 1; if (calls === 1) throw new Error('not a git repo'); return { worktree: join(repo, '.worktree', label) } } })
  await h.engine.add(add)
  await h.engine.add({ ...add, externalId: '2' })
  expect(states(h.store.list())).toEqual(['1:failed', '2:building'])
  expect(h.store.list()[0]!.error).toBe('not a git repo')
})

test('requeue puts a failed item back at the end and builds it when free', async () => {
  const h = harness()
  await h.engine.add(add)
  await h.engine.onRunSettled(h.settle('run-1', { status: 'failed', error: 'boom' }))
  const again = await h.engine.requeue(h.store.list()[0]!.id)
  expect(again.state).toBe('building')
  expect(again.error).toBeNull()
  await expect(h.engine.requeue('nope')).rejects.toThrow('No queue item nope')
})

test('recover settles an item whose run finished while MC was down', async () => {
  const h = harness()
  await h.engine.add(add)
  h.settle('run-1', { status: 'done' })
  await h.engine.recover()
  expect(h.store.list()[0]!.state).toBe('ready')
})

test('recover fails an item whose run is gone', async () => {
  const h = harness()
  await h.engine.add(add)
  h.runs.delete('run-1')
  await h.engine.recover()
  expect(h.store.list()[0]).toMatchObject({ state: 'failed', error: 'Its run is gone' })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/queue-engine.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { TaskContext } from './plugins/context-files'
import { branchLabel, questionsOf, runRequest, SETTLED, type RunView } from './queue-prompts'
import type { QueueSource } from './queue-source'
import type { QueueItem, QueueStore } from './queue-store'

export type QueueRunner = {
  start(input: { cwd: string; request: string; label: string; workflowId?: string }, context: { startedByUser: boolean }): Promise<{ id: string }>
  get(id: string): RunView | undefined
}

export type QueueEngineDeps = {
  store: QueueStore
  runner: QueueRunner
  source(pluginId: string): QueueSource
  prepareWorktree(repo: string, label: string): Promise<{ worktree: string }>
  writeContext(pluginId: string, context: TaskContext, cwd: string): Promise<string>
  pluginFiles(pluginId: string): string
  needsYou(item: QueueItem, reason: string): void
}

export type AddInput = { source: string; externalId: string; repo: string; flowId?: string | null; position?: 'end' | 'next' }

export type QueueEngine = {
  add(input: AddInput): Promise<QueueItem>
  kick(): Promise<void>
  onRunSettled(run: RunView): Promise<void>
  recover(): Promise<void>
  requeue(id: string): Promise<QueueItem>
  checkReplies(): Promise<{ checked: number; resumed: number }>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createQueueEngine(deps: QueueEngineDeps): QueueEngine {
  const { store } = deps
  let lane: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lane.then(work)
    lane = result.catch(error => console.error('queue step failed', error))
    return result
  }

  async function fail(item: QueueItem, reason: string): Promise<void> {
    await store.update(item.id, { state: 'failed', error: reason, currentRunId: null })
    deps.needsYou(item, reason)
  }

  async function settle(run: RunView): Promise<void> {
    const item = store.list().find(entry => entry.state === 'building' && entry.currentRunId === run.id)
    if (item === undefined || !SETTLED.has(run.status)) return
    if (run.status === 'done') {
      await store.update(item.id, { state: 'ready', currentRunId: null, error: null })
      deps.needsYou(item, 'Built and ready for review')
      return
    }
    const questions = questionsOf(run)
    if (questions.length === 0) return fail(item, run.error ?? `Run ${run.status}`)
    try {
      const posted = await deps.source(item.source).post({ id: item.externalId, kind: 'ask', lines: questions })
      await store.update(item.id, { state: 'waiting-info', questions, lastSeenId: posted.commentId, currentRunId: null })
    } catch (error) {
      await fail(item, `Could not post the questions: ${message(error)}`)
    }
  }

  async function build(item: QueueItem): Promise<void> {
    const { worktree } = item.worktree !== null ? { worktree: item.worktree } : await deps.prepareWorktree(item.repo, branchLabel(item))
    const contextPath = item.contextPath ?? await deps.writeContext(item.source, { name: `item-${item.externalId}`, markdown: (await deps.source(item.source).item({ id: item.externalId })).contextMarkdown }, worktree)
    const ready = { ...item, worktree, contextPath }
    const run = await deps.runner.start({ cwd: worktree, request: runRequest(ready), label: item.title.slice(0, 120), ...(item.flowId ? { workflowId: item.flowId } : {}) }, { startedByUser: true })
    await store.update(item.id, { state: 'building', worktree, contextPath, currentRunId: run.id, runIds: [...item.runIds, run.id], error: null })
    const now = deps.runner.get(run.id)
    if (now !== undefined && SETTLED.has(now.status)) await settle(now)
  }

  async function startNext(): Promise<void> {
    while (!store.list().some(item => item.state === 'building')) {
      const next = store.list().find(item => item.state === 'queued')
      if (next === undefined) return
      try { await build(next) } catch (error) { await fail(next, message(error)) }
    }
  }

  async function add(input: AddInput): Promise<QueueItem> {
    const detail = await deps.source(input.source).item({ id: input.externalId })
    const item = await store.add({ source: input.source, externalId: input.externalId, title: detail.title, url: detail.url, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end')
    await serial(startNext)
    return store.get(item.id) ?? item
  }

  async function requeue(id: string): Promise<QueueItem> {
    if (store.get(id) === undefined) throw new Error(`No queue item ${id}`)
    await store.update(id, { state: 'queued', error: null, currentRunId: null })
    await store.move(id, store.list().length)
    await serial(startNext)
    return store.get(id)!
  }

  async function recover(): Promise<void> {
    await serial(async () => {
      for (const item of store.list().filter(entry => entry.state === 'building')) {
        const run = item.currentRunId === null ? undefined : deps.runner.get(item.currentRunId)
        if (run === undefined) await fail(item, 'Its run is gone')
        else if (SETTLED.has(run.status)) await settle(run)
      }
      await startNext()
    })
  }

  return {
    add,
    requeue,
    recover,
    kick: () => serial(startNext),
    onRunSettled: run => serial(async () => { await settle(run); await startNext() }),
    checkReplies: async () => ({ checked: 0, resumed: 0 }),
  }
}
```

Note for the implementer: `add` fetches the source item *before* taking the serial lane on purpose (network outside the lane), then `build` fetches it again only when `contextPath` is still null; that second fetch is what writes the context file.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/queue-engine.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add server/queue-engine.ts test/queue-engine.test.ts
git commit -m "feat(queue): engine builds one item at a time, parks on questions, recovers after restart"
```

---

### Task 5: Engine — reply check and image import

**Files:**
- Modify: `server/queue-engine.ts` (replace the `checkReplies` stub; add `importImages`)
- Test: `test/queue-replies.test.ts`

**Interfaces:**
- Consumes: Task 4 internals (`serial`, `startNext`, `fail` are in scope inside `createQueueEngine`), `answersMarkdown` (Task 3), `SourceImage` (Task 2).
- Produces: `checkReplies(): Promise<{ checked: number; resumed: number }>` — for every `waiting-info` item: one `source.replies` call; replies → answers context file in the worktree, images copied next to it, item back to `queued` at the front, `questions` cleared, `lastSeenId` advanced; then builds the next item. `MAX_REPLY_FAILURES = 3` consecutive failures per item → `needsYou(item, 'Could not read replies: <error>')` once, counter resets.

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, type QueueEngineDeps } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource, SourceReplies } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-replies-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function parked(replies: () => Promise<SourceReplies>) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const alerts: string[] = []
  const requests: string[] = []
  let next = 0
  const files = join(dir, 'plugin-data', 'clickup-board', 'files')
  const source: QueueSource = { item: async ({ id }) => ({ title: `Task ${id}`, url: 'u', contextMarkdown: '# t' }), post: async () => ({ commentId: 'c1' }), replies }
  const deps: QueueEngineDeps = {
    store,
    runner: { start: async input => { requests.push(input.request); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id) },
    source: () => source,
    prepareWorktree: async (_repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: async (pluginId, context, cwd) => { const folder = join(cwd, '.mission-control', 'context', pluginId); await mkdir(folder, { recursive: true }); const path = join(folder, `${context.name}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: () => files,
    needsYou: (_item, reason) => { alerts.push(reason) },
  }
  const engine = createQueueEngine(deps)
  const item = await engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  await engine.onRunSettled({ id: 'run-1', status: 'blocked', error: null, attempts: [{ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 's', evidence: ['Which page?'] }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] }] })
  return { engine, store, item, alerts, requests, files }
}

test('no replies keeps the item waiting', async () => {
  const h = await parked(async () => ({ replies: [], lastId: null }))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(h.item.id)!.state).toBe('waiting-info')
})

test('a reply writes the answers, puts the item first and rebuilds it with the answers', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: 'r1' }))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  const item = h.store.get(h.item.id)!
  expect(item).toMatchObject({ state: 'building', questions: [], lastSeenId: 'r1', runIds: ['run-1', 'run-2'] })
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain('The login page')
  expect(h.requests[1]).toContain(`The requester answered your earlier questions: read ${item.answerPaths[0]}`)
})

test('reply images are copied into the worktree context folder and listed', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'See this', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' }))
  await mkdir(join(h.files, 'replies'), { recursive: true })
  await writeFile(join(h.files, 'replies', 'shot.png'), 'png-bytes')
  await h.engine.checkReplies()
  const item = h.store.get(h.item.id)!
  const copied = join(item.worktree!, '.mission-control', 'context', 'clickup-board', 'r1-shot.png')
  expect(await readFile(copied, 'utf8')).toBe('png-bytes')
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain(`- ${copied}`)
})

test('images outside the plugin data folder are skipped', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'key', path: '../../../secret' }] }], lastId: 'r1' }))
  await writeFile(join(dir, 'secret'), 'do not copy')
  await h.engine.checkReplies()
  const item = h.store.get(h.item.id)!
  expect(stat(join(item.worktree!, '.mission-control', 'context', 'clickup-board', 'r1-key'))).rejects.toThrow()
  expect(await readFile(item.answerPaths[0]!, 'utf8')).not.toContain('## Images')
})

test('a failing source keeps the item waiting and asks for you after three failures', async () => {
  const h = await parked(async () => { throw new Error('ClickUp is down') })
  await h.engine.checkReplies()
  await h.engine.checkReplies()
  expect(h.alerts).toEqual([])
  await h.engine.checkReplies()
  expect(h.store.get(h.item.id)!.state).toBe('waiting-info')
  expect(h.alerts).toEqual(['Could not read replies: ClickUp is down'])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/queue-replies.test.ts`
Expected: FAIL (stub returns `{ checked: 0, resumed: 0 }`).

- [ ] **Step 3: Implement** — in `server/queue-engine.ts` add imports and helpers, then replace the stub.

Add to the imports:

```ts
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

import { SESSION_CONTEXT_DIR } from './plugins/context-files'
import { answersMarkdown } from './queue-prompts'
import type { SourceImage, SourceReply } from './queue-source'
```

Add above `createQueueEngine`:

```ts
const MAX_REPLY_FAILURES = 3

async function importImages(root: string, replies: SourceReply[], folder: string): Promise<string[]> {
  const base = resolve(root)
  const copied: string[] = []
  await mkdir(folder, { recursive: true, mode: 0o700 })
  for (const reply of replies) {
    for (const image of reply.images as SourceImage[]) {
      const from = resolve(base, image.path)
      if (!from.startsWith(base + sep)) continue
      const to = join(folder, `${reply.id}-${basename(image.name)}`.replace(/[^A-Za-z0-9._-]/g, '-'))
      try { await copyFile(from, to); copied.push(to) } catch (error) { console.error('queue image copy failed', error) }
    }
  }
  return copied
}
```

Inside `createQueueEngine`, add:

```ts
  const replyFailures = new Map<string, number>()

  async function resume(item: QueueItem, replies: SourceReply[], lastId: string | null): Promise<void> {
    const folder = join(item.worktree!, SESSION_CONTEXT_DIR, 'context', item.source)
    const images = await importImages(deps.pluginFiles(item.source), replies, folder)
    const path = await deps.writeContext(item.source, { name: `answers-${item.externalId}`, markdown: answersMarkdown(item.questions, replies, images) }, item.worktree!)
    await store.update(item.id, { state: 'queued', answerPaths: [...item.answerPaths, path], questions: [], lastSeenId: lastId ?? item.lastSeenId })
    await store.toFront(item.id)
  }

  async function checkOne(item: QueueItem): Promise<boolean> {
    try {
      const { replies, lastId } = await deps.source(item.source).replies({ id: item.externalId, sinceId: item.lastSeenId })
      replyFailures.delete(item.id)
      if (replies.length === 0) return false
      await resume(item, replies, lastId)
      return true
    } catch (error) {
      const failures = (replyFailures.get(item.id) ?? 0) + 1
      replyFailures.set(item.id, failures % MAX_REPLY_FAILURES)
      if (failures === MAX_REPLY_FAILURES) deps.needsYou(item, `Could not read replies: ${message(error)}`)
      return false
    }
  }

  async function checkReplies(): Promise<{ checked: number; resumed: number }> {
    return serial(async () => {
      const waiting = store.list().filter(item => item.state === 'waiting-info' && item.worktree !== null)
      let resumed = 0
      for (const item of waiting) if (await checkOne(item)) resumed += 1
      await startNext()
      return { checked: waiting.length, resumed }
    })
  }
```

Replace `checkReplies: async () => ({ checked: 0, resumed: 0 }),` in the returned object with `checkReplies,`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/queue-replies.test.ts test/queue-engine.test.ts`
Expected: PASS (5 + 12 tests).

- [ ] **Step 5: Commit**

```bash
git add server/queue-engine.ts test/queue-replies.test.ts
git commit -m "feat(queue): reply check resumes parked items with answers and images"
```

---

### Task 6: HTTP routes

**Files:**
- Create: `server/routes/queue.ts`
- Test: `test/queue-routes.test.ts`

**Interfaces:**
- Consumes: `QueueEngine` (Tasks 4–5), `QueueStore` (Task 1), `requireLocal` from `server/auth.ts`, `eventStreamResponse` from `server/run-events.ts`.
- Produces: `export function queueRoutes(store: QueueStore, engine: Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies'>): Elysia` with
  - `GET /api/queue` → `{ items }`
  - `GET /api/queue/stream` → SSE of `{ items }`
  - `POST /api/queue` body `{ source, externalId, repo, flowId?, position? }` → `{ item }` (400 on bad body, 502 with the source's message when the source fails)
  - `POST /api/queue/check` → `{ checked, resumed }`
  - `POST /api/queue/:id/move` body `{ to }` → `{ items }` (404 unknown)
  - `POST /api/queue/:id/requeue` → `{ item }` (404 unknown, 409 when building)
  - `DELETE /api/queue/:id` → `{ ok: true }` (404 unknown, 409 when building: "Stop its run in Studio first")

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import type { QueueEngine } from '../server/queue-engine'
import { createQueueStore } from '../server/queue-store'
import { queueRoutes } from '../server/routes/queue'

const store = () => createQueueStore(join(mkdtempSync(join(tmpdir(), 'mc-queue-routes-')), 'queue.json'))
const call = (app: Elysia, path: string, init: RequestInit = {}) => app.handle(new Request(`http://127.0.0.1:7777${path}`, { ...init, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' } }))
const post = (app: Elysia, path: string, body: unknown = {}) => call(app, path, { method: 'POST', body: JSON.stringify(body) })
const newItem = { source: 'clickup-board', externalId: '1', title: 'Task 1', url: 'u', repo: '/repo', flowId: null }

function engine(items: ReturnType<typeof store>, over: Partial<QueueEngine> = {}): Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies'> {
  return {
    add: async input => items.add({ ...newItem, externalId: input.externalId, repo: input.repo, flowId: input.flowId ?? null }, input.position ?? 'end'),
    requeue: async id => items.update(id, { state: 'queued' }),
    checkReplies: async () => ({ checked: 2, resumed: 1 }),
    ...over,
  }
}

test('GET lists items; POST adds through the engine', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const added = await post(app, '/api/queue', { source: 'clickup-board', externalId: '7', repo: '/repo', position: 'next' })
  expect(added.status).toBe(200)
  expect((await added.json()).item.externalId).toBe('7')
  expect((await (await call(app, '/api/queue')).json()).items).toHaveLength(1)
})

test('POST rejects a bad body and reports a source failure as 502', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items, { add: async () => { throw new Error('clickup-board is not installed') } })))
  expect((await post(app, '/api/queue', { source: '', externalId: '1', repo: '/repo' })).status).toBe(400)
  expect((await post(app, '/api/queue', { source: 'x', externalId: '1', repo: '/repo', position: 'top' })).status).toBe(400)
  const failed = await post(app, '/api/queue', { source: 'clickup-board', externalId: '1', repo: '/repo' })
  expect(failed.status).toBe(502)
  expect((await failed.json()).error).toBe('clickup-board is not installed')
})

test('check returns the engine counts', async () => {
  const items = store()
  expect(await (await post(new Elysia().use(queueRoutes(items, engine(items))), '/api/queue/check')).json()).toEqual({ checked: 2, resumed: 1 })
})

test('move reorders and 404s an unknown id', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  await items.add(newItem, 'end')
  const b = await items.add({ ...newItem, externalId: '2' }, 'end')
  const moved = await post(app, `/api/queue/${b.id}/move`, { to: 0 })
  expect((await moved.json()).items.map((item: { externalId: string }) => item.externalId)).toEqual(['2', '1'])
  expect((await post(app, '/api/queue/nope/move', { to: 0 })).status).toBe(404)
  expect((await post(app, `/api/queue/${b.id}/move`, { to: -1 })).status).toBe(400)
})

test('delete and requeue refuse a building item and 404 unknown ids', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const a = await items.add(newItem, 'end')
  await items.update(a.id, { state: 'building' })
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(409)
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(409)
  await items.update(a.id, { state: 'failed' })
  expect((await post(app, `/api/queue/${a.id}/requeue`)).status).toBe(200)
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(200)
  expect((await call(app, `/api/queue/${a.id}`, { method: 'DELETE' })).status).toBe(404)
})

test('a request from another site is refused', async () => {
  const items = store()
  const app = new Elysia().use(queueRoutes(items, engine(items)))
  const response = await app.handle(new Request('http://127.0.0.1:7777/api/queue', { headers: { host: 'evil.example' } }))
  expect(response.status).toBe(403)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/queue-routes.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { Elysia } from 'elysia'
import { z } from 'zod'

import { requireLocal } from '../auth'
import type { QueueEngine } from '../queue-engine'
import type { QueueStore } from '../queue-store'
import { eventStreamResponse } from '../run-events'

const addSchema = z.object({
  source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  externalId: z.string().min(1).max(200),
  repo: z.string().min(1).max(2048),
  flowId: z.string().min(1).max(200).nullable().optional(),
  position: z.enum(['end', 'next']).optional(),
})
const moveSchema = z.object({ to: z.number().int().min(0) })
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function queueRoutes(store: QueueStore, engine: Pick<QueueEngine, 'add' | 'requeue' | 'checkReplies'>): Elysia {
  const known = (id: string, set: { status?: number | string }) => {
    const item = store.get(id)
    if (item === undefined) set.status = 404
    return item
  }
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/queue', () => ({ items: store.list() }))
    .get('/api/queue/stream', ({ request }) => eventStreamResponse(store, () => ({ items: store.list() }), request.signal))
    .post('/api/queue', async ({ body, set }) => {
      const parsed = addSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'source, externalId and repo are required; position is end or next' } }
      try { return { item: await engine.add(parsed.data) } } catch (error) { set.status = 502; return { error: message(error) } }
    })
    .post('/api/queue/check', () => engine.checkReplies())
    .post('/api/queue/:id/move', async ({ params, body, set }) => {
      const parsed = moveSchema.safeParse(body)
      if (!parsed.success) { set.status = 400; return { error: 'to must be a position from 0' } }
      if (!known(params.id, set)) return { error: 'No such queue item' }
      await store.move(params.id, parsed.data.to)
      return { items: store.list() }
    })
    .post('/api/queue/:id/requeue', async ({ params, set }) => {
      const item = known(params.id, set)
      if (!item) return { error: 'No such queue item' }
      if (item.state === 'building') { set.status = 409; return { error: 'It is building now' } }
      return { item: await engine.requeue(params.id) }
    })
    .delete('/api/queue/:id', async ({ params, set }) => {
      const item = known(params.id, set)
      if (!item) return { error: 'No such queue item' }
      if (item.state === 'building') { set.status = 409; return { error: 'Stop its run in Studio first' } }
      await store.remove(params.id)
      return { ok: true }
    })
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/queue-routes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/routes/queue.ts test/queue-routes.test.ts
git commit -m "feat(queue): /api/queue routes"
```

---

### Task 7: Wire into the server

**Files:**
- Modify: `server/index.ts` (imports near line 33–38; runner creation ~183–191; route mounting ~243–259; after `workflowRunner` recovery ~203)

**Interfaces:**
- Consumes: everything above; `prepareWorktree` from `server/job-worktrees.ts`; `writeContextFile` from `server/plugins/context-files.ts`; `getInstalled` from `server/plugins/store.ts`; `defaultRuntimes` from `server/plugins/runtimes.ts`; `configDir` from `server/secrets.ts`.
- Produces: a running queue; `REPLY_SWEEP_MS = 15 * 60_000`.

- [ ] **Step 1: Read the current wiring**

Run: `grep -n "createWorkflowRunner\|workflowRunner.recover\|onRunSettled\|pluginsRoutes()" server/index.ts`
Note the exact lines; the snippets below go next to them.

- [ ] **Step 2: Add imports** (alongside the existing server imports)

```ts
import { prepareWorktree } from './job-worktrees'
import { writeContextFile } from './plugins/context-files'
import { getInstalled } from './plugins/store'
import { createQueueEngine, type QueueEngine } from './queue-engine'
import { pluginSource } from './queue-source'
import { createQueueStore, queuePath } from './queue-store'
import { queueRoutes } from './routes/queue'
```

(`defaultRuntimes` and `configDir` are already imported in `index.ts`; check with grep and add them only if missing. `join` comes from `node:path`, already imported.)

- [ ] **Step 3: Hook run settling** — declare before `createWorkflowRunner` and extend its `onRunSettled`:

```ts
  let queueEngine: QueueEngine | undefined
```

```ts
    onRunSettled: run => {
      void chatFlusher.onRunSettled(run).catch(error => console.error('Workflow chat report failed', error))
      void queueEngine?.onRunSettled(run).catch(error => console.error('Queue settle failed', error))
    },
```

- [ ] **Step 4: Build the store and engine** — right after the `workflowRunner.recover()` call:

```ts
  const queueStore = createQueueStore(queuePath())
  queueEngine = createQueueEngine({
    store: queueStore,
    runner: workflowRunner,
    source: pluginId => pluginSource(pluginId, { installed: getInstalled, runtimes: defaultRuntimes }),
    prepareWorktree: (repo, label) => prepareWorktree(repo, label),
    writeContext: (pluginId, context, cwd) => writeContextFile(pluginId, context, new Date(), cwd),
    pluginFiles: pluginId => join(configDir(), 'plugin-data', pluginId, 'files'),
    // ponytail: console until 1c adds the queue attention kind
    needsYou: (item, reason) => console.warn(`Queue: ${item.title}: ${reason}`),
  })
  void queueEngine.recover().catch(error => console.error('Queue recover failed', error))
  const REPLY_SWEEP_MS = 15 * 60_000
  setInterval(() => { void queueEngine?.checkReplies().catch(error => console.error('Queue reply check failed', error)) }, REPLY_SWEEP_MS).unref()
```

If TypeScript reports that `workflowRunner` does not satisfy `QueueRunner` (its `start` takes `unknown`), pass an adapter instead: `runner: { start: (input, context) => workflowRunner.start(input, context), get: id => workflowRunner.get(id) }`.

- [ ] **Step 5: Mount the routes** — next to `.use(pluginsRoutes())`:

```ts
    .use(queueRoutes(queueStore, queueEngine))
```

- [ ] **Step 6: Typecheck and run the suite**

Run: `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "server/(index|queue)" ; bun test`
Expected: no type errors in `server/index.ts` or `server/queue-*`; full suite PASS. (If the repo has no root `tsconfig.json`, run `bun build server/index.ts --target=bun --outdir=/tmp/mc-queue-build` to confirm it compiles, then delete that folder.)

- [ ] **Step 7: Commit**

```bash
git add server/index.ts
git commit -m "feat(queue): run the queue in the server with a 15-minute reply check"
```

---

### Task 8: `mctl queue`

**Files:**
- Create: `cli/commands/queue.ts`
- Modify: `cli/mctl.ts` (import `queueCommands` and add it where `clickupCommands` / `pluginCommands` are registered)
- Test: `test/cli-queue.test.ts`

**Interfaces:**
- Consumes: `Command`, `Context`, `emit`, `stringOpt`, `flag`, `UsageError` from `cli/command.ts`; `segment` from `cli/client.ts`; `cell`, `table` from `cli/format.ts`. Routes from Task 6.
- Produces: `export const queueCommands: Command[]` with
  - `queue list` → table ID · STATE · SOURCE · TITLE · ERROR/QUESTIONS
  - `queue add <source> <externalId> --repo <dir> [--flow <id>] [--next]` (repo defaults to the current directory)
  - `queue move <id> <to>`
  - `queue requeue <id>`
  - `queue remove <id>`
  - `queue check`

- [ ] **Step 1: Read the existing CLI test harness**

Run: `sed -n 1,60p test/cli-plugins.test.ts`
Copy its way of building a `Context` with a fake client (recorded `get`/`post`/`del` calls and canned answers) into the new test file; do not invent a different harness.

- [ ] **Step 2: Write the failing tests** (adapt `ctx(...)`/`run(...)` names to the harness you copied in Step 1; the assertions are the contract)

```ts
// test/cli-queue.test.ts
import { expect, test } from 'bun:test'

import { queueCommands } from '../cli/commands/queue'
// + the harness helpers copied from test/cli-plugins.test.ts

const command = (...path: string[]) => queueCommands.find(entry => entry.path.join(' ') === path.join(' '))!

test('list prints one row per item with its state and questions', async () => {
  // fake GET /api/queue → { items: [{ id: 'a1', state: 'waiting-info', source: 'clickup-board', title: 'Login copy', questions: ['Which page?'], error: null }] }
  // run command('queue', 'list'); expect output to contain 'a1', 'waiting-info', 'Login copy', 'Which page?'
})

test('list says how to add when the queue is empty', async () => {
  // fake GET /api/queue → { items: [] }; expect 'The queue is empty. Add an item with: mctl queue add <source> <id> --repo <dir>'
})

test('add posts source, id, repo, flow and position next', async () => {
  // args { source: 'clickup-board', externalId: '86d3j4f8q' }, values { repo: '/repo', flow: 'wf-1', next: true }
  // expect POST /api/queue with { source: 'clickup-board', externalId: '86d3j4f8q', repo: '/repo', flowId: 'wf-1', position: 'next' }
})

test('add uses the current directory when --repo is missing', async () => {
  // ctx.cwd = '/work/api'; expect body.repo === '/work/api' and position 'end', no flowId key
})

test('move sends a whole number and rejects anything else', async () => {
  // args { id: 'a1', to: '2' } → POST /api/queue/a1/move { to: 2 }
  // args { id: 'a1', to: 'x' } → throws UsageError 'to must be a whole number from 0'
})

test('requeue, remove and check hit their routes', async () => {
  // queue requeue a1 → POST /api/queue/a1/requeue; queue remove a1 → DELETE /api/queue/a1; queue check → POST /api/queue/check and prints 'Checked 2, resumed 1'
})
```

Fill each test body with the harness calls; every comment line above is a required assertion.

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/cli-queue.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```ts
import { segment } from '../client'
import { emit, flag, stringOpt, UsageError, type Command, type Context } from '../command'
import { cell, table } from '../format'

type Json = Record<string, unknown>
const itemPath = (id: string, suffix = ''): string => `/api/queue/${segment(id)}${suffix}`
const items = (value: unknown): Json[] => {
  const list = (value as Json | null)?.items
  return Array.isArray(list) ? list.filter((item): item is Json => item !== null && typeof item === 'object') : []
}
const note = (item: Json): string => {
  if (typeof item.error === 'string') return item.error
  return Array.isArray(item.questions) ? item.questions.map(String).join(' / ') : ''
}

function listText(value: unknown): string {
  const rows = items(value)
  if (rows.length === 0) return 'The queue is empty. Add an item with: mctl queue add <source> <id> --repo <dir>\n'
  return table(rows, [
    { header: 'ID', value: item => cell(item.id) },
    { header: 'STATE', value: item => cell(item.state) },
    { header: 'SOURCE', value: item => cell(item.source) },
    { header: 'TITLE', value: item => cell(item.title) },
    { header: 'NOTE', value: item => cell(note(item)) },
  ])
}

const arg = (ctx: Context, name: string): string => {
  const value = ctx.args[name]
  if (value === undefined || value === '') throw new UsageError(`${name} is required`, 'queue')
  return value
}

export const queueCommands: Command[] = [
  { path: ['queue', 'list'], summary: 'Show the queue in build order', run: async ctx => emit(ctx, await ctx.client.get('/api/queue'), listText) },
  {
    path: ['queue', 'add'], args: ['source', 'externalId'], summary: 'Add a source item to the queue',
    options: { repo: { type: 'string', description: 'Repo the item is built in (default: current directory)', placeholder: 'dir' }, flow: { type: 'string', description: 'Saved flow id', placeholder: 'id' }, next: { type: 'boolean', description: 'Put it first' } },
    run: async ctx => {
      const flow = stringOpt(ctx, 'flow')
      const body = { source: arg(ctx, 'source'), externalId: arg(ctx, 'externalId'), repo: stringOpt(ctx, 'repo') ?? ctx.cwd, ...(flow ? { flowId: flow } : {}), position: flag(ctx, 'next') ? 'next' : 'end' }
      emit(ctx, await ctx.client.post('/api/queue', body), value => `Added ${cell((value as Json).item && ((value as Json).item as Json).title)}.\n`)
    },
  },
  {
    path: ['queue', 'move'], args: ['id', 'to'], summary: 'Move an item to a position (0 is first)',
    run: async ctx => {
      const to = Number(arg(ctx, 'to'))
      if (!Number.isInteger(to) || to < 0) throw new UsageError('to must be a whole number from 0', 'queue')
      emit(ctx, await ctx.client.post(itemPath(arg(ctx, 'id'), '/move'), { to }), listText)
    },
  },
  { path: ['queue', 'requeue'], args: ['id'], summary: 'Put a failed or ready item back in line', run: async ctx => emit(ctx, await ctx.client.post(itemPath(arg(ctx, 'id'), '/requeue'), {}), () => 'Back in the queue.\n') },
  { path: ['queue', 'remove'], args: ['id'], summary: 'Remove an item that is not building', run: async ctx => emit(ctx, await ctx.client.del(itemPath(arg(ctx, 'id'))), () => 'Removed.\n') },
  { path: ['queue', 'check'], summary: 'Check sources for replies now', run: async ctx => emit(ctx, await ctx.client.post('/api/queue/check', {}), value => `Checked ${cell((value as Json).checked)}, resumed ${cell((value as Json).resumed)}\n`) },
]
```

Check before using: `ctx.client.del` exists in `cli/client.ts` (the plugins commands use it; if it is named differently, use that name). If `cli/command.ts` already exports an `arg` helper with the same behavior (the plugins command imports one), import it instead of defining the local `arg`.

- [ ] **Step 5: Register** — in `cli/mctl.ts`, `import { queueCommands } from './commands/queue'` and spread `...queueCommands` into the same command list that holds `...pluginCommands`.

- [ ] **Step 6: Run to verify pass**

Run: `bun test test/cli-queue.test.ts test/cli-commands.test.ts && bun run typecheck:cli`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add cli/commands/queue.ts cli/mctl.ts test/cli-queue.test.ts
git commit -m "feat(cli): mctl queue list, add, move, requeue, remove, check"
```

---

## Done means

- `bun test` passes with the 7 new test files.
- `mctl queue list` against the running cockpit after a restart prints "The queue is empty…" (the user restarts the cockpit; agents never do).
- With plan 1b shipped, `mctl queue add clickup-board <taskId> --repo <repo>` builds the task in `<repo>/.worktree/queue-…`, and a plan step that ends `MC_RESULT blocked` with questions posts them on the card.
