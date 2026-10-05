# Card Queue 1b — ClickUp Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ClickUp board plugin implements the queue source contract: `source.item`, `source.post`, `source.replies`.

**Architecture:** The plugin's ClickUp client gains `post()` on the same per-token request queue and 429 handling as `get()`. A new `src/source.ts` holds the three source functions; `src/server.ts` exposes them as plugin methods through the existing `withClickUp` helper. Reply cursors are ClickUp comment timestamps (ms, as strings), opaque to the host.

**Tech Stack:** Bun, TypeScript, `bun:test`, `@mission-control/plugin-sdk`.

**Spec:** `docs/superpowers/specs/2026-10-05-card-queue-design.md` (decisions 6–9); contract as amended in `docs/superpowers/plans/2026-10-05-card-queue-1a-engine.md` → "Source contract (spec delta)".

**Repo:** `/Users/lynchz/Desktop/kingpinggroup/mission-control/.plugins-dev/mc-plugin-clickup` (its own git repo, branch `main`). All paths below are relative to it.

## Global Constraints

- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- Commit on `main` in the plugin repo, one per task, conventional format. No `Co-Authored-By`. Never `git merge`. Do not push, tag or bump versions (the controller releases).
- `bun test` in the plugin repo stays green.
- No new network permission: the manifest keeps `["api.clickup.com"]`.
- Every comment MC posts ends with the marker line `— Mission Control`; comments containing that line are never returned as replies.
- Thai copy is polite, short, ends with ครับ.
- Images: `images` is always `[]` in 1b. Image links found in a reply are appended to its text as `Image: <url>` lines (download needs a host-side permission change; phase 2).

## Review Focus

1. A task id with `/` or `?` (`../user`) must never reach a ClickUp path — Task 2 test "rejects task ids that are not plain ClickUp ids".
2. A requester replying inside the thread under MC's question (not a new top-level comment) must be seen — Task 3 test "returns thread replies under any comment".
3. MC's own question, and the user's later MC-posted comments, must never come back as replies — Task 3 test "skips comments carrying the marker".
4. A reply check with nothing new must not move the cursor backwards or to null — Task 3 test "keeps the cursor when nothing is newer".
5. ClickUp answering 429 to a POST must surface as the busy message, not a crash — Task 1 test "post shares the 429 handling".

---

## File Structure

| File | Responsibility |
|---|---|
| `src/clickup-api.ts` (modify) | `post(path, body, deadline)` beside `get`, same queue and retry |
| `test/helpers/fake-clickup.ts` (modify) | record and pass `method` and parsed JSON `body` to responders |
| `src/source.ts` (create) | `MC_MARKER`, `askText`, `isTaskId`, `sourceItem`, `sourcePost`, `sourceReplies` |
| `src/server.ts` (modify) | expose `source.item`, `source.post`, `source.replies` |
| Tests | `test/clickup-api.test.ts` (extend), `test/source.test.ts` (create), `test/server.test.ts` (extend) |

---

### Task 1: ClickUp client POST

**Files:**
- Modify: `src/clickup-api.ts`, `test/helpers/fake-clickup.ts`
- Test: `test/clickup-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ClickUp {
    get(path: string, deadline: Deadline, guard?: RequestGuard): Promise<unknown>
    post(path: string, body: unknown, deadline: Deadline): Promise<unknown>
  }
  // fake-clickup: RecordedCall gains `method: string; body: unknown`; Responder receives { path, query, method, body }
  ```

- [ ] **Step 1: Extend the fake** — in `test/helpers/fake-clickup.ts`:
  - `RecordedCall` gains `method: string` and `body: unknown`.
  - `Responder` becomes `(call: { path: string; query: URLSearchParams; method: string; body: unknown }) => FakeReply | 'hang'`.
  - In `fetchImpl`, compute `const method = (init?.method ?? 'GET').toUpperCase()` and `const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined`, store both on `call`, and pass `{ path: call.path, query: call.query, method, body }` to `respond`.
  Existing responders that only read `path`/`query` keep working.

