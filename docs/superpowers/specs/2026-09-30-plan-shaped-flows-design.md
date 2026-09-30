# Plan-shaped flows — design

Date: 2026-09-30 · Status: built, checked in the browser with the fake engine · Builds on: `docs/superpowers/specs/2026-09-28-real-session-flows-design.md` (parts 2 and 3)

## Intent

Every run today draws the same four boxes: Plan → Verify plan → Execute → Cross-family review. The engine can already run parallel paths that meet at a join (`server/workflows.ts:89-169`, `server/workflow-runner.ts:556-660`), the drawer can already draw them and show proposed steps as ghosts (`client/flow-drawer.ts:135-180`, `client/flow-graph.ts:96-152`), and a live run can already take a new version of its graph with approval (`server/workflow-runner.ts:884-917`). Nobody decides the shape: the Plan step is only asked for a text plan (`server/workflows.ts:51`), so a task that has two independent halves still runs as one straight line.

After this work the Plan step has a second job: decide whether the work splits into parallel paths, and say so in a small machine-readable block. Mission Control checks that block with plain code, turns it into a graph, and — once Verify plan passes — proposes it as the run's next version. The user sees the split as ghost steps and approves it (or, with flow approval off, it applies on its own). Most tasks still stay four boxes; a split appears only when the parts own separate files and share a written contract.

Success looks like: in a terminal, the user asks for "CSV export: API endpoint plus a UI button". The plan proposes two paths (API, UI) with disjoint files and a written column contract. Verify plan passes. The drawer shows the two paths and a join as ghosts with "Approve". The user approves; both paths run at once in their own worktrees; the join applies both; the cross-family review runs on the joined result. A review failure goes to a "Fix review notes" step, then back to review.

## Research basis

- LLMCompiler (planner emits a dependency graph, a scheduler runs ready tasks at once): the planner outputs structure, code does the scheduling. <https://arxiv.org/abs/2312.04511>
- Anthropic multi-agent research system: the lead agent decides the fan-out, needs explicit effort rules in its prompt, and coding parallelizes worse than research. <https://www.anthropic.com/engineering/multi-agent-research-system>
- Cognition, "Don't Build Multi-Agents": parallel coding agents make conflicting hidden decisions; shared decisions must be made before the split. <https://cognition.ai/blog/dont-build-multi-agents>
- Worktree playbooks: split by area with explicit, non-overlapping file ownership. <https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace>

A separate "graph designer" agent was rejected: it adds a handoff where plan context is lost. AFlow-style search over shapes is out of scope.

## Decisions

| Area | Decision |
| --- | --- |
| Who shapes | The Plan step (In Session or agent). No new agent. |
| Format | The AI writes intent, not a graph: an `MC_SHAPE` line with a contract and 2–4 paths of 1–3 steps. Code compiles it into a graph. |
| Where the rules come from | The runner adds the shape rules to the Plan (and Verify plan) assignment whenever the run's graph can take a shape. They are not written into the default blueprint, so no new default revision is needed and already-open terminals get the behavior. The composed prompt is stored on each attempt, so what the AI was told stays on record. |
| Plain-code checks | At plan report time: schema, path/step counts, no file or folder owned by two paths, the compiled graph passes `validateWorkflow`. |
| AI check | Verify plan also judges the split (worth it, contract complete, files really independent). |
| When applied | When Verify plan passes, before its token routes on. Proposed through the existing version mechanism, so a split is a `big` change and waits for approval when `flowApproval` is on. |
| Rejected split | The run continues on its current straight graph. |
| Fix step | The existing `execute` node stays in the graph, retitled "Fix review notes", reached only from review fail and join fail. |

## Shape format

The plan ends its output with one line, placed just before any `MC_RESULT` line:

```
MC_SHAPE {"contract":"...","paths":[{"id":"api","title":"API","files":["server/routes/export.ts","test/export.test.ts"],"steps":[{"title":"Build API","instructions":"..."},{"title":"API tests","instructions":"..."}]},{"id":"ui","title":"UI","files":["client/export-button.ts"],"steps":[{"title":"Build UI","instructions":"..."}]}]}
```

Schema (`shapeSchema` in `server/flow-shape.ts`):

