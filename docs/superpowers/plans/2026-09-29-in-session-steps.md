# In Session steps and fix loops — Implementation Plan

> **For agentic workers:** execute one task at a time. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A workflow step can be done "In Session": by the AI of the chat or terminal that started the flow, in that conversation where the user sees it, instead of by a background job. The built-in default workflow plans In Session and gains fix loops, so a failed plan check goes back to Plan and a failed review goes back to Build.

**Why:** the user could not see the plan agent's work, and a rejected plan ended the flow (the default had no fail edges; Retry re-checked the unchanged plan).

**Architecture:** `agent.engine: 'session'` is a reserved engine id. The runner resolves it to the owning session's engine and family. Dispatching an In Session step creates an attempt with `inSession: true`, no job, status `running`; the run waits. The session AI reads the attempt's composed `prompt`, does the work in its conversation, and reports through `POST /api/studio/runs/:id/steps/:nodeId`. The report settles the attempt through the same path a job's result takes (checks, workspace snapshot, routing). A chat is nudged through the existing chat report mechanism; a terminal AI keeps a background watcher.

## Global Constraints

- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- No emoji. `bun test`; `bunx tsc -p tsconfig.shell.json`; `bun run typecheck:studio`. One commit per task, no Co-Authored-By trailer, never push or merge.
- `bun test` and any server re-point `~/.claude/skills/mc-dispatch`; after the last test run restore it: `ln -sfn /Users/lynchz/Desktop/kingpinggroup/mission-control/skills/mc-dispatch ~/.claude/skills/mc-dispatch`.
- Never restart, stop or pkill the server on port 7777.
- Safety rules are unchanged: an In Session plan is still verified by the next step before implementation; an In Session review must differ in model family from the implementation it reviews.

## Decisions

1. **Reserved engine id `session`.** `nodeSchema` keeps `agent.engine: identifier.optional()`; the value `session` means In Session. A connection may not use the id `session` (connection store save → error `"session" is reserved for In Session steps`). `agent.model` on a session node is ignored.
2. **Resolution** (`agentsFor` in `server/workflow-runner.ts`): a node with `agent.engine === 'session'` resolves to `{ engine: <session engine>, model: <session model or null>, family: <family of that engine/model, same rules as builtins>, inSession: true }`, where the session engine is the terminal's `engine` (terminal runs) or the chat root job's `engine`/`model` (chat runs). With no owning session (a run started from Studio), it resolves like "Chat decides" (the role default) with no `inSession` flag. `ResolvedAgent` gains `inSession?: true`.
3. **Dispatch:** for an `inSession` agent, `dispatch` builds the attempt exactly as today (same checks, same composed `prompt`) with `inSession: true`, `jobId: null`, `status: 'running'`, token `working`, persists, and creates no job. `WorkflowAttempt` gains `inSession?: true` and `sessionNotifiedAt?: number | null` (null when created).
4. **Report** — `runner.report(id: string, nodeId: string, value: unknown, context: ApprovalContext): Promise<WorkflowRun>` inside `exclusive(id, …)`:
   - `mustGet`; `context.via !== 'conversation'` → `RunActionError('Only the session that owns this flow can report its step', 403)`; `owned(run, context)` (403 for another session).
   - Body schema `stepReportSchema = resultSchema.extend({ output: z.string().max(64000).optional() })` (`resultSchema` = the existing `{ outcome, summary, evidence }`). A `pass` with no evidence → `Error('A passing step needs evidence')` (400).
   - The run must be `running` or `paused`, and some token must be `working` on an attempt with `inSession: true` and `nodeId === nodeId`, else `RunActionError('That step is not waiting for the session', 409)`.
   - The attempt's `output` = `value.output ?? value.summary`; then the same code path a job result takes after `readNodeResult`: acceptance checks (outside the queue, per the existing design), workspace snapshot, `settled`, token `settled`, `advance(run)`. Refactor the job path so both share one function (for example `acceptResult(run, attempt, token, result, output)`); do not duplicate routing.