- [ ] **Step 2: Write the failing tests** — append to `test/clickup-api.test.ts`, reusing that file's existing imports and its way of building a client with `fakeClickUp` + `fakeClock` + a deadline (read the top of the file and copy the setup the existing `get` tests use):

```ts
describe('post', () => {
  test('sends JSON with the token and returns the body', async () => {
    // responder: ({ method, path, body }) => method === 'POST' && path === '/task/t1/comment' ? { body: { id: 'c1', date: '1700' } } : { status: 404 }
    // await api.post('/task/t1/comment', { comment_text: 'hi' }, deadline) resolves to { id: 'c1', date: '1700' }
    // fake.calls[0] has method 'POST' and body { comment_text: 'hi' }
    // the request carried headers Authorization: <token> and content-type: application/json (assert via a fetch spy wrapping fake.fetchImpl)
  })

  test('post shares the 429 handling', async () => {
    // responder always returns { status: 429, headers: { 'retry-after': '30' } }
    // await outcome(api.post(...)) → ok false, error message 'ClickUp is busy, try again in 30 s'
  })

  test('post maps 401 to TokenRejected', async () => {
    // responder { status: 401 } → error instanceof TokenRejected
  })
})
```

Every comment line is a required assertion; write it with the file's real helpers.

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/clickup-api.test.ts`
Expected: FAIL, `api.post is not a function`.

- [ ] **Step 4: Implement** — in `src/clickup-api.ts`:
  - Add `post(path: string, body: unknown, deadline: Deadline): Promise<unknown>` to `interface ClickUp`.
  - Rename the current `get` body into `async function send(path: string, deadline: Deadline, guard: RequestGuard | undefined, init: RequestInit): Promise<unknown>` and make `request(path, deadline, init)` spread `init` into the `fetchImpl` call, merging headers as `{ Authorization: token, ...(init.headers as Record<string, string> | undefined) }`.
  - `get = (path, deadline, guard) => send(path, deadline, guard, {})`
  - `post = (path, body, deadline) => send(path, deadline, undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })`
  - `return { get, post }`

- [ ] **Step 5: Run to verify pass**

Run: `bun test`
Expected: all tests pass (existing `get` tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/clickup-api.ts test/helpers/fake-clickup.ts test/clickup-api.test.ts
git commit -m "feat: ClickUp client can POST on the same queue and retry rules"
```

---

### Task 2: `source.item` and `source.post`

**Files:**
- Create: `src/source.ts`
- Test: `test/source.test.ts`

**Interfaces:**
- Consumes: `ClickUp` (Task 1), `buildDossier` from `src/dossier.ts`, `Deadline`/`Clock` from `src/deadline.ts`.
- Produces:
  ```ts
  export const MC_MARKER = '— Mission Control'
  export function isTaskId(id: unknown): id is string            // /^[A-Za-z0-9_-]{1,40}$/
  export function askText(lines: string[]): string
  export async function sourceItem(api: ClickUp, id: string, deadline: Deadline, clock: Clock): Promise<{ title: string; url: string; contextMarkdown: string }>
  export async function sourcePost(api: ClickUp, input: { id: string; kind: 'ask'; lines: string[] }, deadline: Deadline, now: number): Promise<{ commentId: string }>
  ```

- [ ] **Step 1: Write the failing tests** (`test/source.test.ts`; build `api` with `createClickUp('pk_test', { fetch: fake.fetchImpl, clock })`, a deadline with `createDeadline(25000, clock)`, and drive promises with `settle(clock, …)` from `test/helpers/fake-clock.ts`, as `test/server.test.ts` does)