- `contract`: text, 1–8000 chars. Everything the paths share (API shape, types, names, data format).
- `paths`: 2–4 items.
  - `id`: `^[a-z][a-z0-9]{0,19}$`, unique.
  - `title`: 1–60 chars.
  - `files`: 1–50 repo-relative paths (files or folders, up to 200 chars each). Rejected: absolute paths, `..` segments, wildcards (`*?[]{}`).
  - `steps`: 1–3 items of `{ title (1–120), instructions (1–12000) }`. These limits keep a compiled step under the 32000-char node instruction limit.

No `MC_SHAPE` line, or a line with fewer than two paths, means "stay straight". Parsing mirrors `readNodeResult` (`server/workflow-runner.ts:68-77`): the last matching line in the plan's final output wins.

## Rules given to the AI

`shapeNotes(workflow, node, upstreamOutputs)` (`server/flow-shape.ts`) returns the notes; the runner passes them to `composeWorkflowPrompt` (`server/workflows.ts:345-352`), which spreads them into the assignment. `flowShapeRules` is added when `shapeTarget(workflow)` is not null and the node is a `plan` node:

> Flow shape. After your plan, decide whether the work splits into parallel paths. Split only when all of these hold: the work has 2 to 4 parts that can each be built and tested on their own; each part owns its own files and no file or folder is listed by two parts; and everything the parts share (API shape, types, names, data format) is written in the contract, so no part has to guess what another decided. Otherwise do not split. Most tasks should stay one straight path; a split that saves little is not worth the merge risk. To split, put one line just before your MC_RESULT line: MC_SHAPE {"contract":"…","paths":[{"id":"api","title":"API","files":["…"],"steps":[{"title":"…","instructions":"…"}]}]}. Each path has 1 to 3 steps: the first builds, later steps check that path's own work and send it back to the first step when they fail. List files as repo-relative paths or folders, no wildcards. Mission Control turns this into parallel paths that meet at a join before review, and asks the user to approve the split.

Added as `flowShapeCheck` for a `verify-plan` node when the upstream plan output contains `MC_SHAPE`:

> The plan proposes a split (MC_SHAPE). Also check it: fail if any part needs a file another part owns, if the parts depend on anything missing from the contract, or if the work is too small or too connected to be worth splitting. Name the problem.

`sessionRules` (`server/workflows.ts:45-47`) gains one sentence: "If your result has an MC_SHAPE line, keep it in output."

## Plain-code checks at plan report

`checkShape(shape, workflow)` returns error strings:

1. Schema errors (as above).
2. File overlap: normalise each entry (strip `./` and a trailing `/`); two entries from different paths overlap when they are equal or one is a folder prefix of the other (`a` vs `a/b.ts`).
3. The compiled graph (below) must pass `validateWorkflow`.

Where the check runs:

