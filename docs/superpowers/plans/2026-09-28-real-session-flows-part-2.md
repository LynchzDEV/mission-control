# Real Session Flows — Part 2 Implementation Plan (drafting and live edits)

> **For agentic workers:** execute one task at a time, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A session AI can run a flow it drafted itself, and change a running flow; small changes apply at once, big ones wait for one approval (or apply with a notice when approval is off). The drawer shows proposed steps as ghosts with Approve / Keep.

**Architecture:** `server/workflows.ts` gains `draftRevision()` (validate + stamp a run-local graph). `server/workflow-runner.ts` accepts `graph` on start, and a new `propose(id, change, context)` that validates the new graph against what already ran, classifies it small or big, and either applies it or stores it as a pending version; dispatch waits while a change is pending. Routes add `POST /api/studio/runs/:id/changes` and `POST /api/studio/runs/:id/save`. The run view carries the pending proposal; the drawer draws it.

**Spec:** `docs/superpowers/specs/2026-09-28-real-session-flows-design.md` ("Drafting and live edits (part 2)"). Part 1 plan for conventions: `docs/superpowers/plans/2026-09-28-real-session-flows-part-1.md`.

## Global Constraints

- Everything in Part 1's Global Constraints applies (comment rule, no emoji, flat inputs, `bun test`, `bunx tsc -p tsconfig.shell.json` + `bun run typecheck:studio`, one commit per task, no `Co-Authored-By`, never push or merge).
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- Baseline on `main` after Part 1: `bun test` = 913 pass, 0 fail.
- Running `bun test` or any server re-points `~/.claude/skills/mc-dispatch` at the checkout that ran it. After the last test run of a task, restore it: `ln -sfn /Users/lynchz/Desktop/kingpinggroup/mission-control/skills/mc-dispatch ~/.claude/skills/mc-dispatch`.
- A drafted graph obeys the same `validateWorkflow()` rules as a saved one (plan verified before implement, cross-family review after implement, reachable finish, every node reachable). Never relax them for drafts.

## Decisions

- `RunVersion` gains `graph?: WorkflowRevision` (present on every version after the first) and `reason` already exists. Version 1's graph is the run's original `workflow`.
- Big change = any of: a node whose resolved agent family is not already used by the run; fewer `review` nodes than the active graph; a new `implement` node reachable from the entry through `pass` edges only; `scopeGrew: true` from the caller. Anything else is small.
- A change may not: change `entry`; remove a node that has an attempt; change the `kind`, `instructions` or `agent` of a node that has an attempt. It may add nodes and rewire any edge, including the running node's outgoing edges (read at its settle).
- A pending change blocks new dispatches only; the running step finishes and settles normally and `currentNodeId` moves as today. Approving applies the graph, then dispatches if the run is `running` and no attempt is unsettled. "Keep" (reject of a later version) does the same with the old graph.
- A second proposal while one is pending: 409 `A change is already waiting`.
- Agents for new nodes resolve through the same `agentsFor()` path with no chat default (role defaults); existing nodes keep the agent they were started with.
- Save as workflow: `POST /api/studio/runs/:id/save` (browser only, not in `allowToken`) saves the active graph with `id` = slug of the run label (`[a-z0-9-]`, max 64, prefixed `flow-` if it would start with a digit) and `name` = run label, returns the saved revision. Existing id → 409 `A workflow with that name exists`.

## Preserve

- Saved-workflow starts, approval, pause/resume, stop, retry, recover (Part 1) behave exactly as now; all Part 1 runner tests stay green.
- `startSchema` still accepts every Part 1 field; `graph` and `workflowId` together → 400 `Use either a saved workflow or a drafted graph`.
- Token scope: `POST /api/studio/runs/:id/changes` becomes token-allowed; `/save` stays browser-only.

## Review Focus

