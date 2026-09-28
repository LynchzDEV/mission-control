# Real session flows — design

Date: 2026-09-28 · Status: draft for review · Drawer decision: `docs/design/flow-drawer/DECISION.md` (variant D)

## Intent

The Session flow drawer should show **how the AI working in a session will get the current task done, step by step, and where it is right now**. Today it draws a synthesized shape ("Direction → one box per job thread → Your review", forced into three columns by `client/awareness.ts:36-63`) that has nothing to do with how the work actually runs.

After this work, a flow is a real, executable plan:

- The session's AI (the cockpit chat's AI, or Claude Code / Codex running in a cockpit terminal) picks a saved workflow that fits the task, or drafts a new one when none does.
- The user approves the flow once, then Mission Control runs it: each step is an agent job, and steps advance on their own from each job's pass / fail / blocked result.
- Flows can take any shape: retries and fix loops, back-and-forth wiring, parallel paths that each run in their own git worktree and meet at a join.
- The drawer shows the run live, pushed from the server.
- Quick work (a short bug investigation, a small UI tweak) gets no flow. The AI decides.

Success looks like: in a terminal running Codex, the user asks for a feature; Codex drafts a flow with two parallel paths; the drawer shows it greyed out with "Approve and run"; the user approves; both paths run at once in separate worktrees; a failing test step loops back to its build step on its own; the join cherry-picks both paths together; the cross review passes; the drawer shows each step turning green within a second of its job finishing.

## Decisions (made with the user in the brainstorm)

| Topic | Decision |
|---|---|
| Engine | Studio workflows (`server/workflow-runner.ts`) become the single engine. The plan runner, picture-only plans and the synthesized drawer shape are removed. |
| Who picks the flow | Any session AI: saved workflow when one fits, drafted flow when none does. |
| When there is a flow | Only for work with several steps or several agents, decided by the AI. Quick work runs directly as plain jobs. |
| Approval | One approval of the flow before it runs. A big mid-run change is a new version and asks once more. Small mid-run changes apply on their own. A drawer click or a "go" relayed by the AI both approve; the source is recorded. A setting turns all approval off. |
| Shape | Loops on failure, back-and-forth wiring, parallel paths (one git worktree each), joined by cherry-pick; a conflict becomes a fix step. |
| Drawer | Variant D, live by push. Sub-agents show inside their step, not as boxes. |
| Delivery | Four parts, in order 1 → 2 → 3 → 4, each shippable alone. |

## What exists today (evidence)

- `server/workflow-runner.ts` executes a saved graph: one job per node (`dispatch()` :156-184), advances on the `MC_RESULT` outcome (`settle()` :249-283), enforces visit limits, acceptance checks, plan verification and cross-family review, supports stop/retry. Runs persist to `<configDir>/workflow-runs/<id>.json`. Routes: `server/routes/studio.ts:63-71`.
- Runs already carry `terminalId` / `chatId` / `chatTurn`; jobs carry `workflowRunId` / `workflowNodeId` / `workflowAttempt` (`server/jobs.ts:56-58`).
- The chat AI is already told how to start a run (`server/chat-profile.ts:27`); terminal CLIs get `MC_URL`, `MC_TERMINAL_ID`, the config dir and instructions at spawn (`server/terminals.ts:223-236`). The mc-dispatch skill is mirrored into Codex's skills dir automatically (`server/engine-assets.ts:108-140`).
- Studio's graph is one token at a time, one edge per node outcome (`server/workflows.ts:22-26`, `docs/decisions/workflow-studio.md:27`). The whole run shares one workspace.
- The drawer reads `/api/flow` (plans + synthesized stages) and polls every 3 s (`client/shell-activity.ts:339`). Studio runs never reach it: `workflow-runner.ts` never writes to the plan store.
- Job worktrees and cherry-pick landing exist: `prepareWorktree()` (`server/job-worktrees.ts:16`), land with conflict detection (`server/jobs.ts:740-745`).

## Architecture