- **In Session report** (`report()`, `server/workflow-runner.ts:729-752`): the shape is read from the redacted output (the same text stored as the step's output). For a passing plan with an `MC_SHAPE` line, errors reject the report with 400 and the messages, so the session fixes the plan and reports again. Nothing is recorded.
- **Agent plan** (`settle()`): errors do not fail the step. The shape is dropped, the run stays straight, and `Flow shape ignored: <errors>` is appended to the attempt's evidence so the drawer shows why.

A valid shape is stored on the plan attempt as `attempt.shape`.

## Compiling a shape into a graph

`shapeTarget(workflow)` finds the pattern the default graph has: a `verify-plan` node V with exactly one pass target E, where E is `implement` with exactly one pass target R of kind `review`, no node on a parallel path, and E not the entry. It returns `{ verify: V, execute: E, review: R }` or null. Custom blueprints that do not match simply never get shape rules.

`shapeGraph(workflow, shape)` returns a new graph (the input is not changed):

- V's single pass edge → one pass edge per path to that path's first step (V becomes the fork).
- Per path, nodes `path-<id>-<n>`: step 1 kind `implement`, later steps kind `task`, agent `{ role: 'execute' }`, instructions = the step's instructions + `Shared contract (do not change it): <contract>` + `Only change these files: <files>` + `This folder is a fresh copy of the repository; install dependencies first if the step needs them.` Chained with pass edges; each later step has a `fail` edge back to step 1; the last step passes to the join.
- One `join-paths` node (kind `join`, title "Join paths") → pass to R, fail to E.
- E keeps its id, kind and agent; title becomes "Fix review notes", instructions become "Fix every finding from the failed review or join in upstream evidence, following the verified plan. Run the relevant checks. Report files changed and real test evidence. Do not make a commit unless the request explicitly asks." Its existing pass edge to R and R's fail edge to E stay.

Checked against `validateWorkflow`: the fork is at V after a passed plan check, so every path's `implement` has a verified plan; loops stay inside one path; the join leads to a review, so nothing finishes unreviewed; E is reachable through fail edges. `guardChange` (`server/workflow-runner.ts:124-141`) allows it: V and the plan ran but their frozen fields are unchanged (edges are not frozen), E has not run, and the only token sits on V.

## Applying the shape

In `conclude()` (`server/workflow-runner.ts:523-531`), after a `verify-plan` attempt settles with `pass` and before `advance()` routes it:

1. Find the latest `plan` attempt on the same lineage before it that has `shape`. None → nothing happens.
2. `shapeTarget(run.workflow)` is null, or a version is already pending → nothing happens.
3. Build a version from `shapeGraph(...)` with reason `Plan splits the work into <n> parallel paths: <titles>` through `versionFor` (`server/workflow-runner.ts:904-917`), called directly inside the existing `exclusive` section (not through `propose()`, which waits on in-flight settlements and would deadlock). `versionFor` gains an internal mode that skips the `owned()` session check, and an `inherited` agent map: every step that already exists keeps the AI it resolved to in the current version, and each new path step takes the AI of the step it replaces (E). Without this, a chat run's split would re-resolve its unrun steps from the role defaults and silently move them off the chat's AI (found in the browser check: Execute and the paths moved from Claude to GLM).
4. Push the version. `approved` (flow approval off) → `applyVersion`, then `advance` routes V's token into the fork. `pending` → `advance` returns early because `changePending` is true; the token waits on V. Approve → `applyVersion` + `advance` → fork. Reject → `advance` routes the old straight edge to Execute.

The drawer needs no new work: pending versions already render as ghost steps with approve/reject (`client/flow-drawer.ts:135-180`).

## Out of scope

- Checking at join time that each path only changed its declared files (a join conflict already routes to the fix step).
- New setup or check commands from the AI (the existing rule forbids AI-invented commands, `server/workflow-builder.ts:27-31`).
- Choosing a different AI per path; paths use the execute role default.
- Auto-approving splits while `flowApproval` is on.
- Shapes for custom blueprints that do not match `shapeTarget`.

## Build order and tests

TDD, `bun test`, one file per module under `test/`.

1. `server/flow-shape.ts` + `test/flow-shape.test.ts`: `readShape` (last line wins, absent, malformed JSON), `shapeSchema` limits, `checkShape` overlap (equal files, folder prefix, `./` and trailing `/` normalisation, same path listing a file twice is fine), wildcard/absolute/`..` rejected, `shapeTarget` (default matches, custom linear without review does not, a graph that is already forked does not), `shapeGraph` output passes `validateWorkflow` for 2 and 4 paths and 1–3 steps, and the input graph is unchanged.
2. `composeWorkflowPrompt` in `test/workflows.test.ts`: plan assignment has `flowShapeRules` only when `shapeTarget` matches; verify-plan gets `flowShapeCheck` only when the upstream plan output has `MC_SHAPE`.
3. Runner in `test/workflow-runner.test.ts`: In Session plan report with overlapping files → 400, the step still waits; agent plan with a bad shape → the run stays straight and the evidence names the reason; verify pass with a shape and approval on → pending version, nothing dispatched, token on V; approve → both path first steps dispatched in their own worktrees; reject → Execute dispatched; approval off → fork dispatched with no pending version; verify fail → no version, back to Plan; review fail after the join → "Fix review notes" dispatched on `main`, then review again.
4. Browser check in the running app with the fake engine: the ghost fork and join appear on verify pass, Approve starts both paths, and the bands show each path's branch.

## Risks

- **Over-splitting.** The rules default to straight and Verify plan can fail a split that isn't worth it. Watch the first real runs; tighten the rules text if small tasks split.
- **Fresh worktrees lack installed dependencies.** The path instructions tell the agent to install them. If that proves slow, a later change can let the user attach fork setup commands to the default.
- **Changed prompts for already-pinned terminals.** The rules are added by the runner, not the pinned blueprint, so existing terminals change behavior. The approval gate means no split runs unseen while `flowApproval` is on.