```ts
test('askText numbers the questions in Thai and ends with the marker', () => {
  expect(askText(['หน้าไหนครับ', 'Thai or English?'])).toBe(
    'ขอถามเพิ่มเติมก่อนเริ่มงานนี้นิดนึงครับ\n\n1. หน้าไหนครับ\n2. Thai or English?\n\nตอบใต้คอมเมนต์นี้หรือคอมเมนต์ใหม่ได้เลยครับ\n— Mission Control',
  )
})

test('rejects task ids that are not plain ClickUp ids', () => {
  expect(isTaskId('86d3j4f8q')).toBe(true)
  expect(isTaskId('CU-123_a')).toBe(true)
  for (const bad of ['', '../user', 't1?x=1', 'a/b', 'x'.repeat(41), 7, null]) expect(isTaskId(bad)).toBe(false)
})

test('sourceItem returns the task name, its link and the dossier markdown', async () => {
  // responder: '/task/t1' → { body: { id: 't1', name: 'Login copy', url: 'https://app.clickup.com/t/t1' } }
  //            '/task/t1/comment' → { body: { comments: [] } }; anything else 404
  // result.title 'Login copy', result.url 'https://app.clickup.com/t/t1', result.contextMarkdown contains '# Dossier: Login copy (t1)'
})

test('sourceItem falls back to the standard task link when ClickUp omits url', async () => {
  // '/task/t1' body without url → result.url 'https://app.clickup.com/t/t1'
})

test('sourcePost posts the ask text with notify_all and returns the comment date as the cursor', async () => {
  // responder: POST '/task/t1/comment' → { body: { id: '9001', date: 1700000000000 } }
  // result { commentId: '1700000000000' }; recorded body { comment_text: askText(['Which page?']), notify_all: true }
})

test('sourcePost uses now as the cursor when ClickUp returns no date', async () => {
  // POST → { body: { id: '9001' } }; now = 1234 → { commentId: '1234' }
})

test('sourcePost refuses an empty question list and a bad id', async () => {
  // sourcePost(api, { id: 't1', kind: 'ask', lines: [] }, …) rejects 'Nothing to ask'
  // sourcePost(api, { id: '../x', kind: 'ask', lines: ['q'] }, …) rejects 'Not a ClickUp task id'
  // no fetch was made
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/source.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { ClickUp } from './clickup-api'
import type { Clock, Deadline } from './deadline'
import { buildDossier } from './dossier'

export const MC_MARKER = '— Mission Control'
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/

export function isTaskId(id: unknown): id is string {
  return typeof id === 'string' && TASK_ID.test(id)
}

function taskId(id: unknown): string {
  if (!isTaskId(id)) throw new Error('Not a ClickUp task id')
  return id
}

export function askText(lines: string[]): string {
  const numbered = lines.map((line, index) => `${index + 1}. ${line}`).join('\n')
  return `ขอถามเพิ่มเติมก่อนเริ่มงานนี้นิดนึงครับ\n\n${numbered}\n\nตอบใต้คอมเมนต์นี้หรือคอมเมนต์ใหม่ได้เลยครับ\n${MC_MARKER}`
}

export async function sourceItem(api: ClickUp, id: string, deadline: Deadline, clock: Clock): Promise<{ title: string; url: string; contextMarkdown: string }> {
  const task = taskId(id)
  const body = (await api.get(`/task/${task}`, deadline)) as { name?: string; url?: string }
  const dossier = await buildDossier(api, task, { clock }, deadline)
  return { title: body.name?.trim() || task, url: body.url || `https://app.clickup.com/t/${task}`, contextMarkdown: dossier.markdown }
}