1. A proposal arriving while the running step is settling → the step's result is recorded under the old graph, the next step is not dispatched until the proposal is decided. Test in Task 2.
2. Approve of a later version racing the running step's settle → one dispatch, of the new graph's next node. Test in Task 2.
3. A proposal that deletes a finished step or edits a running step's instructions → 400 naming the step; run unchanged. Test in Task 2.
4. Server restart with a pending change → still pending, still blocking dispatch; approve after restart dispatches. Test in Task 2.
5. Drafted graph breaking a safety rule → 400 with the rule text; nothing created, workspace not claimed. Test in Task 1.

---

### Task 1: Drafted flows can start

**Files:** `server/workflows.ts`, `server/workflow-runner.ts` (`startSchema`, `start`), `test/workflows.test.ts`, `test/workflow-runner.test.ts`

**Produces:** `export function draftRevision(value: unknown): WorkflowRevision` in `server/workflows.ts` — throws `Error(errors.join('\n'))` when `validateWorkflow(value)` returns errors, else `{ ...workflowSchema.parse(value), revision: hash(parsed), createdAt: Date.now() }`. `startSchema` gains `graph: z.unknown().optional()`.

- [ ] **Step 1: Failing tests**

`test/workflows.test.ts`:

```ts
test('draftRevision stamps a valid graph and rejects one that breaks a safety rule', () => {
  const draft = draftRevision({ ...defaultWorkflow(), id: 'drafted', name: 'Drafted' })
  expect(draft.revision).toMatch(/^[a-f0-9]{24}$/)
  expect(draft.name).toBe('Drafted')
  const unsafe = { ...defaultWorkflow(), id: 'unsafe', name: 'Unsafe', edges: [{ source: 'plan', target: 'execute', outcome: 'pass' }] }
  expect(() => draftRevision(unsafe)).toThrow('requires a verified plan')
})
```

(`execute` then has no incoming path through `verify-plan`, and `verify-plan`/`review` become unreachable; the thrown message contains all the rule texts. Adjust the matched substring to the exact text `validateWorkflow` returns if it differs.)

`test/workflow-runner.test.ts`:

