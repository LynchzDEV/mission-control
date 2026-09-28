# Real Session Flows — Part 4 Implementation Plan (drawer for big graphs)

> **For agentic workers:** execute one task at a time, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The drawer stays readable for a 20+ step flow with parallel paths and loops: it zooms, pans and fits; follows the working step; draws each path as a labelled band; collapses a finished fork-join section to one box; opens a step's job on click; opens the run in Studio; shows sub-agent counts.

**Architecture:** Pure layout/transform functions in `client/flow-graph.ts` and a new `client/flow-viewport.ts`, tested without a browser. The graph renders into a persistent `#flow-canvas` inside `#flow-stage`; only the canvas carries the pan/zoom transform, so repaints never reset it. The run view's `sections` (from Part 3) is extended to every section of the graph with a state. Sub-agent counts come from the job manager's line-buffered activity stream and reach the drawer through the existing run events.

**Spec:** `docs/superpowers/specs/2026-09-28-real-session-flows-design.md` ("Drawer for big graphs (part 4)", "Drawer (variant D)" deferred items). Look: `docs/design/flow-drawer/DECISION.md`, `docs/design/flow-drawer/d-terminal.html`.

## Global Constraints

- Part 1–3 Global Constraints apply (comment rule, no emoji — SVG icons only, flat inputs, `bun test`, both typechecks, one commit per task, no `Co-Authored-By`, never push or merge, restore the skill link after the last test run: `ln -sfn /Users/lynchz/Desktop/kingpinggroup/mission-control/skills/mc-dispatch ~/.claude/skills/mc-dispatch`).
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- Motion: allowed only when `motionAllowed() && !matchMedia('(prefers-reduced-motion: reduce)').matches`.
- CSS tokens that exist: `--r-lg`, `--muted`, `--accent`. There is no `--mono`: use `Menlo, monospace`. Band fill `#e2e6f080`.

## Decisions

### Viewport (Task 1)

- Markup: `#flow-stage` contains a persistent `<div id="flow-canvas" class="flow-canvas">` and, beside it (not inside), `<div class="flow-zoom">` with buttons `−` (`aria-label="Zoom out"`), `+` (`Zoom in`), `Fit`, `Follow` (`aria-pressed`). `renderRunGraph` renders into `#flow-canvas`. `.flow-run` loses its auto margins; the canvas has `transform-origin: 0 0` and the transform `translate(x, y) scale(s)`.
- Stage: `overflow: hidden`, `touch-action: pan-y`, `role="group"`, `tabindex="0"`, `aria-label="Flow graph. Arrow keys pan, plus and minus zoom, 0 fits"`. Height `clamp(120px, <content height × scale + 32px>, min(46vh, 420px))`, set in px by the viewport. The zoom controls are hidden when the fit scale is 1 and nothing overflows.
- Scale range 0.35–1.5 (0.2 when the stage is narrower than 600px). Fit never scales above 1. When fit is clamped at the minimum, align the entry step to the left edge instead of centring.
- Pointer: handlers on the stage with `setPointerCapture` on the stage; a move over 4px is a pan and suppresses the click that follows. Two pointers pinch-zoom around their midpoint. `wheel` is registered `{ passive: false }`: ctrl/meta + wheel zooms by `exp(-deltaY × 0.0015)` around the pointer (deltas × 16 when `deltaMode === 1`); plain wheel pans by deltaX/deltaY only when the content overflows the stage, otherwise the page scrolls. Safari `gesturechange` is not handled (trackpad pinch there sends ctrl+wheel).
- Keyboard on the stage: `=`/`+` zoom in, `-` zoom out, `0` fit, arrow keys pan 40px. On `focusin` of a card: reset `stage.scrollLeft/scrollTop` to 0, then follow that card.
- Fit / Follow order on each paint: fit when the user has not moved the view since the last fit (only user gestures count as moving); then, when Follow is on and the active steps' box is not fully visible, follow. `followView` keeps the scale unless the box is wider than the stage, then zooms out to fit the box (not below the minimum). With no active step, Follow targets the failed/blocked step, else the entry. User pan/zoom turns Follow off; Fit or Follow turns it on. A `ResizeObserver` on the stage refits (or follows, if the user has moved the view); a 0×0 stage is skipped.
- View state (transform, Follow, "moved") is kept per run id in memory for the page's life; closing the drawer or an SSE reconnect does not reset it.
- `mountViewport(stage, canvas, { animate: () => boolean, size?: () => { width: number; height: number } })` — `size` defaults to the stage's client size and is injected by tests.

### Sections, lanes, bands, collapse (Task 2)

