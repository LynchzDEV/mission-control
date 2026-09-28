# Real Session Flows — Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Session flow drawer shows the session's real Studio workflow run, live, with one approval before it starts; the plan runner and the synthesized flow are removed.

**Architecture:** `server/workflow-runner.ts` gains approval / pause states and a change hook. New `server/run-events.ts` + `server/run-view.ts` push a per-scope snapshot over SSE. The drawer (`client/flow-drawer.ts` + a rewritten `client/flow-graph.ts`) renders variant D from `docs/design/flow-drawer/DECISION.md`. Chat and terminal instructions teach any session AI to pick a saved workflow and relay approval.

**Tech Stack:** Bun, TypeScript, Elysia, zod, plain DOM client, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-28-real-session-flows-design.md` (Part 1). Drawer tokens: `docs/design/flow-drawer/DECISION.md`.

## Global Constraints

- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- No emoji anywhere (UI, copy, commits). Icons are SVG or provider logos (`/providers/<engine>.svg`).
- Inputs in this app are flat (`#e2e6f0` background), never inset; neumorphic shadow only on cards and buttons.
- Tests: `bun test` (whole suite) and `bun test test/<file>.test.ts` (one file). One test file per module in `test/`, `bun:test` API, existing fixture helpers (`test/support/scratch-git-repo.ts`).
- Typecheck: there is no `bun run typecheck` script. Before each commit `bunx tsc -p tsconfig.shell.json` and `bun run typecheck:studio` must both exit 0. Wherever a step below says `bun run typecheck`, run these two. When a task adds a client module the shell loads (e.g. `client/flow-drawer.ts`, `client/flow-graph.ts`), add it to `tsconfig.shell.json`'s `include`.
- Baseline on the branch before Task 1: `bun test` = 966 pass, 0 fail.
- Commit messages: conventional (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`), no `Co-Authored-By` trailer.
- Never `git merge`; never push. Each task ends with one commit.
- Approval source rule: a request whose `sec-fetch-site` header equals `same-origin` came from the cockpit page in a browser → `'drawer'` (or `'user'` for a start). Anything else (curl from a session AI, with or without a Bearer token) → `'conversation'`. This records honestly; it is not a security boundary.
- Run statuses after this plan: `'awaiting-approval' | 'running' | 'paused' | 'done' | 'failed' | 'blocked' | 'stopped'`. "Live" = the first three.

## Review Focus

1. Double approval (drawer click and a relayed "go" at nearly the same time) → exactly one approval recorded, the second call gets 409, the entry step is dispatched once. Test in Task 2.
2. A job finishing while its run is paused → the result is recorded and the run points at the next step, but nothing new starts until Resume. Test in Task 2.
3. Server restart while a run waits for approval or is paused → the workspace stays claimed and the run keeps its status (no auto-dispatch). Test in Task 2.
4. A session AI relaying approval for a run that belongs to a different chat / terminal → 403, nothing changes. Test in Task 3.
5. SSE client disconnects (tab closed) → the subscription and heartbeat timer are released; no writes to a closed stream. Test in Task 4.

---

### Task 1: `flowApproval` setting

**Files:**
- Modify: `server/secrets.ts:36-40` (`AppConfig`), `server/secrets.ts:145-152` (`readConfig`)
- Modify: `server/routes/roles.ts` (add routes after `rolesRoutes` definition, same file)
- Test: `test/roles-routes.test.ts` (find the existing roles route test with `rg -l "rolesRoutes" test/`; add there, or create `test/flow-approval.test.ts` if none exists)

**Interfaces:**
- Produces: `AppConfig.flowApproval: boolean` (default `true` when missing); `GET /api/flow-approval` → `{ flowApproval: boolean }`; `PUT /api/flow-approval` body `{ flowApproval: boolean }` → same shape, 400 on anything else. Local-only (no `allowToken` entry).

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowApprovalRoutes } from '../server/routes/roles'
import { readConfig } from '../server/secrets'

let dir: string
const local = (method: string, body?: unknown) => new Request('http://127.0.0.1:7777/api/flow-approval', { method, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: body === undefined ? undefined : JSON.stringify(body) })
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-flow-approval-')); process.env.MISSION_CONTROL_CONFIG_DIR = dir })
afterEach(async () => { delete process.env.MISSION_CONTROL_CONFIG_DIR; await rm(dir, { recursive: true, force: true }) })

test('flow approval defaults to on and can be turned off and back on', async () => {
  expect((await readConfig()).flowApproval).toBe(true)
  expect(await (await flowApprovalRoutes.handle(local('GET'))).json()).toEqual({ flowApproval: true })
  expect(await (await flowApprovalRoutes.handle(local('PUT', { flowApproval: false }))).json()).toEqual({ flowApproval: false })
  expect((await readConfig()).flowApproval).toBe(false)
  expect(await (await flowApprovalRoutes.handle(local('PUT', { flowApproval: true }))).json()).toEqual({ flowApproval: true })
})

test('flow approval rejects a non-boolean value and keeps the old one', async () => {
  const response = await flowApprovalRoutes.handle(local('PUT', { flowApproval: 'off' }))
  expect(response.status).toBe(400)
  expect((await readConfig()).flowApproval).toBe(true)
})

test('flow approval is not reachable with a Bearer token from a non-local host', async () => {
  const response = await flowApprovalRoutes.handle(new Request('http://example.com/api/flow-approval', { headers: { host: 'example.com', authorization: 'Bearer x' } }))
  expect(response.status).toBe(403)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/flow-approval.test.ts`
Expected: FAIL — `flowApprovalRoutes` is not exported.

- [ ] **Step 3: Implement**

`server/secrets.ts`: add `flowApproval: boolean` to `AppConfig`; in `readConfig` add `flowApproval: raw.flowApproval !== false,`.

`server/routes/roles.ts`, after `rolesRoutes`:

```ts
export const flowApprovalRoutes = new Elysia()
  .onBeforeHandle(requireLocal)
  .get('/api/flow-approval', async () => ({ flowApproval: (await readConfig()).flowApproval }))
  .put('/api/flow-approval', async ({ body, set }) => {
    const value = (body as { flowApproval?: unknown } | null)?.flowApproval
    if (typeof value !== 'boolean') { set.status = 400; return { error: 'flowApproval must be true or false' } }
    return { flowApproval: (await writeConfig({ flowApproval: value })).flowApproval }
  })
```

Import `writeConfig` if the file does not already. Mount it in `server/index.ts` next to where `rolesRoutes` is `.use(...)`d (`rg -n "rolesRoutes" server/index.ts`).

- [ ] **Step 4: Run tests**

Run: `bun test test/flow-approval.test.ts && bun test` — all pass. `bun run typecheck` passes.

- [ ] **Step 5: Commit**

```bash
git add server/secrets.ts server/routes/roles.ts server/index.ts test/flow-approval.test.ts
git commit -m "feat(settings): flow approval switch, on by default"
```

---

### Task 2: Runner — approval, versions, origin, pause, change hook

**Files:**
- Modify: `server/workflow-runner.ts` (types :27-39, `createWorkflowRunner` deps :73, `persist` :88-94, `finish` :99-104, `workspaceBusy` :108-110, `start` :198-221, `settle` :249-283, `onJobSettled` :285-293, `stop` :294-307, `retry` :308-324, `recover` :325-337, return :346)
- Test: `test/workflow-runner.test.ts`

**Interfaces:**
- Consumes: `readConfig().flowApproval` (Task 1).
- Produces (exported from `server/workflow-runner.ts`):

```ts
export type RunStatus = 'awaiting-approval' | 'running' | 'paused' | 'done' | 'failed' | 'blocked' | 'stopped'
export type ApprovalVia = 'user' | 'drawer' | 'conversation' | 'auto'
export type RunVersion = { number: number; revision: string; reason: string; size: 'initial' | 'small' | 'big'; state: 'pending' | 'approved' | 'rejected'; approvedVia: ApprovalVia | null; relayedBy: string | null; at: number }
export type RunOrigin = { source: 'saved' | 'drafted'; by: string; where: 'chat' | 'terminal' | 'studio' }
export type ApprovalContext = { via: 'drawer' | 'conversation'; chat?: string; terminalId?: string }
export class RunActionError extends Error { constructor(message: string, readonly status: 403 | 404 | 409) { super(message) } }
export const LIVE_STATUSES: ReadonlySet<RunStatus>
// WorkflowRun gains: status: RunStatus; origin: RunOrigin; versions: RunVersion[]
// runner gains: start(value, context?: { startedByUser: boolean }), approve(id, ctx), reject(id, ctx), pause(id), resume(id)
// deps gains: requireApproval?: () => Promise<boolean>  (default: async () => (await readConfig()).flowApproval)
//             onChange?: (run: WorkflowRun) => void      (called after every persist, with a structuredClone)
```

- [ ] **Step 1: Make existing tests independent of the setting**

In `test/workflow-runner.test.ts` `build()` (line ~38), pass `requireApproval: async () => false` to `createWorkflowRunner`, and add an optional second parameter `approval = false` so new tests can call `build(resolver, true)`:

```ts
function build(agent: EngineResolver = resolver, approval = false) {
  ...
  runner = createWorkflowRunner({ manager, resolver: agent, store, base: dir, requireApproval: async () => approval, onRunSettled: run => { settled.push(run) } })
  return store
}
```

Add a helper under `finished`:

```ts
async function until(id: string, predicate: (run: WorkflowRun) => boolean) {
  for (let i = 0; i < 200; i++) { const run = runner.get(id)!; if (predicate(run)) return run; await Bun.sleep(20) }
  throw new Error('Run never reached the expected state')
}
```

`finished()` must treat live statuses as unfinished: change its check to `if (!['running', 'paused', 'awaiting-approval'].includes(run.status)) return run`.

- [ ] **Step 2: Write the failing tests**

```ts
test('a run started by a session AI waits for approval and dispatches nothing', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  expect(started.status).toBe('awaiting-approval')
  expect(started.versions).toEqual([expect.objectContaining({ number: 1, state: 'pending', approvedVia: null, size: 'initial' })])
  expect(started.origin).toEqual({ source: 'saved', by: 'you', where: 'studio' })
  await Bun.sleep(100)
  expect(manager.listJobs()).toHaveLength(0)
})

test('approving from the drawer records the source and runs the flow', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  const approved = await runner.approve(started.id, { via: 'drawer' })
  expect(approved.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'drawer', relayedBy: null }))
  expect((await finished(started.id)).status).toBe('done')
})

test('a second approval of the same version is a conflict and dispatches once', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement the fixture', label: 'fixture' })
  const results = await Promise.allSettled([runner.approve(started.id, { via: 'drawer' }), runner.approve(started.id, { via: 'drawer' })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  expect((rejected.reason as RunActionError).status).toBe(409)
  const done = await finished(started.id)
  expect(done.attempts.filter(attempt => attempt.nodeId === 'plan')).toHaveLength(1)
})

test('a relayed approval must come from the session that owns the run', async () => {
  const store = build(resolver, true)
  const first = await store.save({ ...defaultWorkflow(), id: 'terminal-workflow', name: 'Terminal workflow' })
  const terminal: TerminalRecord = { id: 'terminal-a', engine: 'codex', cwd: repo, pid: 1, createdAt: 0, title: 'Terminal', sessionId: null, workflow: { id: first.id, name: first.name, revision: first.revision, selectedDefault: true } }
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, terminals: { get: id => id === terminal.id ? terminal : undefined }, requireApproval: async () => true })
  const started = await runner.start({ terminalId: 'terminal-a', cwd: repo, request: 'Implement', label: 'fixture' })
  expect(started.origin).toEqual({ source: 'saved', by: 'codex', where: 'terminal' })
  await expect(runner.approve(started.id, { via: 'conversation', terminalId: 'terminal-b' })).rejects.toMatchObject({ status: 403 })
  const approved = await runner.approve(started.id, { via: 'conversation', terminalId: 'terminal-a' })
  expect(approved.versions[0]).toEqual(expect.objectContaining({ approvedVia: 'conversation', relayedBy: 'codex' }))
})

test('rejecting the first version stops the run and frees the workspace', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const rejected = await runner.reject(started.id, { via: 'drawer' })
  expect(rejected.status).toBe('stopped')
  expect(rejected.versions[0]!.state).toBe('rejected')
  const next = await runner.start({ cwd: repo, request: 'Again', label: 'second' })
  expect(next.status).toBe('awaiting-approval')
})

test('runs the user starts from the browser, or with approval off, start at once', async () => {
  build(resolver, true)
  const byUser = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' }, { startedByUser: true })
  expect(byUser.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'user' }))
  await finished(byUser.id)
  build(resolver, false)
  const auto = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  expect(auto.versions[0]).toEqual(expect.objectContaining({ state: 'approved', approvedVia: 'auto' }))
  await finished(auto.id)
})

test('a paused run records the finished step but starts nothing new until resumed', async () => {
  const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.3; echo '${report()}'`], env: {} })
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const paused = await runner.pause(started.id)
  expect(paused.status).toBe('paused')
  const moved = await until(started.id, run => run.attempts[0]?.status === 'settled')
  expect(moved.status).toBe('paused')
  expect(moved.currentNodeId).toBe('verify-plan')
  await Bun.sleep(200)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
  await runner.resume(started.id)
  expect((await finished(started.id)).status).toBe('done')
})