```ts
test('a drafted graph runs as a drafted flow and is not saved', async () => {
  const store = build(resolver, true)
  const graph = { ...defaultWorkflow(), id: 'drafted-export', name: 'Drafted export' }
  const started = await runner.start({ cwd: repo, request: 'Add export', label: 'export', graph })
  expect(started.origin.source).toBe('drafted')
  expect(started.workflow.name).toBe('Drafted export')
  expect(started.status).toBe('awaiting-approval')
  expect((await store.list()).map(workflow => workflow.id)).not.toContain('drafted-export')
})

test('a drafted graph that breaks a rule is refused and claims nothing', async () => {
  build(resolver, true)
  const graph = { ...defaultWorkflow(), id: 'unsafe', name: 'Unsafe', edges: [{ source: 'plan', target: 'execute', outcome: 'pass' }] }
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', graph })).rejects.toThrow('requires a verified plan')
  expect(runner.list()).toHaveLength(0)
  const ok = await runner.start({ cwd: repo, request: 'x', label: 'x' })
  expect(ok.status).toBe('awaiting-approval')
})

test('a saved workflow and a drafted graph cannot both be named', async () => {
  build(resolver, true)
  await expect(runner.start({ cwd: repo, request: 'x', label: 'x', workflowId: 'default', graph: defaultWorkflow() })).rejects.toThrow('Use either a saved workflow or a drafted graph')
})
```

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** In `start`: after parsing, `if (input.graph !== undefined && input.workflowId) throw new Error('Use either a saved workflow or a drafted graph')`. Workflow resolution: `input.graph !== undefined ? draftRevision(input.graph) : <Part 1 resolution>`, computed BEFORE `workspaceBusy` / `claimWorkspace`. `origin.source = input.graph !== undefined ? 'drafted' : 'saved'`.
- [ ] **Step 4: Tests + typecheck green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(runner): a session AI can run a flow it drafted`.

---

### Task 2: Changing a running flow

**Files:** `server/workflow-runner.ts`, `test/workflow-runner.test.ts`

**Produces:**

```ts
export type RunChange = { graph: unknown; reason: string; scopeGrew?: boolean }
// RunVersion gains: graph?: WorkflowRevision
// runner.propose(id: string, change: RunChange, context: ApprovalContext): Promise<WorkflowRun>
export function changeSize(run: Pick<WorkflowRun, 'workflow' | 'agents'>, next: WorkflowRevision, nextAgents: Record<string, ResolvedAgent>, scopeGrew: boolean): 'small' | 'big'
```

- [ ] **Step 1: Failing tests** (fixtures: default workflow `plan → verify-plan → execute → review`; a `task` node is small, an extra `implement` on the pass path is big). Write these examples, each with literal expectations:

1. `changeSize` — adding a `task` check node after `execute` (pass edge `execute→check`, `check→review`) with the review engine's family → `'small'`.
2. `changeSize` — adding an `implement` node `migrate` on the pass path (`verify-plan→migrate→execute`) → `'big'`.
3. `changeSize` — adding a fix loop: `review --fail--> fix (implement) --pass--> review` → `'small'` (reachable only through a fail edge).
4. `changeSize` — removing the `review` node's twin when the graph had two reviews → `'big'`; `scopeGrew: true` with a small graph → `'big'`.
5. `propose` small, run `running`: applies at once — `run.workflow.nodes` contains the new node, `versions.at(-1)` = `{ number: 2, size: 'small', state: 'approved', approvedVia: 'auto', reason: <given> }`, and the flow finishes through the new node (`attempts` node order includes it).
6. `propose` big with approval on: `versions.at(-1).state === 'pending'`, `run.workflow` unchanged; after the running step settles, no new attempt is created for 200 ms; `approve(id, { via: 'drawer' })` applies the graph and the next attempt is the new graph's next node; the run finishes `done`.
7. `propose` big then `reject(id, { via: 'drawer' })` ("Keep"): old graph continues, run finishes `done`, version 2 `rejected`.
8. `propose` big with approval off (`requireApproval: async () => false`): applies at once with `size: 'big'`, `approvedVia: 'auto'`.
9. `propose` refused (400-class `Error`, run unchanged): changed `entry`; removed a node with an attempt; changed `instructions` of a node with an attempt — each message names the node title.
10. `propose` while a change is pending → `RunActionError` 409 `A change is already waiting`.
11. `propose` from a conversation whose `terminalId` does not own the run → 403 (reuse `owned()`).
12. Restart with a pending change: reload runner, `recover()`, the run stays `running` with version 2 pending and dispatches nothing; `approve` after reload dispatches.

Use a slow resolver (`sleep 0.3`) where a test needs the step still running when it proposes.

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
  - `changeSize` per the Decisions list. "Reachable through pass edges only": BFS from `entry` following `pass` edges.
  - `propose` inside `exclusive(id, …)`: `mustGet`, `owned(run, context)`, run must be live (`LIVE_STATUSES`) else 409 `Only a live flow can change`; pending later version → 409; `next = draftRevision(change.graph)`; guard rules from Decisions (throw plain `Error` naming the node title); `const resolved = await agentsFor(next)`; keep existing nodes' agents: `nextAgents = { ...resolved, ...pick(run.agents, existing node ids) }`; skills for new nodes via `snapshotSkills`; `size = changeSize(run, next, nextAgents, !!change.scopeGrew)`; `const waits = size === 'big' && await requireApproval()`; push `{ number: run.versions.length + 1, revision: next.revision, reason: change.reason, size, state: waits ? 'pending' : 'approved', approvedVia: waits ? null : 'auto', relayedBy: null, at: Date.now(), graph: next }`; if not waiting apply (`run.workflow = next; run.agents = nextAgents; run.skills = {...run.skills, ...newSkills}`); persist; if applied and the run is `running` with no unsettled attempt, `dispatch(run)`.
  - Keep `nextAgents`/`newSkills` for a pending version on the version record (`agents`, `skills` fields, same types as the run's) so approve can apply without re-resolving.
  - `dispatch`: return early when a version with `number > 1` is pending.
  - `approve`: when the pending version has `number > 1`: apply its `graph`, `agents`, `skills`, mark approved, persist, then dispatch if `running` and the last attempt is settled. `reject` of `number > 1`: mark rejected, persist, dispatch under the same condition.
  - `recover()`: no change needed beyond the dispatch guard (verify with example 12).
- [ ] **Step 4: Tests + typecheck green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(runner): running flows take small changes at once and big ones after approval`.