export async function sourcePost(api: ClickUp, input: { id: string; kind: 'ask'; lines: string[] }, deadline: Deadline, now: number): Promise<{ commentId: string }> {
  const task = taskId(input.id)
  const lines = (Array.isArray(input.lines) ? input.lines : []).filter((line): line is string => typeof line === 'string' && line.trim() !== '')
  if (lines.length === 0) throw new Error('Nothing to ask')
  const body = (await api.post(`/task/${task}/comment`, { comment_text: askText(lines), notify_all: true }, deadline)) as { date?: number | string }
  return { commentId: body.date === undefined ? String(now) : String(body.date) }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/source.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/source.ts test/source.test.ts
git commit -m "feat: source.item and source.post for the Mission Control queue"
```

---

### Task 3: `source.replies` and the plugin methods

**Files:**
- Modify: `src/source.ts`, `src/server.ts`
- Test: `test/source.test.ts` (extend), `test/server.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export type SourceReply = { id: string; author: string; text: string; images: [] }
  export async function sourceReplies(api: ClickUp, input: { id: string; sinceId: string | null }, deadline: Deadline): Promise<{ replies: SourceReply[]; lastId: string | null }>
  // server methods: 'source.item' (params { id }), 'source.post' (params { id, kind, lines }), 'source.replies' (params { id, sinceId })
  ```
- Behavior: one `GET /task/{id}/comment` (newest first, ClickUp's first page); for up to `MAX_THREADS = 10` of those comments with `reply_count > 0`, one `GET /comment/{commentId}/reply` each. A comment or thread reply counts when its `date` (ms) is greater than `Number(sinceId ?? 0)` and its text does not contain `MC_MARKER`. Replies are sorted oldest first. `lastId` is the largest `date` seen across everything fetched (marked or not) when that is greater than `sinceId`, else `sinceId`. Text is `comment_text` trimmed, plus one `Image: <url>` line per image or attachment URL found in the comment's `comment` array (an item whose `type` is `image` or `attachment` and which has a string `image.url`, `attachment.url` or `url`).

- [ ] **Step 1: Write the failing tests** — append to `test/source.test.ts`:

```ts
const comment = (id: string, date: number, text: string, extra: Record<string, unknown> = {}) => ({ id, date: String(date), comment_text: text, user: { username: 'Ploy' }, reply_count: 0, ...extra })

test('returns new top-level comments oldest first with the newest date as cursor', async () => {
  // GET '/task/t1/comment' → { comments: [comment('3', 300, 'second'), comment('2', 200, 'first'), comment('1', 100, 'old')] }
  // sourceReplies(api, { id: 't1', sinceId: '150' }) → replies texts ['first', 'second'], ids ['2', '3'], author 'Ploy', images [], lastId '300'
})

test('skips comments carrying the marker but still advances the cursor past them', async () => {
  // comments: [comment('4', 400, 'ขอถาม…\n— Mission Control'), comment('3', 300, 'answer')], sinceId '100'
  // replies texts ['answer'], lastId '400'
})

test('returns thread replies under any comment', async () => {
  // comments: [comment('4', 400, 'q\n— Mission Control', { reply_count: 1 })]
  // GET '/comment/4/reply' → { comments: [comment('5', 500, 'หน้า login ครับ')] }
  // sinceId '400' → replies texts ['หน้า login ครับ'], lastId '500'
})

test('keeps the cursor when nothing is newer', async () => {
  // comments: [comment('1', 100, 'old')], sinceId '900' → { replies: [], lastId: '900' }
  // comments: [] with sinceId null → { replies: [], lastId: null }
})

test('lists image links in the reply text', async () => {
  // comment('6', 600, 'see', { comment: [{ text: 'see' }, { type: 'image', image: { url: 'https://t1.p.clickup-attachments.com/a.png' } }, { type: 'attachment', attachment: { url: 'https://t1.p.clickup-attachments.com/b.pdf' } }] })
  // sinceId '0' → text 'see\nImage: https://t1.p.clickup-attachments.com/a.png\nImage: https://t1.p.clickup-attachments.com/b.pdf', images []
})

test('reads at most ten threads', async () => {
  // 12 comments each reply_count 1 → exactly 10 GET '/comment/*/reply' calls recorded
})

test('refuses a bad id before any request', async () => {
  // sourceReplies(api, { id: 'a/b', sinceId: null }) rejects 'Not a ClickUp task id'; no calls
})
```

Append to `test/server.test.ts` (inside a new `describe('source methods', …)`, using its `tokened`/`call`/`makeCtx` helpers):

```ts
test('source methods need a token', async () => {
  // with makeCtx() (no token) each of methods['source.item']({ id: 't1' }, ctx), methods['source.post']({ id: 't1', kind: 'ask', lines: ['q'] }, ctx), methods['source.replies']({ id: 't1', sinceId: null }, ctx) rejects 'Connect ClickUp first'
})

test('source.post goes through to ClickUp', async () => {
  // tokened responder: POST '/task/t1/comment' → { body: { id: 'c', date: 1700 } }
  // await call(clock, methods['source.post']({ id: 't1', kind: 'ask', lines: ['Which page?'] }, ctx)) → { commentId: '1700' }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/source.test.ts test/server.test.ts`
Expected: FAIL (`sourceReplies` not exported, methods missing).

- [ ] **Step 3: Implement `sourceReplies`** — append to `src/source.ts`:

```ts
const MAX_THREADS = 10

type RawComment = { id?: string | number; date?: string | number; comment_text?: string; user?: { username?: string }; reply_count?: number | string; comment?: unknown }
export type SourceReply = { id: string; author: string; text: string; images: [] }

function imageLinks(parts: unknown): string[] {
  if (!Array.isArray(parts)) return []
  return parts.flatMap((part) => {
    if (part === null || typeof part !== 'object') return []
    const item = part as { type?: string; url?: unknown; image?: { url?: unknown }; attachment?: { url?: unknown } }
    if (item.type !== 'image' && item.type !== 'attachment') return []
    const url = item.image?.url ?? item.attachment?.url ?? item.url
    return typeof url === 'string' ? [url] : []
  })
}

function toReply(raw: RawComment): SourceReply {
  const text = [(raw.comment_text ?? '').trim(), ...imageLinks(raw.comment).map((url) => `Image: ${url}`)].filter((line) => line !== '').join('\n')
  return { id: String(raw.id), author: raw.user?.username ?? 'someone', text, images: [] }
}

export async function sourceReplies(api: ClickUp, input: { id: string; sinceId: string | null }, deadline: Deadline): Promise<{ replies: SourceReply[]; lastId: string | null }> {
  const task = taskId(input.id)
  const since = Number(input.sinceId ?? 0)
  const top = ((await api.get(`/task/${task}/comment`, deadline)) as { comments?: RawComment[] }).comments ?? []
  const threaded = top.filter((raw) => Number(raw.reply_count ?? 0) > 0).slice(0, MAX_THREADS)
  const threads = await Promise.all(threaded.map(async (raw) => ((await api.get(`/comment/${encodeURIComponent(String(raw.id))}/reply`, deadline)) as { comments?: RawComment[] }).comments ?? []))
  const all = [...top, ...threads.flat()]
  const newest = all.reduce((max, raw) => Math.max(max, Number(raw.date ?? 0)), since)
  const fresh = all
    .filter((raw) => Number(raw.date ?? 0) > since && !(raw.comment_text ?? '').includes(MC_MARKER))
    .sort((a, b) => Number(a.date ?? 0) - Number(b.date ?? 0))
  return { replies: fresh.map(toReply), lastId: newest > since ? String(newest) : input.sinceId }
}
```

- [ ] **Step 4: Expose the methods** — in `src/server.ts` import `sourceItem`, `sourcePost`, `sourceReplies` from `./source` and add to the object returned by `createMethods`:

```ts
    'source.item': async (params: { id: string }, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => sourceItem(api, params.id, deadline, clock)),

    'source.post': async (params: { id: string; kind: 'ask'; lines: string[] }, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => sourcePost(api, params, deadline, clock.now())),

    'source.replies': async (params: { id: string; sinceId: string | null }, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => sourceReplies(api, params, deadline)),
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/source.ts src/server.ts test/source.test.ts test/server.test.ts
git commit -m "feat: source.replies and the queue source methods"
```

---

## Release (controller, after the final review)

1. Bump `version` to `1.4.0` in `package.json` and `mc-plugin.json`; commit `chore: v1.4.0`; push `main`; tag `v1.4.0`; push the tag.
2. In `.plugins-dev/mc-marketplace/marketplace.json` set the clickup-board `ref` to `v1.4.0`; commit `chore: ClickUp board v1.4.0`; push.
3. `bun cli/mctl.ts plugin catalog --refresh` then `bun cli/mctl.ts plugin update clickup-board --yes` from the mission-control repo.