test('after a restart a waiting or paused run keeps its status and its workspace', async () => {
  const store = build(resolver, true)
  const waiting = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => true })
  await reloaded.recover()
  expect(reloaded.get(waiting.id)!.status).toBe('awaiting-approval')
  await expect(reloaded.start({ cwd: repo, request: 'Other', label: 'other' })).rejects.toThrow('Workspace already has running work')
})

test('a rejected first version cannot be retried into running', async () => {
  build(resolver, true)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.reject(started.id, { via: 'drawer' })
  await expect(runner.retry(started.id)).rejects.toMatchObject({ status: 409 })
  expect(manager.listJobs()).toHaveLength(0)
})

test('pausing takes effect at once, even while a step is settling', async () => {
  const slow: EngineResolver = () => ({ cmd: '/bin/sh', args: ['-c', `sleep 0.2; echo '${report()}'`], env: {} })
  build(slow, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  const pausing = runner.pause(started.id)
  expect(runner.get(started.id)!.status).toBe('paused')
  await pausing
  await until(started.id, run => run.attempts[0]?.status === 'settled')
  await Bun.sleep(150)
  expect(runner.get(started.id)!.attempts).toHaveLength(1)
})

test('a run paused between steps survives a restart still paused', async () => {
  const store = build(resolver, false)
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.pause(started.id)
  await until(started.id, run => run.attempts.at(-1)?.status === 'settled')
  const reloaded = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => false })
  await reloaded.recover()
  expect(reloaded.get(started.id)!.status).toBe('paused')
  await reloaded.resume(started.id)
})

test('every persisted change is reported through onChange', async () => {
  const store = createWorkflowStore(dir)
  manager = createJobManager({ onJobSettled: job => { void runner.onJobSettled(job) } })
  const seen: string[] = []
  runner = createWorkflowRunner({ manager, resolver, store, base: dir, requireApproval: async () => true, onChange: run => { seen.push(run.status) } })
  const started = await runner.start({ cwd: repo, request: 'Implement', label: 'fixture' })
  await runner.approve(started.id, { via: 'drawer' })
  await finished(started.id)
  expect(seen[0]).toBe('awaiting-approval')
  expect(seen).toContain('running')
  expect(seen.at(-1)).toBe('done')
})
```

Import `RunActionError` in the test file.

- [ ] **Step 3: Run to see them fail**

Run: `bun test test/workflow-runner.test.ts`
Expected: the new tests FAIL (unknown fields / methods); existing tests still PASS after Step 1.

- [ ] **Step 4: Implement in `server/workflow-runner.ts`**

1. Add the exported types and class from **Interfaces**. `export const LIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['awaiting-approval', 'running', 'paused'])`. Change `WorkflowRun.status` to `RunStatus`; add `origin: RunOrigin; versions: RunVersion[]`.
2. Deps: add `requireApproval?: () => Promise<boolean>; onChange?: (run: WorkflowRun) => void`. Inside: `const requireApproval = deps.requireApproval ?? (async () => (await readConfig()).flowApproval)`.
3. On load from disk (the `readdirSync` loop), backfill older records: `record.origin ??= { source: 'saved', by: 'you', where: record.terminalId ? 'terminal' : record.chatId ? 'chat' : 'studio' }; record.versions ??= [{ number: 1, revision: record.workflow.revision, reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'user', relayedBy: null, at: record.createdAt }]`.
4. `persist`: replace `run.status !== 'running'` with `!LIVE_STATUSES.has(run.status)`; after `runs.set(...)` call `deps.onChange?.(structuredClone(run))`.
5. `finish`: `const wasLive = LIVE_STATUSES.has(run.status)`; use `wasLive` for `onRunSettled`. Its status parameter type becomes `Exclude<RunStatus, 'awaiting-approval' | 'running' | 'paused'>`.
6. `workspaceBusy`: `LIVE_STATUSES.has(run.status)` instead of `run.status === 'running'`.
7. `start(value, context = { startedByUser: false })`:
   - Terminal pin is a default, not a lock: delete the `throw new Error('This terminal uses a pinned workflow…')` line. Workflow resolution becomes `input.workflowId ? await deps.store.get(input.workflowId, input.revision) : selection ? await deps.store.get(selection.id, selection.revision) : await deps.store.selected()`.
   - `const by = terminal?.engine ?? (input.chat ? deps.manager.getJob(input.chat)?.engine : undefined) ?? 'you'`; `const where = terminal ? 'terminal' : input.chat ? 'chat' : 'studio'`.
   - `const waits = !context.startedByUser && await requireApproval()`.
   - Run literal: `status: waits ? 'awaiting-approval' : 'running'`, `origin: { source: 'saved', by, where }`, `versions: [{ number: 1, revision: workflow.revision, reason: 'Initial flow', size: 'initial', state: waits ? 'pending' : 'approved', approvedVia: waits ? null : context.startedByUser ? 'user' : 'auto', relayedBy: null, at: Date.now() }]`.
   - After `persist(run)`: `if (!waits) await exclusive(run.id, () => dispatch(run))`.
8. New functions (all inside `exclusive(id, …)` so concurrent calls serialize):

```ts
function owned(run: WorkflowRun, context: ApprovalContext): void {
  if (context.via !== 'conversation') return
  const matches = (context.chat && context.chat === run.chatId) || (context.terminalId && context.terminalId === run.terminalId)
  if (!matches) throw new RunActionError('This flow belongs to a different session', 403)
}
function pendingVersion(run: WorkflowRun): RunVersion {
  const version = run.versions.find(version => version.state === 'pending')
  if (!version) throw new RunActionError('Nothing is waiting for approval', 409)
  return version
}
function mustGet(id: string): WorkflowRun {
  const run = runs.get(id)
  if (!run) throw new RunActionError('Run not found', 404)
  return run
}
async function approve(id: string, context: ApprovalContext): Promise<WorkflowRun> {
  return exclusive(id, async () => {
    const run = mustGet(id)
    owned(run, context)
    const version = pendingVersion(run)
    Object.assign(version, { state: 'approved', approvedVia: context.via, relayedBy: context.via === 'conversation' ? run.origin.by : null, at: Date.now() })
    if (run.status === 'awaiting-approval') { run.status = 'running'; await persist(run); await dispatch(run) } else await persist(run)
    return structuredClone(run)
  })
}
async function reject(id: string, context: ApprovalContext): Promise<WorkflowRun> {
  return exclusive(id, async () => {
    const run = mustGet(id)
    owned(run, context)
    const version = pendingVersion(run)
    Object.assign(version, { state: 'rejected', at: Date.now() })
    if (run.status === 'awaiting-approval') await finish(run, 'stopped', 'Flow rejected')
    else await persist(run)
    return structuredClone(run)
  })
}
async function pause(id: string): Promise<WorkflowRun> {
  const run = mustGet(id)
  if (run.status !== 'running') throw new RunActionError('Only a running flow can be paused', 409)
  run.status = 'paused'
  return exclusive(id, async () => { await persist(run); return structuredClone(run) })
}
async function resume(id: string): Promise<WorkflowRun> {
  return exclusive(id, async () => {
    const run = mustGet(id)
    if (run.status !== 'paused') throw new RunActionError('Only a paused flow can be resumed', 409)
    run.status = 'running'
    await persist(run)
    const last = run.attempts.at(-1)
    if (!last || last.status === 'settled') await dispatch(run)
    return structuredClone(run)
  })
}
```

`pause` sets the status before entering `exclusive` on purpose: queued behind a settling step (and its acceptance checks), the step would dispatch the next one first. Its test "pausing takes effect at once" pins this.

9. `settle`: first line becomes `if ((run.status !== 'running' && run.status !== 'paused') || stopping.has(run.id)) return`. In the `if (edge)` branch replace `await dispatch(run)` with `if (run.status === 'running') await dispatch(run)`.
10. `onJobSettled`: `if (run.status !== 'running' && run.status !== 'paused') await persist(run); else await settle(run, record)`.
11. `stop`: `if (!LIVE_STATUSES.has(run.status)) throw new Error('Run is not running')`. For a run awaiting approval also mark its pending version `rejected`.
12. `retry`: `if (LIVE_STATUSES.has(run.status) || run.status === 'done') throw …` (message unchanged), then `if (run.versions[0]?.state !== 'approved') throw new RunActionError('Approve the flow before retrying', 409)`.
13. `recover`: at the top of the loop: `if (run.status === 'awaiting-approval' || (run.status === 'paused' && run.attempts.at(-1)?.status !== 'running' && run.attempts.at(-1)?.status !== 'starting')) { if (!deps.manager.claimWorkspace(run.cwd, run.id)) await block(run, 'Another run owns this workspace'); continue }` — a run waiting for approval, or paused between steps, keeps its status. Change the existing `run.status !== 'running'` guard to `run.status !== 'running' && run.status !== 'paused'`. A run paused while a step was still running then re-attaches the job as today; `onJobSettled` → `settle` will not dispatch because the run is paused.
14. Return object: add `approve, reject, pause, resume`.

Then fix every other reader of a run's status (found by review, verified):
- `server/chat-reports.ts:76` `runNeedsReport`: `run.status !== 'running'` → `!LIVE_STATUSES.has(run.status)`. Otherwise a waiting or paused run is reported to the chat as finished and marked reported, and its real completion is never reported. Add to its test file (`rg -ln "runNeedsReport" test/`): a run with `status: 'awaiting-approval'` or `'paused'` and `reportedAt: null` → `false`.
- `client/studio-graph.ts:43` `nodeRunStates`: return `{}` only when the status is not `running` and not `paused` (pausing must keep the canvas highlights). Add a `test/studio-graph.test.ts` example for a paused run.
- `client/studio.tsx:108` canvas highlight condition, `:139` live-run filter, `:151` detail poll: treat `running`, `paused` and `awaiting-approval` as live.
- `client/studio.tsx:258` run actions: show "Stop run" for the three live statuses; "Retry current step" only for `failed`, `blocked` and `stopped`.
- Then `rg -n "status === 'running'|status !== 'running'" server client` and check each remaining hit is about a job, not a run.

- [ ] **Step 5: Run tests**

Run: `bun test test/workflow-runner.test.ts && bun test && bun run typecheck && bun run typecheck:studio`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/workflow-runner.ts test/workflow-runner.test.ts server/chat-reports.ts client/studio.tsx client/studio-graph.ts test/studio-graph.test.ts <chat-reports test file>
git commit -m "feat(runner): flows wait for one approval, can pause, report every change"
```