```
session AI (chat / Claude Code / Codex)
   │  GET  /api/studio/workflows          pick a saved workflow
   │  POST /api/studio/runs               start (saved id, or drafted graph in part 2)
   │  POST /api/studio/runs/:id/approve   relay the user's "go"
   │  POST /api/studio/runs/:id/changes   mid-run edit (part 2)
   ▼
workflow-runner  ── run record (+ session, origin, versions, approval state)
   │  dispatch/settle per node · tokens per parallel path (part 3)
   │  emits run-changed / job-changed
   ▼
run-events (new)  ── SSE  GET /api/studio/events?chat=|terminal=
   ▼
drawer (client/flow-drawer.ts + flow-graph.ts)  ── variant D
```

### Run record changes (`server/workflow-runner.ts`)

Added to `WorkflowRun`:

- `origin: { source: 'saved' | 'drafted'; by: string; where: 'chat' | 'terminal' }` — `by` is the engine/provider name of the session AI (from the terminal record or chat root job), not free text from the caller.
- `versions: RunVersion[]` where `RunVersion = { number: number; workflow: WorkflowRevision; reason: string; size: 'initial' | 'small' | 'big'; state: 'pending' | 'approved' | 'rejected'; approvedVia: 'drawer' | 'conversation' | 'auto' | null; relayedBy: string | null; at: number }`. `run.workflow` stays the active version's graph so existing code keeps working.
- `status` gains `'awaiting-approval'` and `'paused'`.

A run starts in `awaiting-approval` (no node dispatched) unless approval is off, in which case version 1 is recorded `approvedVia: 'auto'` and the entry node dispatches immediately.

### Approval

- `POST /api/studio/runs/:id/approve { version }` and `/reject { version }`.
- The source is decided by the server from the request, never from the body. A curl call from localhost passes `localRequestAllowed()` just like the browser does (`server/local-access.ts:38-44`), so the signal is the `Sec-Fetch-Site: same-origin` header that browsers send on every fetch: with it → `approvedVia: 'drawer'`; without it (a session AI's curl) → `approvedVia: 'conversation'` with `relayedBy` = the run's origin AI. This keeps the record honest; it is not a security boundary, since both come from processes on the owner's machine. A run started from the browser (Studio's Run button) is recorded `approvedVia: 'user'` and does not wait.
- Setting: `AppConfig.flowApproval: boolean` (default `true`) in `server/secrets.ts`, served by `GET/PUT /api/flow-approval` (local only) and shown as an "Ask me before a flow runs" switch in the Access dialog (Studio has no settings panel).
- Approving version 1 dispatches the entry node. Approving a later version switches `run.workflow` to it at the next node boundary (see live edits). Rejecting version 1 sets the run to `stopped`; rejecting a later version keeps the current one.

### Session AI interface

All through the existing token-allowed `/api/studio/*` routes (`server/auth.ts` `allowToken()`), plus the new approve / reject / changes / pause / resume routes added to that allow-list. The events stream stays browser-only; no session AI needs it.

- **Picking:** `GET /api/studio/workflows` returns saved workflows with name and a one-line description (add `description` to the workflow schema, optional, ≤200 chars). The terminal's pinned workflow (`server/workflow-runner.ts:202-207`) becomes the default when the AI names none; it is no longer a lock, since the user approves the flow anyway.
- **When to use a flow** (instruction text, same in all three places): use a flow for work with more than one step that changes code, or that needs more than one agent. Run quick investigations, questions and small single-file edits directly, without a flow.
- **Instructions updated in:** `server/chat-profile.ts` (`CHAT_RULES`), `server/terminals.ts:225` (terminal instructions), `skills/mc-dispatch/SKILL.md` (Claude; Codex receives the translated copy through `engine-assets.ts`). The plan-runner and `/api/flow/<label>/plan` sections of the skill are removed.
- **Waiting for approval:** after `POST /api/studio/runs`, the AI tells the user the flow is waiting in the drawer, and if the user says "go" in the conversation, calls `/approve`. It does not poll in a loop; the run proceeds on its own once approved.

### Live push

- New `server/run-events.ts`: an in-process emitter. `workflow-runner.ts` emits on every `persist()`; `JobManager` emits when a job linked to a run (`workflowRunId`) or to a chat/terminal scope starts or settles (`onJobSettled` already exists at `server/jobs.ts:284,459`; add the start hook).
- `GET /api/studio/events?chat=<id>|terminal=<id>`: SSE, same framing and 15 s heartbeat as `createLogStreamResponse` (`server/routes/jobs.ts:135-193`). Each event carries the run summary needed to draw the drawer (nodes, edges, per-node state, attempts, versions, pending change) or a job summary for no-flow work.
- Client: `EventSource`; on error it reconnects with backoff and does one full `GET` to resync. The 3 s poll for the drawer is removed.