---

### Task 3: Routes and token scope

**Files:** `server/routes/studio.ts`, `server/auth.ts`, `test/studio-routes.test.ts`, `test/api-token-auth.test.ts`

- [ ] **Step 1: Failing tests**
  - `POST /api/studio/runs` with `graph` (no `sec-fetch-site`) → 200, `origin.source === 'drafted'`, `status === 'awaiting-approval'`; with a graph that breaks a rule → 400 whose `error` contains the rule text.
  - `POST /api/studio/runs/:id/changes` body `{ graph, reason, scopeGrew?, terminalId? | chat? }` → the run; big + approval on → `versions.at(-1).state === 'pending'`; wrong session (no `sec-fetch-site`, wrong `terminalId`) → 403; second proposal → 409.
  - `POST /api/studio/runs/:id/save` with `sec-fetch-site: same-origin` → 200 `{ id: 'add-csv-export', name: 'Add CSV export', revision }` for a run labelled "Add CSV export"; again → 409.
  - `allowToken('/api/studio/runs/x/changes', 'POST') === true`, `allowToken('/api/studio/runs/x/save', 'POST') === false`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** `/changes` → `runner.propose(params.id, changeBody.parse(body), approvalContext(request, body))` with `changeBody = z.object({ graph: z.unknown(), reason: z.string().trim().min(1).max(500), scopeGrew: z.boolean().optional() })`. `/save` → only when `fromBrowser(request)` (else 403 `Save from the drawer`), slug rule from Decisions, `store.save({ ...run.workflow, id: slug, name: run.label })` without `revision`/`createdAt` fields; existing id → `RunActionError(…, 409)`. Add `changes` to the `allowToken` regex alternation.
- [ ] **Step 4: Tests + typecheck green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(studio): propose changes to a running flow and save a drafted flow`.

---

### Task 4: Drawer shows proposals, drafts and auto-applied changes

**Files:** `server/run-view.ts`, `client/flow-graph.ts`, `client/flow-drawer.ts`, `server/views/shell.ts`, `public/quiet.css`, `test/run-view.test.ts`, `test/flow-graph.test.ts`, `test/flow-drawer.test.ts`, `test/flow-drawer-dom.test.ts`

**Produces:**
- `RunView` gains `proposal: { number: number; reason: string; nodes: RunStepView[]; edges: RunView['edges'] } | null` (the pending later version's graph, agents resolved) and `latestChange: { number: number; reason: string; size: 'small' | 'big'; approvedVia: ApprovalVia | null; state: string } | null` (the newest version with `number > 1`). `versions` entries are sent without `graph`/`agents`/`skills`.
- `StepState` gains `'proposed'`; `EdgeState` gains `'proposed'`.

Rules:
- `stepsFor` with a proposal: every proposal node not in `run.nodes` becomes a step `{ state: 'proposed', detail: 'Proposed' }`, laid out with the proposal's edges (the graph renders the union: proposal nodes and edges, with existing nodes' states from the run).
- `edgesFor` with a proposal: proposal edges not present in the run's edges → `'proposed'`; run edges not present in the proposal → still drawn, `'idle'`.
- `bannerFor`:
  - proposal pending → `{ tone: 'ask', text: '<By> wants to change the flow. <reason>', actions: ['keep', 'approve'] }` (button labels: Keep → `Keep v<active number>`, Approve → `Approve v<proposal number>`; both send `{ version: <proposal number> }`; Keep posts `/reject`).
  - `latestChange.size === 'big' && latestChange.approvedVia === 'auto' && run live` → `{ tone: 'notice', text: 'v<n> applied automatically. <reason> Approval is off, so it did not wait.', actions: ['approval-on'] }`; `approval-on` → `PUT /api/flow-approval { flowApproval: true }`, then the banner reads `Approval is on again.`
  - Draft waiting (`origin.source === 'drafted'`, version 1 pending) → text `<By> drafted a flow for this task. Nothing runs until you approve, or say "go" to <By>.`, same actions as Part 1.
- Header: drafted runs get a `Save as workflow` pill (`#flow-save`) → `POST /save`; success replaces its text with `Saved as <name>` and disables it; 409 shows the error in the banner.
- CSS: `.flow-step[data-state="proposed"]` = mock `fv-n[data-state="proposed"]` (1.5px dashed accent border, `#fbfaff`, detail `#6b4fb0`); `.flow-route[data-state="proposed"]` = accent, `stroke-dasharray: 3 4`; `.flow-mark[data-state="proposed"]` = accent ring with a `+` mask; `.flow-banner.notice` = `border-color: #bcd6c4; background: color-mix(in srgb, #dcece1 50%, var(--paper))`.