- **One `sections` field** (extends Part 3's; no second field): `RunView.sections: { fork: string; join: string; state: 'waiting' | 'open' | 'joined' | 'conflict'; joined: string[]; paths: { nodes: string[]; title: string; firstNodeId: string; pathId: string | null; branch: string | null }[] }[]`, built from `forkSections(run.workflow)` outermost first. `open`: the run has an open section for the fork (fill `pathId`, `branch`, `joined` from it). `joined`: the latest join attempt settled `pass` and the section is not open. `conflict`: the latest join attempt settled `fail` and the section is not open; the unjoined paths' `branch` comes from `run.keptBranches`. Otherwise `waiting`. Path `title` = its first step's title. Part 3's `Waiting for <k> of <n> paths` reads `paths.length` from this shape. `keptBranches` stays top level.
- **Layout (replaces Part 3's BFS + join shift):** column = longest `pass`-path rank from the entry (fail/blocked edges ignored; back edges into a step already ranked are ignored), so a join sits right of all its sources. A step reached only through fail/blocked edges takes its source's column. Rows: each section path gets a lane block; steps outside every section sit on row 0 (the fork's row). Row counters are keyed by `(column, lane)`; a lane block's height is measured after placement (second pass), so chained fixes and nested sections push the next lane down. Each path reserves an 18px label strip above its first row.
- `layoutRun(steps, edges, entry, sections?)` returns `{ placed, bands, width, height }`, where `bands: { key: string; x: number; y: number; width: number; height: number; label: string; branch: string | null }[]` and width/height include bands, labels and back-edge dips. Back edges route below the lowest band they span.
- **Bands:** one per path of a `waiting`/`open`/`conflict` section and of an expanded `joined` section, drawn behind edges, `pointer-events: none`. Label `<title> path`, plus ` · <code>branch</code>` when open, or ` · kept on <code>branch</code>` for a conflict path with a kept branch. Labels: 11px, `var(--muted)`, `max-width` = band width, ellipsis.
- **Collapse:** a `joined` section collapses by default into one step `{ id: 'section:<fork>', title: 'Parallel · <path titles joined by " + ">', detail: 'Done · <duration>', state: 'done', kind: 'join', engine: '' }` (duration: from the first path attempt that started after the latest fork attempt ended, to the latest join `pass` end). It replaces the section's path steps and its join. The fork's pass edges into the section become one edge fork → box (`done`); edges out of the join start at the box; edges inside vanish. Sections are processed outermost first; inner sections of a collapsed outer section are skipped; an inner collapsed section inside an expanded outer path becomes its box inside that path's band. Collapse follows `state` only: when a loop re-enters and the fork runs again, the section is `open` and therefore expanded. Clicking the box expands it (per run id, in memory); an expanded joined section shows a `Collapse` button on its first band (`pointer-events: auto`).
- **Cards are identified by id:** `data-step="<id>"`. The 1 s ticker updates details by id from the last painted, composed step list; the box has no `since`.
- **Motion:** draw-in only on the first render of a run id. On expand/collapse, the clicked box keeps its screen position (adjust the translate by its placed x/y delta).

### Step click, Studio, sub-agents (Task 3)

- **Cards:** `role="button"`, `tabindex="0"` when the step has an attempt, `title="<title>"`, `aria-label="<title>, <detail>, open its agent"`; the collapsed box has `aria-expanded`. The graph wrapper has `role="list"` only if cards keep `listitem`; use `role="group"` on the wrapper. Clicks are delegated on the stage using the `data-step` of the pointerdown target; a pan suppresses the click. After each repaint, focus returns to `[data-step="<id>"]` if a card had focus before.
- **Open the job:** the drawer dispatches `quiet:agent-open` `{ jobId }` (latest attempt's job). `client/shell.ts` handles it with the existing `showAgents()` (docked `show()` on desktop, modal on mobile) and sets `aria-expanded`. `client/shell-activity.ts` stores the pending job, forces a refresh (reset its signature, await any in-flight refresh), finds the row with `row.jobId === jobId`, opens it only if not already open, and scrolls it into view. If the job is not among the rows (for example a finished job in a terminal scope, whose list only has running work), it adds a one-off row for it from `GET /api/jobs` (any status) and opens that. Only when `/api/jobs` does not have it either does it dispatch `quiet:agent-open-missing` `{ jobId }`; the drawer shows `That step's job is no longer available.` on a separate transient line under the banner for 4 s, never replacing an approval banner.
- **Open in Studio:** header pill `#flow-studio` `Open in Studio` (all runs; at ≤600px it moves into the run menu). It dispatches `quiet:studio-run` `{ runId }`. `client/shell.ts` records `beforeStudio = currentView()` exactly as the `#open-studio` click does, then shows Studio. `client/studio.tsx` keeps a module-level `pendingRunId` set by a top-level listener, consumed on mount and on each event with functional setters: `go('runs')`, load `/runs/<id>`, scroll that run into view.
- **Sub-agents:** counted in `collectActivity` in `server/jobs.ts` (already line-buffered). A line counts when it is a Claude stream-json assistant message with `parent_tool_use_id` null and a `tool_use` block named `Agent` or `Task`; each tool_use id once (per-job `Set`, dropped at settle). `JobRecord.subAgents` is persisted with `Math.max` like `turns`, so restarts and re-tails keep it. A new `options.onJobProgress(job)` fires when the count changes; `server/index.ts` wires it to `runEvents.changed()`. `runView(run, jobsById?)` fills `RunAttemptView.subAgents` (`scopeSnapshot` already has the jobs). Codex and other engines show 0. Detail for an active step with n > 0: `<n> sub-agents · <elapsed>` (`1 sub-agent`), with `Try <k> · ` first when retried.

## Preserve

- Every Part 1–3 drawer behaviour and test: banners, approval buttons, run menu, quick-work list, proposed/removed/changed steps, parallel step states, `Waiting for <k> of <n> paths`.
- A flow of up to 6 steps with no fork: scale 1, no zoom controls, stage height fits the content.
- `renderRunGraph`'s paint-signature short-circuit.

## Review Focus

1. Two SSE snapshots mid-drag leave `#flow-canvas.style.transform` unchanged. (Task 1)
2. A loop around a whole section (`review --fail--> plan`) re-opens a joined section: after the fork runs again it is `open` and expanded. (Task 2)
3. Clicking a finished step in a terminal session opens its job in the Agents panel, not the missing banner. (Task 3)
4. Reduced motion (OS setting or the app's pause) — no transition and no `animate` call. (Task 1)
5. The fixture lays out with no intersecting cards, no intersecting sibling bands, and no band label over a card; `review`, `split2` and `notify` sit on the plan's row. (Task 2)

## Fixture `test/fixtures/big-flow.json` (created in Task 2)

22 steps. Ids and kinds (engine in brackets; `review`-kind steps use role review = codex, all others claude):
`plan` plan · `verify` verify-plan [codex] · `split` task · path 1: `api` implement → `api-tests` task (`--fail--> api-fix` implement `--pass--> api-tests`) · path 2: `ui` implement → `ui-split` task ⇉ [`ui-copy` task, `ui-style` task] → `ui-join` join → `ui-check` task · `join` join (`--fail--> merge-fix` implement `--pass--> review`) · `review` review [codex] (`--fail--> merge-fix`) · `split2` task ⇉ [`docs` task, `demo` task] → `join2` join → `changelog` task → `release-check` task → `notify` task.
Pass edges: plan→verify→split; split→api, split→ui; api→api-tests→join; ui→ui-split; ui-split→ui-copy, ui-split→ui-style; ui-copy→ui-join, ui-style→ui-join; ui-join→ui-check→join; join→review→split2; split2→docs, split2→demo; docs→join2, demo→join2; join2→changelog→release-check→notify. Titles: the id with dashes as spaces, first letter capitalised. It must pass `validateWorkflow` (one test in `test/workflows.test.ts`).

---

### Task 1: Zoom, pan, fit and follow

**Files:** Create `client/flow-viewport.ts`; modify `client/flow-graph.ts`, `client/flow-drawer.ts`, `server/views/shell.ts`, `public/quiet.css`; tests `test/flow-viewport.test.ts`, `test/flow-drawer-dom.test.ts`, `test/shell.test.ts` markers if needed.

**Produces:**

```ts
export type View = { x: number; y: number; scale: number }
export function scaleRange(stageWidth: number): { min: number; max: number }  // 0.35/0.2 and 1.5
export function fitView(content: { width: number; height: number }, stage: { width: number; height: number }, padding?: number): View
export function zoomAt(view: View, factor: number, point: { x: number; y: number }, range: { min: number; max: number }): View
export function followView(view: View, box: { x: number; y: number; width: number; height: number }, stage: { width: number; height: number }, range: { min: number; max: number }): View
export function mountViewport(stage: HTMLElement, canvas: HTMLElement, options: { animate: () => boolean; size?: () => { width: number; height: number } }): { paint(runId: string, content: { width: number; height: number }, focus: { x: number; y: number; width: number; height: number } | null): void; forget(runId: string): void }
```

- [ ] **Step 1: Failing tests** — `fitView({width: 2000, height: 300}, {width: 1000, height: 400})` → `scale` 0.484 (padding 16: `(1000 − 32) / 2000`), centred vertically; `fitView({width: 400, height: 100}, {width: 1000, height: 400})` → `scale: 1`; over-wide at min scale → `x === 16` (entry at the left); `zoomAt({x:0,y:0,scale:1}, 2, {x:100,y:50}, {min:.35,max:1.5})` → `{ x: -50, y: -25, scale: 1.5 }`; `followView` centres a box that fits and zooms out for one wider than the stage; DOM (injected size): a drag (pointerdown/move 20px/up) then two SSE snapshots → `#flow-canvas.style.transform` unchanged, `Follow` `aria-pressed="false"`; a 4-step run → zoom controls hidden; reduced motion via `matchMedia` stub → no `animate` call when following.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): the drawer zooms, pans, fits and follows the working step`.

---

### Task 2: Sections, lanes, bands and collapse

**Files:** `server/run-view.ts`, `client/flow-graph.ts`, `client/flow-drawer.ts`, `public/quiet.css`, `test/fixtures/big-flow.json`; tests `test/run-view.test.ts`, `test/flow-graph.test.ts`, `test/flow-drawer.test.ts`, `test/workflows.test.ts`.

**Produces:** `RunView.sections` per Decisions; `layoutRun(steps, edges, entry, sections?)` → `{ placed, bands, width, height }`; `export function collapseSections(steps: GraphStep[], edges: GraphEdge[], sections: RunView['sections'], expanded: ReadonlySet<string>, attempts: RunAttemptView[], now: number): { steps: GraphStep[]; edges: GraphEdge[]; bands: RunView['sections'] }`.

- [ ] **Step 1: Failing tests** — run view: open section → `state: 'open'` with branch `flow-<runId8>-<pathId>`; joined → `'joined'`; conflict → `'conflict'` with the kept branch on the unjoined path; fixture valid; fixture layout: no two cards intersect, no two sibling bands intersect, no band label rect intersects a card, `review`/`split2`/`notify` have `y === plan.y`, `join` is right of `api-tests` and `ui-check`; `collapseSections` on a joined section → one `section:split` step titled `Parallel · Api + Ui`, one edge `split → section:split`, `join`'s out edges start at the box, the inner `ui-split` section and its steps are gone; with `split` expanded the inner joined section collapses inside path 2's band; a section re-entered by `review --fail--> plan` whose fork ran again → `open`, not collapsed; ticker updates `data-step` cards by id after a collapse.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): parallel paths draw as bands and finished sections collapse`.

---

### Task 3: Step to job, Open in Studio, sub-agents

**Files:** `server/jobs.ts`, `server/activity.ts`, `server/index.ts`, `server/run-view.ts`, `client/flow-graph.ts`, `client/flow-drawer.ts`, `client/shell-activity.ts`, `client/shell.ts`, `client/studio.tsx`, `server/views/shell.ts`; tests: the job-manager test file (`grep -ln createJobManager test/`), `test/run-view.test.ts`, `test/flow-drawer.test.ts`, `test/flow-drawer-dom.test.ts`.

- [ ] **Step 1: Failing tests** — a job whose log streams two top-level `Agent` tool_use blocks (different ids), one repeated id, one `Read`, and one `Agent` inside a message with `parent_tool_use_id` set → `subAgents === 2`, persisted on the record, `onJobProgress` called; run view attempt carries `subAgents`; `stepsFor` details `3 sub-agents · <elapsed>`, `1 sub-agent · <elapsed>`, `Try 2 · 3 sub-agents · <elapsed>`; DOM: clicking a card with an attempt dispatches `quiet:agent-open` with its `jobId`, a 20px drag then release dispatches nothing; `#flow-studio` dispatches `quiet:studio-run`; `quiet:agent-open-missing` shows the transient line without touching an approval banner's buttons.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** per Decisions.
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): steps open their job, runs open in Studio, and steps show sub-agents`.

---

### Task 4: Browser check against the big flow

With the fake engine on a throwaway server on port 7795 (probe first; `MC_FAKE_ENGINES=1 MC_FAKE_ENGINE_CMD=scripts/fake-pass-engine.sh MC_FAKE_STEP_SECONDS=3`), in a scratch git repo under the home directory, with roles plan/execute = claude and review = codex: start `test/fixtures/big-flow.json` as a drafted flow in a terminal session via `POST /api/studio/runs` (Bearer token), approve it in the drawer, and check at 1440px and 390px: Fit shows every box at 1440px; at 390px Fit shows the entry and the working steps and panning reaches every box; Follow keeps working steps in view; open paths' bands show their branch; the first section collapses to `Parallel · Api + Ui` once joined and expands on click; clicking a done step opens the Agents panel on that job; `Open in Studio` opens the run in Studio's Runs screen and leaving Studio returns to the terminal. Screenshots under `.playwright-mcp/`. Stop the server by PID, restore the skill link, delete the scratch repo. Fixes found here get their own commits.

Not in this part (add when asked): double-click to zoom, an off-screen indicator for working steps when Follow is off.