5. **Lifecycle:** `stop`/`finish` have no job to kill for an In Session attempt; `interrupt` marks it settled like others. `recover()` keeps a running In Session attempt waiting (it is not an interrupted job: no block). `retry` of a run whose failed step is In Session re-dispatches it (a fresh waiting attempt). `pause` does not affect a waiting In Session step; a report while paused settles it and routing waits for resume (existing deferred routing).
6. **Notify the chat:** runner `deps.onSessionStep?: (run: WorkflowRun) => void`, called after persisting a new In Session attempt. `server/index.ts` wires it to `chatFlusher.onSessionStep(run)`. For chat-owned runs the flusher queues a message into the chat, marked like a workflow report, with text `[workflow <name> · your turn] <step title> is In Session. Read it with GET /api/studio/runs/<id> (the attempt with "inSession": true has the full assignment in "prompt"), do it here with the user, then report it: POST /api/studio/runs/<id>/steps/<nodeId>.` and records `sessionNotifiedAt` on the attempt through `runner.markSessionNotified(id, attemptNumber, at)`. Terminal runs get no push.
7. **Route:** `POST /api/studio/runs/:id/steps/:nodeId` in `server/routes/studio.ts` → `runner.report(params.id, params.nodeId, body, approvalContext(request, body)).then(publicRun)`. Token-allowed: add `steps/<identifier>` to the `allowToken` studio run actions in `server/auth.ts`.
8. **Built-in default** (`defaultWorkflow()` in `server/workflows.ts`): the `plan` node gets `agent: { role: 'plan', engine: 'session' }`; add edges `{ source: 'verify-plan', target: 'plan', outcome: 'fail' }` and `{ source: 'review', target: 'execute', outcome: 'fail' }`. Plan instructions gain one sentence: `If an upstream plan check failed, revise the plan to fix every finding it lists.` Execute instructions gain: `If an upstream review failed, fix every finding it lists.` The default's revision hash changes; stored older default revisions still load.
9. **Studio** (`client/studio.tsx`, `client/studio-graph.ts`): the "Who should do it?" select gets `<option value="session">In Session</option>` right after "Chat decides"; help text for it: `The AI in the chat or terminal that started the flow does this step there, where you can see it.` `agentLabel` returns `In Session` for it. Provider lists and connection pickers never offer `session` as a connection.
10. **Run view and drawer:** `RunAttemptView.inSession: boolean`. An active In Session step's detail is `In Session · <AI name>` (for example `In Session · Claude`), keeping the engine logo. While one waits, the banner (when no approval/proposal/problem banner applies) is `{ tone: 'notice', text: '<Step title> is being done In Session by <AI name>. Talk to it here; the flow continues when it reports the step.', actions: [] }`.
11. **Instructions** (`CHAT_RULES` in `server/chat-profile.ts`, terminal instructions in `server/terminals.ts`): add one paragraph after the parallel-paths paragraph: `Steps whose agent is "In Session" are yours: the flow waits for you. When one is waiting (GET the run; the attempt with "inSession": true and status "running"), read its "prompt", do the step here in the conversation where the user can see it (for a plan: write the plan in your reply and invite changes), then report it: POST <MC_URL>/api/studio/runs/<id>/steps/<nodeId> with {"outcome":"pass|fail|blocked","summary","evidence":[...],"output":"<the full result, e.g. the whole plan>"} plus your terminalId or chat. A failed plan check sends the plan back to you with its findings; revise and report again. While a flow of yours is running, keep a background watcher on GET /api/studio/runs/<id> so you notice when a step waits for you.` (The chat version omits the watcher sentence; chats are nudged.)

## Preserve

- Runs without In Session steps behave exactly as today; all existing tests stay green (fixtures only gain new optional fields).
- Saved workflows keep their agents; only the built-in default changes.
- Approval, proposals, parallel paths and joins work with In Session steps (a path step may be In Session).

## Review Focus

1. A report from another session or from the browser → 403; a report for a step that is not waiting → 409; a report twice → second 409.
2. A server restart while an In Session step waits → still waiting after `recover()`; a report after restart settles it.
3. A failed In Session plan check loop: plan (In Session) pass → verify fail → plan waits for the session again with the verify findings in its `prompt` inputs.
4. An In Session review whose session family equals the implementation family is refused at start (static walk) and at dispatch.
5. Stop while an In Session step waits → `stopped`, nothing hangs; a late report → 409.

---

### Task 1: Server — schema, default, resolution, dispatch, report, route

**Files:** `server/workflows.ts`, `server/agent-connections.ts` (reserved id), `server/workflow-runner.ts`, `server/routes/studio.ts`, `server/auth.ts`; tests `test/workflows.test.ts`, `test/workflow-runner.test.ts`, `test/studio-routes.test.ts`, `test/api-token-auth.test.ts`, the agent-connections test file.