- [ ] **Step 1: Failing tests** — `run-view.test.ts`: a run with a pending version 2 exposes `proposal.nodes` including the new node with its engine and omits graphs from `versions`; `flow-graph.test.ts`: a `proposed` step renders `data-state="proposed"` and a `proposed` edge; `flow-drawer.test.ts`: `stepsFor`/`edgesFor`/`bannerFor` for a proposal (literal banner text and action list), for the auto-applied notice, and for a drafted flow waiting; `flow-drawer-dom.test.ts`: clicking `Approve v2` posts `/runs/<id>/approve` with `{"version":2}` and `Keep v1` posts `/reject` with `{"version":2}` (extend the fake `fetch` to record bodies).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): drawer shows proposed changes, drafts and auto-applied changes`.

---

### Task 5: Teach session AIs to draft and to change a flow

**Files:** `server/chat-profile.ts`, `server/terminals.ts` (`instructions`), `test/chat-profile.test.ts`, `test/terminals.test.ts`

- [ ] Add to the chat `## Flows` section and the terminal instructions, same wording in both (chat uses `"chat":"$MC_CHAT_ID"`, terminal uses `"terminalId":<id>`):

```
When no saved workflow fits, draft one: POST .../api/studio/runs with "graph" instead of "workflowId" — the same shape as a saved workflow from GET .../api/studio/workflows (id, name, entry, nodes with id/title/instructions/kind/agent, edges with source/target/outcome pass|fail|blocked). The server refuses a graph that skips plan verification before implementation or a different-family review after it. Keep drafts as small as the task allows.
To change a running flow: POST .../api/studio/runs/<id>/changes with {"graph","reason":"<one line why>","scopeGrew":true|false, <session field>}. Adding checks, tests or a fix loop applies at once; a new engine, a new implementation step, a dropped review, or scopeGrew true waits for the owner's approval in the drawer. Never mark scopeGrew false to avoid approval.
```

- [ ] Tests assert `"graph" instead of "workflowId"`, `/changes`, `Never mark scopeGrew false to avoid approval` in both texts. Commit `feat(instructions): session AIs can draft a flow and change a running one`.

---

### Task 6: Browser check

- [ ] Throwaway server (Part 1 Task 11 recipe: port 7795, temp config, `MC_FAKE_ENGINES=1`, `MC_FAKE_ENGINE_CMD=scripts/fake-pass-engine.sh`, roles `execute=claude review=codex`). Restore the skill link after starting it.
- [ ] Draft path: POST a drafted graph with a `check` task node; drawer shows `New flow drafted by …`, the draft banner, Save as workflow; approve; it runs.
- [ ] Small change mid-run: POST `/changes` adding a check node → applies, no banner, new step appears and runs.
- [ ] Big change mid-run: POST `/changes` adding an `implement` node on the pass path → ghost step + `Approve v2` / `Keep v1`; the running step finishes and nothing new starts; Approve → the new step runs; repeat and Keep → old path continues.
- [ ] Approval off: big change applies at once with the green notice; `Turn approval on` flips the Access switch.
- [ ] Save as workflow → appears in `GET /api/studio/workflows`.
- [ ] Screenshots compared with `docs/design/flow-drawer/d-terminal.html` and `d-auto.html`. Stop the server by task id; restore the skill link; delete the scratch repo.