### Drawer (variant D)

- New `client/flow-drawer.ts` owns the drawer: scope (from the existing `quiet:activity-scope` / chat events), the SSE connection, header, banner and the no-flow list. `client/flow-graph.ts` becomes the canvas renderer: takes nodes with positions, edges with outcome + state, and draws per DECISION.md (arcs for back-edges, dashed conditional steps, ghost proposed steps, path bands in part 3). Node state comes from `nodeRunStates()` in `client/studio-graph.ts:40-47` (plain TS, reusable).
- Layout: the graph's own Studio positions (`node.position`) are used when present; drafted graphs without positions get a left-to-right layered layout (longest-path layering, back-edges drawn as arcs). Zoom / pan and fit in part 4.
- Several runs in one session: the header title becomes a menu of the session's runs, newest first; the running one is selected by default.
- Buttons: Pause / Resume (new runner state: running nodes finish, no new node dispatches), Open in Studio (existing canvas run view), Approve / Reject / Keep, Retry and Stop when a run is blocked or failed (existing routes).
- Sub-agents: the step's detail line shows the count from the job's activity (`server/activity.ts` `Task`/`Agent` tool calls); clicking a step opens the existing job detail (Agents drawer row).

### Drafting and live edits (part 2)

- `POST /api/studio/runs` accepts `graph` (a full workflow object) instead of `workflowId`. It is validated by the same `validateWorkflow()` rules (plan verified before any implement step, cross-family review after implementation, reachable finish, visit limits) plus the part 3 parallel rules. A drafted flow is run-local; the drawer offers "Save as workflow" to keep it.
- `POST /api/studio/runs/:id/changes { graph, reason, scopeGrew?: boolean }` proposes a new version. The server classifies it; the AI's own `scopeGrew: true` forces big:
  - **Big:** adds an engine family not already in the run; lowers the number of review steps; adds an implement step reachable on a pass path; or `scopeGrew`.
  - **Small:** anything else — adding or removing check / test / task steps, adding a fix loop (an implement step reachable only through fail edges that returns into the flow), changing retry limits, rewiring fail edges.
- Edits may not remove or rewire a step that is running or already finished; those stay as recorded history.
- Small changes apply at once (new version, `size: 'small'`, `approvedVia: 'auto'`). Big changes become a pending version: running steps continue, no new step dispatches until the user approves or keeps the old version. With approval off, big changes apply at once and the drawer shows the green notice.

### Parallel paths (part 3)