- [ ] **Step 1: Failing tests.**
  - workflows: `defaultWorkflow()` has `plan.agent.engine === 'session'` and both fail edges; `validateWorkflow(defaultWorkflow())` is `[]`.
  - connections: saving a connection with id `session` throws `"session" is reserved for In Session steps`.
  - runner (terminal-owned run with a fake terminal `{ engine: 'claude' }`, echo resolver for other steps): start default → approve → the `plan` attempt is `inSession: true`, `jobId: null`, `status: 'running'`, no job was created, `run.agents.plan` is `{ engine: 'claude', family: 'claude', inSession: true }`; `report(id, 'plan', { outcome: 'pass', summary: 'Planned', evidence: ['plan written'], output: 'THE PLAN' }, { via: 'conversation', terminalId })` → plan settled, next attempt `verify-plan` dispatched as a job, and that job's prompt contains `THE PLAN`.
  - runner: verify fails (resolver that fails verify once) → the next attempt is `plan` again, In Session, waiting; its `prompt` contains the verify summary.
  - runner: Review Focus 1, 2, 4, 5 — each with literal messages above.
  - runner: a Studio-started run (no terminal/chat) of the default resolves `plan` to the plan role engine with no `inSession`.
  - runner: `onSessionStep` is called once per new In Session attempt.
  - routes: `POST /api/studio/runs/:id/steps/plan` with a Bearer token and the owning `terminalId` → 200 and the run; with `sec-fetch-site: same-origin` and no Authorization → 403; `allowToken('/api/studio/runs/x/steps/plan', 'POST') === true`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** Decisions 1–5, 7, 8 (and the `onSessionStep` dep and `markSessionNotified` of Decision 6).
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(runner): steps can be done In Session by the AI that owns the flow`.

### Task 2: Studio, drawer, chat nudge and instructions (may run beside Task 1)

**Files:** `client/studio.tsx`, `client/studio-graph.ts`, `server/run-view.ts`, `client/flow-drawer.ts`, `server/chat-reports.ts`, `server/index.ts`, `server/chat-profile.ts`, `server/terminals.ts`; tests `test/studio-graph.test.ts`, `test/run-view.test.ts`, `test/flow-drawer.test.ts`, `test/chat-reports.test.ts`, `test/chat-profile.test.ts`, `test/terminals.test.ts`.

Contract from Task 1 (build against it; Task 1 lands the server side): `WorkflowAttempt.inSession?: true`, `WorkflowAttempt.sessionNotifiedAt?: number | null`, `ResolvedAgent.inSession?: true`, runner deps `onSessionStep?: (run) => void`, runner method `markSessionNotified(id: string, attempt: number, at: number): Promise<void>`. If Task 1 has not landed when you start, add only these optional type fields to `server/workflow-runner.ts` (types only) so you compile, and say so.

- [ ] **Step 1: Failing tests** — `agentLabel` for engine `session` is `In Session`; run view attempt carries `inSession`; `stepsFor` gives an active In Session step the detail `In Session · Claude`; `bannerFor` gives the notice text of Decision 10 with `actions: []`; chat flusher `onSessionStep(run)` for a chat-owned run queues a message starting `[workflow Plan, verify, execute, review · your turn] Plan is In Session.` and calls `markSessionNotified`, and does nothing for a terminal run or an already-notified attempt; `CHAT_RULES` and the terminal instructions contain `"In Session"` and `/steps/`; only the terminal text contains `background watcher`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** Decisions 6 (flusher side and `server/index.ts` wiring), 9, 10, 11.
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): In Session in Studio, the drawer, chats and session instructions`.

### Task 3: Browser check and dogfood

Throwaway server on port 7796 (`MC_FAKE_ENGINES=1`, fake pass engine, temp config dir under home): a terminal-owned default run waits at Plan with the drawer showing `In Session · <AI>` and the notice banner; a `curl` report as that terminal moves it to the plan check; Studio's select shows `In Session`. Then, on the live cockpit after the user restarts it, redo the dark theme with the orchestrating session planning In Session.
## Review fixes (decided after the plan review; they override the Decisions above where they differ)