(Add any other file Step 4's grep touched.)

---

### Task 3: Studio routes — approve / reject / pause / resume, scoped list, token access

**Files:**
- Modify: `server/routes/studio.ts:63-71`
- Modify: `server/auth.ts:12-14` (`allowToken`)
- Test: `test/studio-routes.test.ts`, `test/api-token-auth.test.ts`

**Interfaces:**
- Consumes: `runner.start(value, { startedByUser })`, `approve`, `reject`, `pause`, `resume`, `RunActionError` (Task 2).
- Produces:
  - `GET /api/studio/runs?chat=<id>&terminal=<id>` → `{ runs: RunSummary[] }`, where `RunSummary` adds `status`, `origin`, `pending: boolean` (a version is pending) to today's fields, filtered by the optional query params.
  - `POST /api/studio/runs/:id/approve|reject` body `{ chat?: string; terminalId?: string }` → the run.
  - `POST /api/studio/runs/:id/pause|resume` → the run.
  - Errors from `RunActionError` return its `status` and `{ error }`.
  - `export function fromBrowser(request: Request): boolean` in `server/local-access.ts`: `request.headers.get('sec-fetch-site') === 'same-origin'`.

- [ ] **Step 1: Write the failing tests** (in `test/studio-routes.test.ts`, following that file's existing setup for building the app and runner; reuse its helpers)

```ts
test('a browser start is approved by the user; a CLI start waits', async () => {
  const browser = await post('/api/studio/runs', body, { 'sec-fetch-site': 'same-origin' })
  expect((await browser.json()).versions[0].approvedVia).toBe('user')
  const cli = await post('/api/studio/runs', { ...body, label: 'cli' }, {})
  expect((await cli.json()).status).toBe('awaiting-approval')
})

test('approve records drawer for browser requests and conversation for CLI requests', async () => {
  const run = await (await post('/api/studio/runs', body, {})).json()
  const approved = await (await post(`/api/studio/runs/${run.id}/approve`, {}, { 'sec-fetch-site': 'same-origin' })).json()
  expect(approved.versions[0].approvedVia).toBe('drawer')
})

test('a relayed approval for another session is refused with 403', async () => {
  const run = await (await post('/api/studio/runs', { ...body, chat: chatId }, {})).json()
  const response = await post(`/api/studio/runs/${run.id}/approve`, { chat: 'someone-else' }, {})
  expect(response.status).toBe(403)
})

test('approving twice answers 409 the second time', async () => {
  const run = await (await post('/api/studio/runs', body, {})).json()
  await post(`/api/studio/runs/${run.id}/approve`, {}, { 'sec-fetch-site': 'same-origin' })
  expect((await post(`/api/studio/runs/${run.id}/approve`, {}, { 'sec-fetch-site': 'same-origin' })).status).toBe(409)
})

test('the run list filters by chat and terminal', async () => {
  const list = await (await get(`/api/studio/runs?chat=${chatId}`)).json()
  expect(list.runs.every((run: { id: string }) => chatRunIds.includes(run.id))).toBe(true)
})
```

Adapt `post`, `get`, `body`, `chatId`, `chatRunIds` to the file's existing fixtures: `body` = `{ cwd: repo, request: 'x', label: 'fixture' }`; build the runner with `requireApproval: async () => true`. For `chat`, create a chat root job the way `test/workflow-runner.test.ts` does for its chat tests (`rg -n "purpose: 'chat'" test/workflow-runner.test.ts`).

In `test/api-token-auth.test.ts` add: `allowToken('/api/studio/runs/abc/approve', 'POST')`, `…/reject`, `…/pause`, `…/resume` are `true`; `allowToken('/api/flow-approval', 'PUT')` and `allowToken('/api/studio/events', 'GET')` are `false`.

- [ ] **Step 2: Run to see them fail** — `bun test test/studio-routes.test.ts test/api-token-auth.test.ts`

- [ ] **Step 3: Implement**

`server/local-access.ts`: add `fromBrowser` (Interfaces).

`server/auth.ts` line 14 becomes:

```ts
  if (/^\/api\/studio\/runs\/[^/]+\/(stop|retry|approve|reject|pause|resume)$/.test(pathname)) return upperMethod === 'POST'
```

`server/routes/studio.ts`: change `.onError` to honour `RunActionError`:

```ts
    .onError(({ error, set }) => {
      set.status = error instanceof RunActionError ? error.status : 400
      return { error: error instanceof Error ? error.message : 'Studio request failed' }
    })
```

and replace the run routes (lines 63-71) with:

```ts
    .get('/api/studio/runs', ({ query }) => ({ runs: runner.list()
      .filter(run => (!query.chat || run.chatId === query.chat) && (!query.terminal || run.terminalId === query.terminal))
      .map(run => ({ id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision, currentNodeId: run.currentNodeId, createdAt: run.createdAt, origin: run.origin, pending: run.versions.some(version => version.state === 'pending') })) }))
    .post('/api/studio/runs', ({ body, request }) => runner.start(body, { startedByUser: fromBrowser(request) }))
    .get('/api/studio/runs/:id', ({ params, set }) => {
      const run = runner.get(params.id)
      if (!run) { set.status = 404; return { error: 'Run not found' } }
      return run
    })
    .post('/api/studio/runs/:id/approve', ({ params, body, request }) => runner.approve(params.id, approvalContext(request, body)))
    .post('/api/studio/runs/:id/reject', ({ params, body, request }) => runner.reject(params.id, approvalContext(request, body)))
    .post('/api/studio/runs/:id/pause', ({ params }) => runner.pause(params.id))
    .post('/api/studio/runs/:id/resume', ({ params }) => runner.resume(params.id))
    .post('/api/studio/runs/:id/stop', ({ params }) => runner.stop(params.id))
    .post('/api/studio/runs/:id/retry', ({ params }) => runner.retry(params.id))
```

with, at module level:

```ts
const sessionBody = z.object({ chat: z.string().min(1).max(200).optional(), terminalId: identifier.optional(), version: z.number().int().min(1).optional() }).default({})
function approvalContext(request: Request, body: unknown): ApprovalContext {
  const { version, ...session } = sessionBody.parse(body ?? {})
  return fromBrowser(request) ? { via: 'drawer', ...(version ? { version } : {}) } : { via: 'conversation', ...session, ...(version ? { version } : {}) }
}
```

`ApprovalContext` (Task 2) gains `version?: number`. In Task 2's `pendingVersion(run)` callers (`approve`, `reject`), after finding the pending version: `if (context.version !== undefined && context.version !== version.number) throw new RunActionError('That version is no longer waiting', 409)`. The drawer always sends the version number it showed; a session AI may omit it. Add to `test/studio-routes.test.ts`:

```ts
test('approving a version that is not the pending one answers 409', async () => {
  const run = await (await post('/api/studio/runs', body, {})).json()
  expect((await post(`/api/studio/runs/${run.id}/approve`, { version: 2 }, { 'sec-fetch-site': 'same-origin' })).status).toBe(409)
  expect((await post(`/api/studio/runs/${run.id}/approve`, { version: 1 }, { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
})
```

- [ ] **Step 4: Run tests** — `bun test && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add server/routes/studio.ts server/auth.ts server/local-access.ts test/studio-routes.test.ts test/api-token-auth.test.ts
git commit -m "feat(studio): approve, reject, pause and resume flows; source comes from the caller"
```

---

### Task 4: Live push — run events, scope snapshot, SSE

**Files:**
- Create: `server/run-events.ts`, `server/run-view.ts`
- Modify: `server/routes/studio.ts` (events route), `server/index.ts` (wiring, lines ~153-182)
- Test: `test/run-events.test.ts`, `test/run-view.test.ts`

**Interfaces:**
- Consumes: `WorkflowRun`, `RunVersion`, `RunOrigin`, `LIVE_STATUSES` (Task 2); `JobRecord` from `server/jobs.ts`.
- Produces:

```ts
// server/run-events.ts
export type RunEvents = { changed(): void; subscribe(listener: () => void): () => void }
export function createRunEvents(): RunEvents
export function eventStreamResponse(events: RunEvents, snapshot: () => unknown, signal: AbortSignal, options?: { debounceMs?: number; heartbeatMs?: number }): Response

// server/run-view.ts
export type Scope = { chat?: string; terminal?: string }
export type RunStepView = { id: string; title: string; kind: string; engine: string }
export type RunAttemptView = { nodeId: string; number: number; jobId: string | null; status: string; outcome: 'pass' | 'fail' | 'blocked' | null; summary: string | null; startedAt: number; endedAt: number | null }
export type RunView = { id: string; label: string; status: string; error: string | null; workflowName: string; revision: string; entry: string; currentNodeId: string; origin: RunOrigin; versions: RunVersion[]; nodes: RunStepView[]; edges: { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked' }[]; attempts: RunAttemptView[]; createdAt: number; updatedAt: number }
export type QuickJobView = { id: string; label: string; engine: string; status: string; startedAt: number; endedAt: number | null }
export type ScopeSnapshot = { runs: RunView[]; jobs: QuickJobView[] }
export function runView(run: WorkflowRun): RunView
export function scopeSnapshot(runs: WorkflowRun[], jobs: JobRecord[], scope: Scope): ScopeSnapshot
// GET /api/studio/events?chat=|terminal=  (local only; SSE `data: <ScopeSnapshot JSON>`)
```

- [ ] **Step 1: Write the failing tests**

`test/run-view.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { defaultWorkflow } from '../server/workflows'
import { runView, scopeSnapshot } from '../server/run-view'
import type { WorkflowRun } from '../server/workflow-runner'
import type { JobRecord } from '../server/jobs'

const workflow = { ...defaultWorkflow(), revision: 'r1', createdAt: 0 }
const run = (patch: Partial<WorkflowRun>): WorkflowRun => ({ id: 'run-1', label: 'Add export', cwd: '/x', request: 'secret request text', workflow, policy: { revision: 'p', template: 't', coreRules: 'c', implementationRules: 'i', createdAt: 0 }, agents: Object.fromEntries(workflow.nodes.map(node => [node.id, { engine: node.id === 'review' ? 'codex' : 'claude', model: null, family: null }])), skills: {}, status: 'running', error: null, currentNodeId: 'execute', attempts: [{ nodeId: 'plan', number: 0, jobId: 'j1', status: 'settled', prompt: 'long prompt', startedAt: 1, endedAt: 2, result: { outcome: 'pass', summary: 'Planned', evidence: ['e'] }, checks: [], output: 'long output', workspace: null }], createdAt: 0, updatedAt: 3, origin: { source: 'saved', by: 'codex', where: 'terminal' }, versions: [], terminalId: 't1', ...patch })
const job = (patch: Partial<JobRecord>) => ({ id: 'j', label: 'Fix badge', engine: 'codex', status: 'done', startedAt: 1, endedAt: 2, cwd: '/x', ...patch }) as JobRecord

test('run view keeps what the drawer draws and drops prompts, outputs and policy', () => {
  const view = runView(run({}))
  expect(view.nodes.map(node => [node.id, node.engine])).toEqual([['plan', 'claude'], ['verify-plan', 'claude'], ['execute', 'claude'], ['review', 'codex']])
  expect(view.attempts[0]).toEqual({ nodeId: 'plan', number: 0, jobId: 'j1', status: 'settled', outcome: 'pass', summary: 'Planned', startedAt: 1, endedAt: 2 })
  expect(JSON.stringify(view)).not.toContain('long prompt')
  expect(JSON.stringify(view)).not.toContain('long output')
  expect(JSON.stringify(view)).not.toContain('secret request text')
})

test('scope snapshot picks the terminal or chat runs, newest first, and flow-less jobs', () => {
  const snapshot = scopeSnapshot([run({ id: 'old', createdAt: 1 }), run({ id: 'new', createdAt: 5 }), run({ id: 'other', terminalId: 't2' })], [job({ id: 'quick', terminalId: 't1' }), job({ id: 'step', terminalId: 't1', workflowRunId: 'new' }), job({ id: 'elsewhere', terminalId: 't2' })], { terminal: 't1' })
  expect(snapshot.runs.map(view => view.id)).toEqual(['new', 'old'])
  expect(snapshot.jobs.map(view => view.id)).toEqual(['quick'])
})

test('chat scope matches runs by chat id and skips the chat turns themselves', () => {
  const snapshot = scopeSnapshot([run({ id: 'c', terminalId: undefined, chatId: 'chat-1' })], [job({ id: 'turn', chatId: 'chat-1', purpose: 'chat' }), job({ id: 'agent', chatId: 'chat-1' })], { chat: 'chat-1' })
  expect(snapshot.runs.map(view => view.id)).toEqual(['c'])
  expect(snapshot.jobs.map(view => view.id)).toEqual(['agent'])
})

test('an empty scope sees nothing', () => {
  expect(scopeSnapshot([run({})], [job({ terminalId: 't1' })], {})).toEqual({ runs: [], jobs: [] })
})
```

`test/run-events.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { createRunEvents, eventStreamResponse } from '../server/run-events'

async function read(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  let buffer = ''
  while (frames.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
    const parts = buffer.split('\n\n'); buffer = parts.pop()!
    frames.push(...parts.filter(part => part.startsWith('data: ')).map(part => part.slice(6)))
  }
  reader.releaseLock()
  return frames
}

test('sends a snapshot at once, then again after a change, skipping identical ones', async () => {
  const events = createRunEvents()
  let value = 1
  const controller = new AbortController()
  const response = eventStreamResponse(events, () => ({ value }), controller.signal, { debounceMs: 5 })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const first = read(response, 2)
  events.changed()
  await Bun.sleep(20)
  value = 2
  events.changed()
  expect(await first).toEqual(['{"value":1}', '{"value":2}'])
  controller.abort()
})

test('a steady stream of changes still sends a snapshot within one window', async () => {
  const events = createRunEvents()
  let value = 0
  const controller = new AbortController()
  const response = eventStreamResponse(events, () => ({ value }), controller.signal, { debounceMs: 20 })
  const frames = read(response, 2)
  const noise = setInterval(() => { value++; events.changed() }, 5)
  const got = await Promise.race([frames, Bun.sleep(200).then(() => null)])
  clearInterval(noise)
  controller.abort()
  expect(got).not.toBeNull()
})

test('closing the connection unsubscribes and stops the heartbeat', async () => {
  const events = createRunEvents()
  const controller = new AbortController()
  let snapshots = 0
  eventStreamResponse(events, () => { snapshots++; return { snapshots } }, controller.signal, { debounceMs: 1, heartbeatMs: 5 })
  controller.abort()
  const before = snapshots
  events.changed()
  await Bun.sleep(30)
  expect(snapshots).toBe(before)
})
```

- [ ] **Step 2: Run to see them fail** — `bun test test/run-view.test.ts test/run-events.test.ts`

- [ ] **Step 3: Implement**

`server/run-events.ts`:

```ts
export type RunEvents = { changed(): void; subscribe(listener: () => void): () => void }

export function createRunEvents(): RunEvents {
  const listeners = new Set<() => void>()
  return {
    changed: () => { for (const listener of listeners) listener() },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

export function eventStreamResponse(events: RunEvents, snapshot: () => unknown, signal: AbortSignal, options: { debounceMs?: number; heartbeatMs?: number } = {}): Response {
  const encoder = new TextEncoder()
  let last = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let unsubscribe = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => { if (!signal.aborted) controller.enqueue(encoder.encode(text)) }
      const send = () => { const text = JSON.stringify(snapshot()); if (text === last) return; last = text; write(`data: ${text}\n\n`) }
      const close = () => { unsubscribe(); clearTimeout(timer); clearInterval(heartbeat); try { controller.close() } catch {} }
      if (signal.aborted) { close(); return }
      send()
      unsubscribe = events.subscribe(() => { if (!timer) timer = setTimeout(() => { timer = undefined; send() }, options.debounceMs ?? 100) })
      heartbeat = setInterval(() => write(': ping\n\n'), options.heartbeatMs ?? 15000)
      signal.addEventListener('abort', close, { once: true })
    },
    cancel() { unsubscribe(); clearTimeout(timer); clearInterval(heartbeat) },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
}
```

`server/run-view.ts`:

```ts
import type { JobRecord } from './jobs'
import type { RunOrigin, RunVersion, WorkflowRun } from './workflow-runner'

export type Scope = { chat?: string; terminal?: string }
export type RunStepView = { id: string; title: string; kind: string; engine: string }
export type RunAttemptView = { nodeId: string; number: number; jobId: string | null; status: string; outcome: 'pass' | 'fail' | 'blocked' | null; summary: string | null; startedAt: number; endedAt: number | null }
export type RunView = { id: string; label: string; status: string; error: string | null; workflowName: string; revision: string; entry: string; currentNodeId: string; origin: RunOrigin; versions: RunVersion[]; nodes: RunStepView[]; edges: { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked' }[]; attempts: RunAttemptView[]; createdAt: number; updatedAt: number }
export type QuickJobView = { id: string; label: string; engine: string; status: string; startedAt: number; endedAt: number | null }
export type ScopeSnapshot = { runs: RunView[]; jobs: QuickJobView[] }

export function runView(run: WorkflowRun): RunView {
  return {
    id: run.id, label: run.label, status: run.status, error: run.error, workflowName: run.workflow.name, revision: run.workflow.revision,
    entry: run.workflow.entry, currentNodeId: run.currentNodeId, origin: run.origin, versions: run.versions,
    nodes: run.workflow.nodes.map(node => ({ id: node.id, title: node.title, kind: node.kind, engine: run.agents[node.id]?.engine ?? '' })),
    edges: run.workflow.edges.map(edge => ({ source: edge.source, target: edge.target, outcome: edge.outcome })),
    attempts: run.attempts.map(attempt => ({ nodeId: attempt.nodeId, number: attempt.number, jobId: attempt.jobId, status: attempt.status, outcome: attempt.result?.outcome ?? null, summary: attempt.result?.summary ?? null, startedAt: attempt.startedAt, endedAt: attempt.endedAt })),
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  }
}

function inScope(item: { chatId?: string; terminalId?: string }, scope: Scope): boolean {
  return (!!scope.chat && item.chatId === scope.chat) || (!!scope.terminal && item.terminalId === scope.terminal)
}

export function scopeSnapshot(runs: WorkflowRun[], jobs: JobRecord[], scope: Scope): ScopeSnapshot {
  return {
    runs: runs.filter(run => inScope(run, scope)).sort((a, b) => b.createdAt - a.createdAt).map(runView),
    jobs: jobs.filter(job => inScope(job, scope) && !job.workflowRunId && job.purpose !== 'chat').sort((a, b) => b.startedAt - a.startedAt)
      .map(job => ({ id: job.id, label: job.label, engine: job.engine, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt ?? null })),
  }
}
```

Check the actual `JobRecord` field names (`rg -n "export type JobRecord" -A 40 server/jobs.ts`) and adjust `chatId` / `terminalId` / `endedAt` if they differ.

`server/routes/studio.ts`: `studioRoutes(store, runner, builder?, events?: RunEvents, jobs?: () => JobRecord[])`; add, before the run routes:

```ts
    .get('/api/studio/events', ({ query, request }) => {
      if (!events || !jobs) throw new Error('Live updates unavailable')
      const scope = { chat: query.chat || undefined, terminal: query.terminal || undefined }
      return eventStreamResponse(events, () => scopeSnapshot(runner.list(), jobs(), scope), request.signal)
    })
```

`server/index.ts`: `const runEvents = createRunEvents()` before `createJobManager`. In `onJobStarted` add `runEvents.changed()`; in `onJobSettled` add `runEvents.changed()` as its first line. Pass `onChange: () => runEvents.changed()` to `createWorkflowRunner`. Pass `runEvents, () => jobManager.listJobs()` to `studioRoutes(...)` (`rg -n "studioRoutes\(" server/index.ts`).

- [ ] **Step 4: Run tests** — `bun test && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add server/run-events.ts server/run-view.ts server/routes/studio.ts server/index.ts test/run-events.test.ts test/run-view.test.ts
git commit -m "feat(studio): push session flow snapshots over SSE"
```

---

### Task 5: Graph renderer for real runs

**Files:**
- Rewrite: `client/flow-graph.ts`
- Rewrite: `test/flow-graph.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure).
- Produces:

```ts
export type StepState = 'done' | 'active' | 'failed' | 'pending' | 'conditional'
export type EdgeState = 'done' | 'flowing' | 'failed' | 'idle'
export type GraphStep = { id: string; title: string; detail: string; state: StepState; engine: string; kind: string; since?: number }
export type GraphEdge = { source: string; target: string; outcome: 'pass' | 'fail' | 'blocked'; state: EdgeState; label?: string }
export type Placed = { id: string; x: number; y: number }
export type Route = { source: string; target: string; shape: 'forward' | 'down' | 'up' | 'back'; d: string }
export const STEP_W = 160, STEP_H = 52, COL_STEP = 188, ROW_STEP = 70
export function layoutRun(steps: { id: string }[], edges: { source: string; target: string; outcome: string }[], entry: string): { placed: Placed[]; width: number; height: number }
export function routeEdge(from: Placed, to: Placed): Route
export function renderRunGraph(host: HTMLElement, steps: GraphStep[], edges: GraphEdge[], entry: string, options: { animate: boolean }): void
```

Layout rules:
- Columns by first discovery in a BFS from `entry` that visits `pass` edges before `fail` / `blocked` edges.
- A step first reached by a `pass` edge goes one column right of its source. A step first reached only by a `fail` / `blocked` edge goes in its source's column, on the next free row below.
- Within a column, steps take rows 0, 1, 2… in discovery order. `x = column * COL_STEP`, `y = row * ROW_STEP`.
- Steps not reachable from `entry` go in a final column (defensive; validation normally prevents this).
- Edge shapes: target column > source column → `forward` (cubic from right-middle to left-middle); same column and target below → `down` (straight line from the source bottom at 30% width to the target top at 30% width); same column and target above → `up` (straight line from the source top at 70% width to the target bottom at 70% width); target column < source column → `back` (cubic from the source bottom-centre dipping 26px below the lower of the two steps, into the target bottom-centre).

Rendering (classes from DECISION.md, styles added in Task 6): host gets a `.flow-run` div sized `width × height`, an `svg.flow-run-edges` with one `path.flow-route[data-state]` per edge (marker-end arrow per state, ids `flow-tip-<state>`), a `span.flow-route-label` for edges with `label`, and one `div.flow-step[data-state][data-kind]` per step containing: logo `img.flow-step-logo` (`/providers/<engine>.svg`) or, for `kind` `review` with no engine logo… use the logo when `engine` is non-empty, else an inline SVG glyph; `strong` title; `small` detail (with `data-since` when `since` is set); `span.flow-mark[data-state]`. Skip re-render when a signature of the inputs is unchanged (same pattern as the old `paintSignature`). When `animate` and the step ids changed, draw edges in with the existing stroke-dash animation (keep the `DRAW_MS` / `DRAW_STAGGER_MS` constants and animation code from the current file).

- [ ] **Step 1: Write the failing tests** (`test/flow-graph.test.ts`, replace its contents)

```ts
import { expect, test } from 'bun:test'
import { COL_STEP, ROW_STEP, STEP_H, STEP_W, layoutRun, renderRunGraph, routeEdge } from '../client/flow-graph'

const ids = (...names: string[]) => names.map(id => ({ id }))

test('a straight pass chain runs left to right on one row', () => {
  const layout = layoutRun(ids('plan', 'verify', 'build', 'review'), [{ source: 'plan', target: 'verify', outcome: 'pass' }, { source: 'verify', target: 'build', outcome: 'pass' }, { source: 'build', target: 'review', outcome: 'pass' }], 'plan')
  expect(layout.placed.map(step => [step.id, step.x, step.y])).toEqual([['plan', 0, 0], ['verify', COL_STEP, 0], ['build', 2 * COL_STEP, 0], ['review', 3 * COL_STEP, 0]])
  expect(layout.width).toBe(3 * COL_STEP + STEP_W)
  expect(layout.height).toBe(STEP_H)
})

test('a step reached only on failure sits under its source; its way back is an up edge', () => {
  const edges = [{ source: 'review', target: 'fix', outcome: 'fail' }, { source: 'fix', target: 'review', outcome: 'pass' }, { source: 'review', target: 'done', outcome: 'pass' }]
  const layout = layoutRun(ids('review', 'fix', 'done'), edges, 'review')
  const at = Object.fromEntries(layout.placed.map(step => [step.id, step]))
  expect([at.fix!.x, at.fix!.y]).toEqual([0, ROW_STEP])
  expect([at.done!.x, at.done!.y]).toEqual([COL_STEP, 0])
  expect(routeEdge(at.review!, at.fix!).shape).toBe('down')
  expect(routeEdge(at.fix!, at.review!).shape).toBe('up')
})

test('a retry loop to an earlier column is drawn as a back arc below both steps', () => {
  const layout = layoutRun(ids('build', 'test'), [{ source: 'build', target: 'test', outcome: 'pass' }, { source: 'test', target: 'build', outcome: 'fail' }], 'build')
  const [build, testStep] = layout.placed
  const route = routeEdge(testStep!, build!)
  expect(route.shape).toBe('back')
  expect(route.d).toContain(String(STEP_H + 26))
})

test('unreachable steps still get a place instead of being dropped', () => {
  const layout = layoutRun(ids('a', 'orphan'), [], 'a')
  expect(layout.placed.map(step => step.id)).toEqual(['a', 'orphan'])
})

test('render draws one step per node and one route per edge, with states', () => {
  const host = document.createElement('div')
  renderRunGraph(host, [
    { id: 'plan', title: 'Plan', detail: 'Done · 2m 10s', state: 'done', engine: 'claude', kind: 'plan' },
    { id: 'build', title: 'Build', detail: 'Try 2 · 48s', state: 'active', engine: 'codex', kind: 'implement', since: 1 },
  ], [{ source: 'plan', target: 'build', outcome: 'pass', state: 'flowing' }], 'plan', { animate: false })
  expect([...host.querySelectorAll('.flow-step')].map(step => (step as HTMLElement).dataset.state)).toEqual(['done', 'active'])
  expect(host.querySelectorAll('path.flow-route[data-state="flowing"]')).toHaveLength(1)
  expect(host.querySelector('.flow-step img')!.getAttribute('src')).toBe('/providers/claude.svg')
  expect(host.querySelector('[data-since]')).not.toBeNull()
})
```

The render test needs a DOM; check how other client tests get one (`rg -n "happy-dom|GlobalRegistrator|document" test/*.test.ts | head`) and use the same setup (bunfig preload or a per-file import).

- [ ] **Step 2: Run to see them fail** — `bun test test/flow-graph.test.ts`

- [ ] **Step 3: Implement** `client/flow-graph.ts` to the rules above. Keep `ENGINE`-agnostic: the logo path is `/providers/${engine}.svg`. BFS:

```ts
export function layoutRun(steps: { id: string }[], edges: { source: string; target: string; outcome: string }[], entry: string) {
  const column = new Map<string, number>()
  const row = new Map<string, number>()
  const used = new Map<number, number>()
  const place = (id: string, col: number) => { const next = used.get(col) ?? 0; column.set(id, col); row.set(id, next); used.set(col, next + 1) }
  const queue = [entry]
  if (steps.some(step => step.id === entry)) place(entry, 0)
  while (queue.length) {
    const id = queue.shift()!
    const outgoing = edges.filter(edge => edge.source === id).sort((a, b) => Number(a.outcome !== 'pass') - Number(b.outcome !== 'pass'))
    for (const edge of outgoing) {
      if (column.has(edge.target)) continue
      place(edge.target, column.get(id)! + (edge.outcome === 'pass' ? 1 : 0))
      queue.push(edge.target)
    }
  }
  const last = Math.max(-1, ...column.values()) + 1
  for (const step of steps) if (!column.has(step.id)) place(step.id, last)
  const placed = steps.map(step => ({ id: step.id, x: column.get(step.id)! * COL_STEP, y: row.get(step.id)! * ROW_STEP }))
  const width = Math.max(0, ...placed.map(step => step.x + STEP_W))
  const height = Math.max(0, ...placed.map(step => step.y + STEP_H))
  return { placed, width, height }
}
```

(Note: a fail-edge target placed in the same column gets the next free row in that column, which is "below" as required.)

- [ ] **Step 4: Run tests** — `bun test test/flow-graph.test.ts && bun run typecheck`. `client/shell-activity.ts` will not compile yet because it imports `renderFlowGraph`; in this task, change that import site minimally: delete the `renderFlowGraph` import and make `paintGraph()` a no-op body `{}` — Task 6 replaces the whole flow part of that file.

- [ ] **Step 5: Commit**

```bash
git add client/flow-graph.ts test/flow-graph.test.ts client/shell-activity.ts
git commit -m "feat(flow): layered graph renderer for real workflow runs"
```

---

### Task 6: The drawer (variant D)

**Files:**
- Create: `client/flow-drawer.ts`
- Modify: `server/views/shell.ts:69-75` (`#flow` markup), `client/shell-activity.ts` (remove every flow part), `client/shell.ts:20-48` (keep toggle; dispatch `quiet:flow-open` with `detail: boolean` from `toggleFlow`), `public/quiet.css:201-208,389-413`
- Modify: the client bundle entry list if client modules are listed explicitly (`rg -n "shell-activity" server/ package.json scripts/ | head` — add `flow-drawer` the same way `shell-activity` is included; if `shell.ts` imports `shell-activity`, import `./flow-drawer` there too)
- Test: `test/flow-drawer.test.ts`, `test/shell.test.ts` (markers)

**Interfaces:**
- Consumes: `ScopeSnapshot`, `RunView`, `QuickJobView` shapes (Task 4 — import the types from `../server/run-view` with `import type`, the client already imports server types elsewhere: check `rg -n "from '../server" client/*.ts | head -3`; if not allowed, copy the types into `client/flow-drawer.ts`); `renderRunGraph`, `GraphStep`, `GraphEdge` (Task 5); `GET /api/studio/events`, `POST /api/studio/runs/:id/approve|reject|pause|resume|stop|retry` (Tasks 3-4).
- Produces (pure, exported for tests):

```ts
export function stepsFor(run: RunView, now: number): GraphStep[]
export function edgesFor(run: RunView): GraphEdge[]
export function metaFor(run: RunView): string          // plain text, the drawer adds the logo
export function pillsFor(run: RunView): { running: number; done: number; waiting: number }
export function bannerFor(run: RunView): { tone: 'ask' | 'problem' | null; text: string; actions: ('approve' | 'reject' | 'retry' | 'stop')[] }
export function pickRun(runs: RunView[], previous: string | null): RunView | null
export function elapsed(ms: number): string            // '48s', '3m 40s', '1h 02m'
```

Rules:
- `stepsFor`: per node, its attempts in order. Latest attempt not `settled` and run live → `active`, detail `Try n · <elapsed(now - startedAt)>` (drop `Try n · ` when n = 1, use `Working`), `since = startedAt`. Latest settled `pass` → `done`, detail `Done · <elapsed(endedAt - startedAt)>` prefixed `Try n · ` when n > 1. Latest settled `fail` / `blocked` → `failed`, detail `Failed · <summary>` (first 60 chars) or `Blocked · <summary>`. No attempts: reachable from `entry` only through fail/blocked edges → `conditional`, detail `If <source title> fails`; otherwise `pending`, detail = the engine's display name while the run awaits approval (`claude`→`Claude`, `codex`→`Codex`, `glm`→`GLM`, else the id) and `Up next` / `Waiting` while running (`Up next` when a pass edge leads from `currentNodeId` to it).
- `edgesFor`: an edge is **taken** when two consecutive attempts (by `number`) go from its source, settled with the edge's outcome, to its target. Taken `pass` edge → `done`, except when the later attempt of the most recent such pair is still unsettled and the run is live → `flowing`. Taken `fail` / `blocked` edge → `failed`. Not taken → `idle`. Label: fail/blocked edges get `if <source title> fails` while idle and `<source title> failed · retried` once taken.
- `metaFor`: `Saved workflow <name> · picked by <By> in <where>` (`where` = `terminal`, `chat`, or for `studio` the phrase becomes `started from Studio`), then ` · ` + the approval phrase of the latest non-pending version: `user` → `started by you`, `drawer` → `approved by you in the drawer, <h:mm AM/PM>`, `conversation` → `approved in the conversation (relayed by <By>), <time>`, `auto` → `started on its own (approval is off)`; when a version is pending → `waiting for your approval`.
- `bannerFor`: pending version and status `awaiting-approval` → tone `ask`, text `<By> picked "<workflow name>" for this task. Nothing runs until you approve, or say "go" to <By>.`, actions `['reject', 'approve']`. Status `blocked` / `failed` → tone `problem`, text `<Blocked|Failed>: <error>`, actions `['retry']`. Otherwise `{ tone: null, text: '', actions: [] }`.
- `pickRun`: keep `previous` if still present; else the first live run; else the newest.

DOM (replace `server/views/shell.ts:69-75` inner markup; keep the section's id, classes, `aria-*`, `inert`):

```html
<section id="flow" class="inline-flow" aria-labelledby="flow-title" aria-hidden="true" inert>
  <div class="flow-inner"><div class="flow-card">
    <header class="flow-head">
      <div class="flow-title"><h2 id="flow-title">Session flow</h2><select id="flow-runs" class="flow-runs" aria-label="Flows in this session" hidden></select><small id="flow-meta" class="flow-meta"></small></div>
      <div id="flow-pills" class="flow-pills"></div>
      <div class="flow-actions"><button id="flow-pause" class="pill flow-sm" type="button" hidden>Pause</button><button id="flow-stop" class="pill flow-sm" type="button" hidden><span>Stop</span><span>Stop flow</span></button><button id="close-flow" class="round" aria-label="Collapse flow"><svg><use href="#close-icon"/></svg></button></div>
    </header>
    <div id="flow-banner" class="flow-banner" role="status" hidden><span class="flow-mark"></span><p></p><div class="flow-banner-actions"></div></div>
    <div id="flow-stage" class="flow-stage" hidden></div>
    <div id="flow-quick" class="flow-quick" hidden><p class="muted">No flow for this work. The agents run directly.</p><ol id="flow-quick-list"></ol></div>
    <p id="flow-empty" class="flow-empty muted">Your session’s flow will appear here.</p>
  </div></div>
</section>
```

Behaviour in `client/flow-drawer.ts`:
- Scope: listen to `quiet:activity-scope` (detail `{ id, cwd } | null` → `terminal=<id>`) and `quiet:chat-agents` (detail chat id → `chat=<id>`), plus `document.body.dataset.chat` at load — same sources `shell-activity.ts` uses today.
- Connection: open `new EventSource('/api/studio/events?' + params)` when the drawer is open and a scope is set (`quiet:flow-open` true); close it when the drawer closes or the scope changes. On `message`, parse `ScopeSnapshot` and paint.
- Paint: no runs and no jobs → only `#flow-empty`. No runs, some jobs → `#flow-quick` list: each `li` has `span.flow-mark[data-state]` (done / active / failed from job status `done` / `running` / other), the engine logo, the label, and `<status> · <elapsed>` right-aligned; the header title becomes the newest job's label and the meta `Quick work · no flow needed`. Runs → header title = run label; `#flow-runs` select shown when there are 2+ runs (option text `label · status`); `#flow-meta` = engine logo `img` + `metaFor`; `#flow-pills` = three `.pill-state` spans (`running`, `done`, `queued` data-s) hiding zero counts; `#flow-pause` shown for `running` (text Pause → POST pause) and `paused` (text Resume → POST resume); `#flow-stop` shown for the three live statuses, wired with `confirmButton(stop, 'Stop flow', …)` → POST stop (same two-span pattern the Agents drawer's stop button uses in `client/shell-activity.ts`); approve / reject send `{ version: <the pending version's number> }`; banner from `bannerFor` (tone `ask` → class `flow-banner ask`, `problem` → `flow-banner problem`); approve button is `pill flow-sm flow-primary` "Approve and run"; reject uses `confirmButton` (from `./confirm-button`) "Reject" / "Reject flow"; retry "Retry step". Stage: `renderRunGraph(stage, stepsFor(run, Date.now()), edgesFor(run), run.entry, { animate: motionAllowed() })` (copy `motionAllowed` from `shell-activity.ts`).
- Every 1 s while the drawer is open, update each `[data-since]` element's text to `Try n · elapsed` / `Working · elapsed` (recompute through `stepsFor` and repaint only the text; do not rebuild the graph).
- Action errors: show the error text in the banner `p` via `rollText` (from `./morph`) and keep the buttons.

`client/shell-activity.ts`: delete `flows`, `current`, `showFlows`, `paintFlow`, `paintGraph`, `refreshChat`'s `/api/flow` fetch, the `live-flow*` lines in `setActivityScope`, the `live-flow-select` handler, the `toggle-flow`/`close-flow` listeners, and the `awareness`/`flow-graph` imports that become unused. The Agents drawer keeps working: in `refresh()` fetch only `/api/jobs`, and build with `buildWork(jobs, {})` (Task 8 simplifies `buildWork`'s signature; keep passing `{}` until then). The `refresh` guard becomes `if (!scope || refreshing || document.hidden || !($('agents') as HTMLDialogElement).open) return`.

CSS (`public/quiet.css`): delete lines 389-413's `#live-flow*`, `.flow-graph*`, `.flow-edge*`, `.flow-node*` rules (keep `@keyframes flow-dash` and `flow-pulse`). Add the drawer styles, values verbatim from `docs/design/flow-drawer/DECISION.md` and `docs/design/flow-drawer/flow-v2.css` (rename `.fv-d` → `.flow-card`, `.fv-h*` → `.flow-head/.flow-title/.flow-meta/.flow-pills/.flow-actions`, `.fv-approve` → `.flow-banner`, `.fv-approve.fv-notice` → `.flow-banner.notice`, `.fv-stage` → `.flow-stage`, `.fv-n` → `.flow-step`, `.fv-e` → `.flow-route`, `.fv-tip` → `.flow-tip`, `.fv-elabel` → `.flow-route-label`, `.fv-mark` → `.flow-mark`, `.fv-sm` → `.flow-sm`, `.fv-primary` → `.flow-primary`, `.fv-ghost` → `.flow-ghost`, `.fv-c-row` → `#flow-quick-list li`). `.flow-card` replaces `.flow-panel` (drop the old `.flow-panel` 850px width rule; the card is `calc(100% - 56px)` wide). `.flow-stage` gets `max-height: min(320px, 40dvh); overflow: auto`. `.flow-step[data-state="conditional"]` = the mock's `idle` look (dashed, 62% opacity). `.flow-banner.problem` = border `#e8c4cd`, background `color-mix(in srgb, #f5dde3 55%, var(--paper))`. Keep the mobile rule at line ~341 adapted to `.flow-card { width: calc(100% - 28px); padding: 14px }`.

- [ ] **Step 1: Write the failing tests** (`test/flow-drawer.test.ts`)

```ts
import { expect, test } from 'bun:test'
import { bannerFor, edgesFor, elapsed, metaFor, pickRun, pillsFor, stepsFor } from '../client/flow-drawer'
import type { RunView } from '../server/run-view'

const base: RunView = {
  id: 'r', label: 'Add export', status: 'running', error: null, workflowName: 'Feature build', revision: 'v', entry: 'plan', currentNodeId: 'build',
  origin: { source: 'saved', by: 'codex', where: 'terminal' },
  versions: [{ number: 1, revision: 'v', reason: 'Initial flow', size: 'initial', state: 'approved', approvedVia: 'drawer', relayedBy: null, at: Date.UTC(2026, 8, 28, 22, 41) }],
  nodes: [{ id: 'plan', title: 'Plan', kind: 'plan', engine: 'claude' }, { id: 'build', title: 'Build API', kind: 'implement', engine: 'codex' }, { id: 'test', title: 'API tests', kind: 'task', engine: 'glm' }, { id: 'fix', title: 'Fix notes', kind: 'implement', engine: 'claude' }],
  edges: [{ source: 'plan', target: 'build', outcome: 'pass' }, { source: 'build', target: 'test', outcome: 'pass' }, { source: 'test', target: 'build', outcome: 'fail' }, { source: 'test', target: 'fix', outcome: 'blocked' }],
  attempts: [
    { nodeId: 'plan', number: 0, jobId: 'a', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 0, endedAt: 130_000 },
    { nodeId: 'build', number: 1, jobId: 'b', status: 'settled', outcome: 'pass', summary: 'ok', startedAt: 130_000, endedAt: 200_000 },
    { nodeId: 'test', number: 2, jobId: 'c', status: 'settled', outcome: 'fail', summary: 'Tests failed in export_spec', startedAt: 200_000, endedAt: 260_000 },
    { nodeId: 'build', number: 3, jobId: 'd', status: 'running', outcome: null, summary: null, startedAt: 260_000, endedAt: null },
  ],
  createdAt: 0, updatedAt: 260_000,
}

test('elapsed reads like a person would say it', () => {
  expect(elapsed(48_000)).toBe('48s')
  expect(elapsed(220_000)).toBe('3m 40s')
  expect(elapsed(3_720_000)).toBe('1h 02m')
})

test('steps show done, a second try in progress, a failed test and a conditional fix', () => {
  const steps = Object.fromEntries(stepsFor(base, 308_000).map(step => [step.id, step]))
  expect([steps.plan!.state, steps.plan!.detail]).toEqual(['done', 'Done · 2m 10s'])
  expect([steps.build!.state, steps.build!.detail, steps.build!.since]).toEqual(['active', 'Try 2 · 48s', 260_000])
  expect([steps.test!.state, steps.test!.detail]).toEqual(['failed', 'Failed · Tests failed in export_spec'])
  expect([steps.fix!.state, steps.fix!.detail]).toEqual(['conditional', 'If API tests fails'])
})

test('edges mark the taken retry loop and the running hand-off', () => {
  const edges = Object.fromEntries(edgesFor(base).map(edge => [`${edge.source}>${edge.target}`, edge]))
  expect(edges['plan>build']!.state).toBe('done')
  expect(edges['test>build']!).toEqual(expect.objectContaining({ state: 'failed', label: 'API tests failed · retried' }))
  expect(edges['build>test']!.state).toBe('done')
  expect(edges['test>fix']!).toEqual(expect.objectContaining({ state: 'idle', label: 'if API tests fails' }))
})

test('a flow waiting for approval asks, names the AI and greys every step', () => {
  const waiting: RunView = { ...base, status: 'awaiting-approval', attempts: [], versions: [{ ...base.versions[0]!, state: 'pending', approvedVia: null }] }
  expect(bannerFor(waiting)).toEqual({ tone: 'ask', text: 'Codex picked "Feature build" for this task. Nothing runs until you approve, or say "go" to Codex.', actions: ['reject', 'approve'] })
  expect(metaFor(waiting)).toBe('Saved workflow Feature build · picked by Codex in terminal · waiting for your approval')
  expect(stepsFor(waiting, 0).map(step => [step.state, step.detail])).toEqual([['pending', 'Claude'], ['pending', 'Codex'], ['pending', 'GLM'], ['conditional', 'If API tests fails']])
})

test('meta says how the flow was approved', () => {
  expect(metaFor({ ...base, versions: [{ ...base.versions[0]!, approvedVia: 'conversation', relayedBy: 'codex' }] })).toContain('approved in the conversation (relayed by Codex)')
  expect(metaFor({ ...base, versions: [{ ...base.versions[0]!, approvedVia: 'auto' }] })).toContain('started on its own (approval is off)')
  expect(metaFor({ ...base, origin: { ...base.origin, where: 'studio' }, versions: [{ ...base.versions[0]!, approvedVia: 'user' }] })).toBe('Saved workflow Feature build · started from Studio · started by you')
})

test('a blocked run offers a retry with the reason', () => {
  expect(bannerFor({ ...base, status: 'blocked', error: 'Engine out of quota' })).toEqual({ tone: 'problem', text: 'Blocked: Engine out of quota', actions: ['retry'] })
  expect(bannerFor(base)).toEqual({ tone: null, text: '', actions: [] })
})

test('pills count running, done and waiting steps', () => {
  expect(pillsFor(base)).toEqual({ running: 1, done: 1, waiting: 1 })
})

test('pickRun keeps the selection, else prefers a live run, else the newest', () => {
  const done = { ...base, id: 'done', status: 'done' }
  const live = { ...base, id: 'live' }
  expect(pickRun([done, live], 'done')!.id).toBe('done')
  expect(pickRun([done, live], 'gone')!.id).toBe('live')
  expect(pickRun([done], null)!.id).toBe('done')
  expect(pickRun([], null)).toBeNull()
})
```

The fixture: `test` failed and the run looped back to `build` (try 2). `pillsFor` counts steps by state: running = `active`, done = `done`, waiting = `pending` + `conditional`. Here that is build / plan / fix → `{ running: 1, done: 1, waiting: 1 }` (`test` is `failed` and counted in none).

In `test/shell.test.ts`, the marker list (line ~27) must contain `'id="flow-stage"'`, `'id="flow-banner"'`, `'id="flow-quick"'` and no longer `live-flow` ids (it does not list them today; just add the three).

- [ ] **Step 2: Run to see them fail** — `bun test test/flow-drawer.test.ts test/shell.test.ts`

- [ ] **Step 3: Implement** everything in this task's description.

- [ ] **Step 4: Run tests** — `bun test && bun run typecheck`

- [ ] **Step 5: Verify in the browser** (throwaway server — never touch the cockpit on :7777; stop it by PID only)

```bash
MISSION_CONTROL_PORT=7795 MISSION_CONTROL_CONFIG_DIR=$(mktemp -d) MC_FAKE_ENGINES=1 bun run server/index.ts
```

(Check `package.json` / `README.md` for the real start command and fake-engine flag; `rg -n "MC_FAKE_ENGINES" server | head -3`.) Open `http://127.0.0.1:7795`, open a fake terminal, start a run with `curl -s -X POST http://127.0.0.1:7795/api/studio/runs -H 'content-type: application/json' -d '{"terminalId":"<id>","cwd":"<repo>","request":"x","label":"Try it"}'`, open the Flow drawer, and confirm with screenshots: the draft state with Approve / Reject; after Approve, steps turn green one by one without reloading; Pause stops new steps; a flow-less job shows the quick list. Compare against `docs/design/flow-drawer/d-draft.html` and `d-terminal.html`.

- [ ] **Step 6: Commit**

```bash
git add client/flow-drawer.ts client/shell-activity.ts client/shell.ts server/views/shell.ts public/quiet.css test/flow-drawer.test.ts test/shell.test.ts
git commit -m "feat(flow): session flow drawer shows the live workflow run"
```

---

### Task 7: "Ask me before a flow runs" switch in Access

**Files:**
- Modify: `server/views/shell.ts:138` (Access dialog), `client/access.ts`
- Test: `test/shell.test.ts` (marker)

- [ ] **Step 1: Failing test** — add `'id="access-flow-approval"'` to the markers in `test/shell.test.ts`; run `bun test test/shell.test.ts`, expect FAIL.

- [ ] **Step 2: Implement** — in the Access dialog, after the chat-home form, add:

```html
<div class="field-stack"><label class="switch-label"><input id="access-flow-approval" type="checkbox" role="switch">Ask me before a flow runs</label><p id="access-flow-note" class="muted">When off, flows start as soon as an AI picks them, and big changes apply on their own.</p></div>
```

In `client/access.ts`: on dialog open (the existing `MutationObserver`), `GET /api/flow-approval` and set `checked`; on `change`, `PUT /api/flow-approval { flowApproval: checked }` via `fetch` (same pattern as `homeForm.onsubmit`), then `rollText(note, checked ? 'Flows wait for you.' : 'Flows start on their own.')`; on error, revert `checked` and show the error.

- [ ] **Step 3: Run tests** — `bun test && bun run typecheck`; check the switch in the throwaway server from Task 6.

- [ ] **Step 4: Commit**

```bash
git add server/views/shell.ts client/access.ts test/shell.test.ts
git commit -m "feat(access): switch for asking before a flow runs"
```

---

### Task 8: Remove the plan runner, picture-only plans and the synthesized flow

**Files:**
- Delete: `server/plans.ts`, `server/plan-runner.ts`, `server/routes/runs.ts`, `server/flow.ts`, `server/routes/flow.ts`, `client/plan-view.ts`, `test/plans.test.ts`, `test/plan-runner.test.ts`, `test/runs-routes.test.ts`, `test/flow.test.ts`, `test/flow-routes.test.ts`, `test/plan-view.test.ts`
- Modify: `server/index.ts` (drop `createPlanStore`, `createPlanRunner`, `planRunner.onJobSettled`, `flowRoutes`, `runsRoutes`), `server/routes/meta.ts` (move `countPendingReviews` into this file from `server/flow.ts`, unchanged), `server/archive.ts` (remove the `Plan` import and whatever parameter used it — `rg -n "Plan" server/archive.ts`), `server/auth.ts` (remove `/api/flow` from `TOKEN_SCOPED_GET_ONLY_PATHS` and the three `/api/flow/...` regex blocks), `client/work.ts` (drop `plan`, `stages`, `flowLabel`, `archived` fields and the `flows` parameter: `buildWork(jobs: WorkJob[]): WorkItem[]`), `client/awareness.ts` (drop `awarenessFlows`, `selectFlow`, `flowSteps`, `flowColumns`, `workingLabel` if unused, `FlowStep`; `activeAgents(jobs, id, cwd)` loses the `flows` argument), `client/shell-activity.ts` (call sites), `test/work.test.ts`, `test/awareness.test.ts`, `test/archive.test.ts` (imports `Plan` at :15 and calls `sessionLastActivity(jobs, null)` at :178/:183 — drop the plan fixture and the second argument), `test/api-token-auth.test.ts`, `test/auth.test.ts`, `test/views.test.ts` (assertions that used `/api/flow` switch to `/api/studio/runs`)
- Docs: `docs/decisions/flow-derivation.md` gets a first line `Superseded by docs/superpowers/specs/2026-09-28-real-session-flows-design.md (2026-09-28).`

- [ ] **Step 1: Find every reference before deleting**

```bash
rg -n "plans'|plan-runner|routes/runs|from './flow'|from '../flow'|routes/flow|plan-view|/api/flow|awarenessFlows|flowSteps|flowColumns|selectFlow|parsePlan|STAGES|templateNodeSpecs" server client test skills scripts --glob '!*.md'
```

Every hit is either deleted with its file or rewritten in this task. `skills/mc-dispatch/SKILL.md` is NOT touched here (Task 10).

- [ ] **Step 2: Delete and rewrite** per the file list. `countPendingReviews` keeps its exact body and its test moves into the meta routes test (`rg -n "countPendingReviews" test/`).

- [ ] **Step 3: Run tests** — `bun test && bunx tsc -p tsconfig.shell.json && bun run typecheck:studio`. Then `rg -n "/api/flow([/'\"?\`]|$)" server client test` must print nothing (`/api/flow-approval` is expected and does not match).

- [ ] **Step 4: Commit**

```bash
git add -A server client test docs/decisions/flow-derivation.md
git commit -m "refactor: remove the plan runner, picture-only plans and the synthesized flow

Studio workflow runs are now the only engine behind the Session flow
drawer. plans.jsonl is left on disk untouched; it was display-only."
```

(`git add -A` is scoped to those paths; check `git status` first and make sure nothing outside this task is staged.)

---

### Task 9: Teach every session AI to pick a flow and relay approval

**Files:**
- Modify: `server/chat-profile.ts` (the `## Studio workflows` section of `CHAT_RULES`), `server/terminals.ts:225` (`instructions`)
- Test: `test/chat-profile.test.ts`, the terminal instructions test (`rg -ln "pinned workflow" test/`)

- [ ] **Step 1: Failing tests** — in `test/chat-profile.test.ts` add:

```ts
test('chat rules explain when to use a flow and how to relay approval', () => {
  for (const phrase of ['more than one step that changes code', 'GET $MC_URL/api/studio/workflows', '"status":"awaiting-approval"', '/approve {"chat":"$MC_CHAT_ID"}', 'Never approve without the owner saying so']) expect(CHAT_RULES).toContain(phrase)
  expect(CHAT_RULES).not.toContain('Naming a Studio workflow is optional')
})
```

In the terminal test, assert the instructions contain `more than one step that changes code`, `/approve`, `"terminalId"`, `Never approve without the user saying so`, and no longer contain `pinned workflow`.

- [ ] **Step 2: Implement** — replace the `## Studio workflows` section of `CHAT_RULES` with:

```
## Flows (Studio workflows)
Use a flow for work with more than one step that changes code, or that needs more than one agent. Answer questions, run quick investigations and make small single-file edits directly, without a flow.
To start one: GET $MC_URL/api/studio/workflows lists saved workflows (id, revision, name). Pick the one that fits the task. POST $MC_URL/api/studio/runs with JSON {"workflowId","revision","cwd":"<project>","label":"<short task name>","request":"<the owner's full request>","chat":"$MC_CHAT_ID","chatTurn":"$MC_JOB_ID","engine":"<your engine>","model":"<your model, or omit>"}. Do not spawn agents for the same work.
The flow usually waits for the owner in the Session flow drawer (the response has "status":"awaiting-approval"). Tell the owner in one line which flow you picked and that it is waiting. If the owner says go in this chat, approve it for them: POST $MC_URL/api/studio/runs/<id>/approve {"chat":"$MC_CHAT_ID"}. If they say no: POST $MC_URL/api/studio/runs/<id>/reject {"chat":"$MC_CHAT_ID"}. Never approve without the owner saying so.
The run reports back as one chat turn that starts with "[workflow". Stop it with POST $MC_URL/api/studio/runs/<id>/stop.
```

Replace the terminal `instructions` string with:

```ts
const instructions = `This is a Mission Control terminal (id ${JSON.stringify(id)}). Its default workflow is ${JSON.stringify(workflow)}. Use a flow for work with more than one step that changes code, or that needs more than one agent; answer questions, run quick investigations and make small single-file edits yourself. To start a flow: GET ${mcUrl}/api/studio/workflows, pick the saved workflow that fits (the default above when unsure), then POST ${mcUrl}/api/studio/runs with terminalId ${JSON.stringify(id)}, workflowId, revision, cwd ${JSON.stringify(cwdCheck.path)}, a short label and the complete user request. Mission Control owns the steps; do not also do them yourself. The flow usually waits for approval in the Session flow drawer; tell the user which flow you picked. If the user says go here, POST ${mcUrl}/api/studio/runs/<id>/approve with {"terminalId":${JSON.stringify(id)}} (or /reject). Never approve without the user saying so. Read the Bearer apiToken from secrets.json in MISSION_CONTROL_CONFIG_DIR without printing it. Use MC_URL for all cockpit calls, never a hardcoded port. Follow the mc-dispatch skill when available. Opening this terminal does not authorize starting any work; wait for the user. MC_WORKFLOW_ID and MC_WORKFLOW_REVISION identify the default workflow.`
```

- [ ] **Step 3: Run tests** — `bun test && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add server/chat-profile.ts server/terminals.ts test/chat-profile.test.ts <terminal test file>
git commit -m "feat(instructions): session AIs pick a flow for multi-step work and relay approval"
```

---

### Task 10: mc-dispatch skill (gated)

**Precondition:** `git status --short skills/mc-dispatch/SKILL.md` is clean. If it shows local changes that are not part of this plan, STOP and report — do not stash, reset or overwrite them.

**Files:** `skills/mc-dispatch/SKILL.md`

- [ ] **Step 1:** Remove the "Plan first" section (`POST/PATCH $MC_URL/api/flow/<label>/plan`, currently around lines 297-317) and the "Multi-task plan → the plan runner (default)" section (around 335-357). Replace the `/api/flow` token probe (line ~70) with `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $MC_TOKEN" "$MC_URL/api/meta"`. In the "Monitor" section (~381) replace `GET /api/flow` with `GET $MC_URL/api/studio/runs?terminal=$MC_TERMINAL_ID` (or `?chat=`).
- [ ] **Step 2:** Add a "Flows" section with the same rules as the terminal instructions from Task 9 (when to use a flow, how to pick, approval relay, never approve without the user).
- [ ] **Step 3:** `rg -n "/api/flow" skills/` prints nothing. Commit: `git commit -m "docs(mc-dispatch): flows replace the plan runner"`.

---

### Task 11: End-to-end check in the running app

The stock fake engines are `/bin/echo` (`server/engines.ts:47-51`): they never print `MC_RESULT`, so every step would end blocked. Add a dev-only override first.

- [ ] **Step 0: Fake engine that passes.** In `server/engines.ts`, make each `FAKE_ENGINES` entry's `cmd` read `process.env.MC_FAKE_ENGINE_CMD || '/bin/echo'`. Create `scripts/fake-pass-engine.sh` (executable):

```sh
#!/bin/sh
sleep "${MC_FAKE_STEP_SECONDS:-4}"
printf '%s\n' '{"type":"result","result":"MC_RESULT {\"outcome\":\"pass\",\"summary\":\"Fake step passed\",\"evidence\":[\"fake engine\"]}"}'
```

Add one example to the engines test (`rg -ln "FAKE_ENGINES|fakeEnginesEnabled" test/`): with `MC_FAKE_ENGINES=1` and `MC_FAKE_ENGINE_CMD=/x/y`, `resolveEngine('glm').cmd` is `/x/y`; without the override it is `/bin/echo`. Commit `test(dev): fake engine command override for end-to-end runs`.

- [ ] Start a throwaway server as in Task 6 Step 5 with `MC_FAKE_ENGINE_CMD=$PWD/scripts/fake-pass-engine.sh` (fake engines, temp config dir, port 7795). Never restart or kill the :7777 cockpit.
- [ ] Terminal path: open a fake terminal, POST a run with its `terminalId`, confirm the drawer's draft state, approve from the drawer, watch steps go green live, check the meta line says "approved by you in the drawer".
- [ ] Relay path: start another run, approve with `curl … /approve -d '{"terminalId":"<id>"}'` (no `sec-fetch-site`), check the meta says "approved in the conversation (relayed by …)"; repeat with a wrong `terminalId` and confirm 403.
- [ ] Approval off: turn the Access switch off, start a run, confirm it starts at once and the meta says "started on its own".
- [ ] Pause / Resume, Reject, a blocked run's Retry.
- [ ] Quick work: a plain job with the terminal's `terminalId` and no run shows in the quick list.
- [ ] Take screenshots of each state and compare with `docs/design/flow-drawer/d-*.html`. Record the results in the final report; fix anything that differs before calling Part 1 done.