- Schema: a node may have several `pass` edges (a fork). New node kind `join` with no agent: it waits until every path from its fork has arrived, then cherry-picks each path's commits onto the run's main workspace, in path order. Fail and blocked keep one edge per node.
- Validation adds: every fork's paths meet at exactly one join; no edge crosses from one open path into another; loops stay inside one path or wrap the whole fork-join section; nested forks are allowed.
- Runner: `currentNodeId` becomes `tokens: { id, nodeId, pathId, workspace }[]` (keep `currentNodeId` as the first token's node for older readers). Each path gets its own worktree via `prepareWorktree()` on a branch named `flow/<run-label>-<path-id>`; the workspace-exclusivity check (`claimWorkspace`) applies per worktree.
- Join conflicts: the cherry-pick is aborted (same as `server/jobs.ts:744`) and the join's outcome is `fail` with the conflicting files as evidence, so the graph's fail edge (normally a fix step) takes over. No fail edge → the run is blocked with the file list.
- `docs/decisions/workflow-studio.md` is updated: fan-out is now supported with the rules above.

### Drawer for big graphs (part 4)

Zoom, pan, fit; path bands with worktree labels; collapsing a finished fork-join section to one summary box; follow the running step. Shapes from parts 2 and 3 are the test cases.

### Removed

- Server: `server/plans.ts`, `server/plan-runner.ts`, `server/routes/runs.ts`, the plan and archive endpoints and `GET /api/flow` in `server/routes/flow.ts`, and `server/flow.ts` except `countPendingReviews` (moved next to its only user, `server/routes/meta.ts`). Wiring in `server/index.ts`; `allowToken()` entries in `server/auth.ts`. `server/archive.ts` loses its `Plan` dependency.
- Client: `client/plan-view.ts`, the plan/stage parts of `client/work.ts`, `flowSteps` / `flowColumns` in `client/awareness.ts`, the `/api/flow` fetches and 3 s poll in `client/shell-activity.ts`, the old `#flow` markup in `server/views/shell.ts:69-75`.
- Skill: the plan and plan-runner sections of `skills/mc-dispatch/SKILL.md`, the `/api/flow` token probe (use `/api/meta` instead).
- Tests for removed modules are deleted with them (`test/plans.test.ts`, `test/plan-runner.test.ts`, `test/runs-routes.test.ts`, `test/flow.test.ts`, `test/flow-routes.test.ts`, `test/plan-view.test.ts`, and the removed parts of `test/work.test.ts` / `test/awareness.test.ts`); tests that assert `/api/flow` auth behaviour (`test/api-token-auth.test.ts`, `test/auth.test.ts`, `test/views.test.ts`) switch to the new routes.

Existing saved plans in `plans.jsonl` are not migrated; they were display-only.

## Parts and acceptance

1. **Real runs in the drawer.** Run record + approval + `flowApproval` setting + pause/resume + SSE + drawer D for runs (saved workflows, one path) and the no-flow list + instruction updates for picking saved workflows + removals. Accepted when: a Codex terminal and the chat each start a saved workflow; the drawer shows it waiting, approve works from the drawer and from a relayed "go" with the right source shown; steps change state in the drawer within 1 s of the job settling; with approval off the run starts at once; quick work shows the plain list; nothing reads `/api/flow` any more.
2. **Drafting and live edits.** Inline `graph` on start, "Save as workflow", `/changes` with the small/big classifier, pending-version banner and ghost steps. Accepted when: a drafted flow that breaks a safety rule is rejected with the rule named; a fix loop added mid-run applies silently; an added engine waits for approval while running steps continue.
3. **Parallel paths.** Fork/join schema and validation, per-path worktrees, token runner, join cherry-pick with conflict → fail edge. Accepted when: two paths run at the same time in two worktrees; the join lands both; a forced conflict routes to the fix step.
4. **Drawer for big graphs.** Zoom/pan/fit, path bands, collapse, follow. Accepted against a 20+ step flow with two forks and loops.

## Error handling

- Invalid graph or unknown workflow: 400 with the validation messages; nothing is created.
- Engine missing or out of quota at dispatch: the step is blocked with the reason; the drawer shows Retry / Stop (existing behaviour).
- Server restart mid-run: runs are re-read from disk (existing); tokens and pending versions are part of the persisted record. SSE clients reconnect and resync.
- Approve on a version that is no longer pending (double click, or drawer and conversation at once): 409, the first approval wins, the drawer refreshes.
- Relayed approval from a session that does not own the run (different chat / terminal): 403.

## Testing

`bun test`, one file per module under `test/` (existing convention). New or extended: `test/workflow-runner.test.ts` (approval states, versions, pause, change classification, tokens / fork / join / conflict), `test/workflows.test.ts` (fork/join validation), `test/studio-routes.test.ts` (approve source from auth, 403/409 cases, events stream), `test/run-events.test.ts`, `test/flow-graph.test.ts` (layered layout, arcs, ghost steps), `test/flow-drawer.test.ts`. The chat and terminal instruction text is asserted in `test/chat-profile.test.ts` / terminal tests. Each part is also checked in the running app with the fake engine and a browser (drawer states from DECISION.md, live updates, approval sources).

## Risks

- `skills/mc-dispatch/SKILL.md` has uncommitted changes from another session in the working tree. Part 1 rewrites sections of that file; those changes must be committed or set aside by their owner first.
- Parallel paths raise the chance of cherry-pick conflicts at the join; the fix-step route keeps that inside the flow rather than failing the run.
- Relayed approval trusts the session AI to relay the user's intent. The recorded source keeps it visible, and the 403 rule stops one session approving another's run.