R1. In Session is only for `plan` and `task` steps: `validateWorkflow` error `<title>: In Session is for plan and task steps` for `engine: 'session'` on any other kind. Also refused on any step inside a fork section: `<title>: In Session steps cannot run on a parallel path`. (Drafts and Part 2 changes go through the same validation.)
R2. The session gets its own assignment text: for an In Session attempt, `prompt` is composed with a session preamble instead of the worker core rules: `You are doing this step In Session, in your own conversation, where the user can see it. Do the step with the user; do not start other steps. When the user accepts the result (or says go), report it: POST <MC_URL>/api/studio/runs/<runId>/steps/<nodeId> with {"outcome":"pass|fail|blocked","summary","evidence":[...],"output":"<the full result>"} plus your terminalId or chat. If they ask for changes, revise first. A plan step must not change code.` followed by the same workflow/assignment slots.
R3. `GET /api/studio/runs/:id/steps/:nodeId` (token-allowed) returns only `{ runId, nodeId, title, kind, prompt, waitingSince }` for a waiting In Session attempt (404 otherwise). Instructions point there, not at the full run.
R4. Report hardening: accepted only while the attempt is `running` (a second report during checks → 409); the attempt is set to `checking` inside the queue and the checks run in the background, so the POST returns promptly with the run; reported `summary`, `evidence` and `output` go through `redactRunOutput`; the attempt records `reportedBy: { via, id, at }`.
R5. A plan step must not change code: the In Session attempt stores a `workspaceSnapshot` of `run.cwd` at dispatch; a `pass` report for a `plan` step whose snapshot (head or diffHash) changed → 409 `A plan step must not change code`.
R6. The owner must be alive and aware. Owner alive = terminal-owned: `terminals.get(id)` exists and its record has `inSessionAware: true` (new field, set only for terminals created with the new instruction text); chat-owned: the chat root job exists. Resolution (`agentsFor`, also called from `versionFor` with the run's owner so Part 2 changes keep In Session) marks `inSession` only when the owner is alive and aware; otherwise the step resolves to its role default as a job. At dispatch, an `inSession` step whose owner is no longer alive blocks the run with `The session that owned <title> closed; Retry runs it as an agent` and Retry then re-resolves it as a job. `recover()`: a running In Session attempt is left out of job adoption; owner alive → stays waiting (token `working`); owner gone → blocked with that message; an attempt that was `checking` → blocked as today.
R7. Family for chat runs: the session engine comes from the chat root job only (never the body's `engine`/`model`). A `verify-plan` step whose resolved family equals the In Session plan's family resolves to its role default instead.
R8. Crashes do not take fix loops: a job that exits unsuccessfully without an agent-reported `fail`, and a missing MC_RESULT, settle as `blocked` (no fail edge is followed); `fail` stays for agent-reported fails. Interrupted attempts (stop/retry) do not count toward `maxVisits`.
R9. Reminders:
   - Chat: the nudge is a chat report entry (not a user queue item) that re-reads the run when sent and is skipped unless that attempt is still waiting; `sessionNotifiedAt` is set only after the report job is created; `recoverAll` re-sends for waiting attempts never notified.
   - Terminal: `POST /api/studio/runs/:id/steps/:nodeId/remind` (browser only) writes one line into the owning terminal: `Mission Control: the flow "<label>" is waiting for you at "<step title>" (In Session). Read GET <MC_URL>/api/studio/runs/<id>/steps/<nodeId>, do it here with the user, then report it.` followed by Enter; for a chat it re-sends the nudge. Terminal instructions also say: while a flow of yours runs, keep a background command that exits when a step waits for you, e.g. an until-loop on GET /api/studio/runs/<id>/steps/<nodeId> returning 200.
R10. Drawer: an active In Session step's detail is `In Session · <AI> · <elapsed>` (live), its mark uses a new `session` state (accent ring, no pulse); the waiting banner gets its own mark and action `remind` (button `Remind <AI>`, posts `/remind`, shows `Reminded` for 4 s). Remove "Mission Control owns the steps; do not also do them yourself" from the new terminal text, replaced by "Mission Control runs the other steps."
R11. Studio: a `session` step shows a session icon (inline SVG, no provider image) and hides Model and Family; the Run workflow modal notes `In Session steps run as agents when started from Studio.`
R12. `docs/decisions/workflow-studio.md` gains a short "In Session" paragraph, including: users and terminals pinned to an older default revision keep the old default (no fix loops, no In Session) until they pick the new one.
