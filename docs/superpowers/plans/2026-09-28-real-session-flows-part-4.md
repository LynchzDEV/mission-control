# Real Session Flows — Part 4 Implementation Plan (drawer for big graphs)

> **For agentic workers:** execute one task at a time, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The drawer stays readable for a 20+ step flow with parallel paths and loops: it zooms, pans and fits; follows the running step; draws each path as a labelled band; collapses a finished fork-join section to one box; opens a step's job detail on click; opens the run in Studio; shows sub-agent counts.

**Architecture:** Pure layout/transform functions in `client/flow-graph.ts` and a new `client/flow-viewport.ts`, tested without a browser. The run view gains `sections` (every fork-join section with its paths, branch and state) and per-attempt `subAgents`. The drawer composes: sections → collapse → layout with lanes → bands → viewport transform.

**Spec:** `docs/superpowers/specs/2026-09-28-real-session-flows-design.md` ("Drawer for big graphs (part 4)", "Drawer (variant D)" deferred items). Look: `docs/design/flow-drawer/DECISION.md` and `docs/design/flow-drawer/d-terminal.html` (bands, labels).

## Global Constraints

- Part 1–3 Global Constraints apply (comment rule, no emoji — SVG icons only, flat inputs, `bun test`, both typechecks, one commit per task, no `Co-Authored-By`, never push or merge, restore the skill link after the last test run: `ln -sfn /Users/lynchz/Desktop/kingpinggroup/mission-control/skills/mc-dispatch ~/.claude/skills/mc-dispatch`).
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- Motion respects `motionAllowed()` (already in `client/flow-drawer.ts`): no animated pans when reduced motion is on.
- Tokens from DECISION.md: band fill `#e2e6f080`, radius `var(--r-lg)`; band label 11px muted, branch in mono accent.

## Decisions

- **Viewport:** CSS `transform: translate(x, y) scale(s)` on `.flow-run` inside `#flow-stage` (`overflow: hidden`, height `min(46vh, 420px)`). Scale range 0.35–1.5. Controls in the stage's bottom-right: `−`, `+`, `Fit`, `Follow` (pressed state via `aria-pressed`). Ctrl/Cmd + wheel zooms around the pointer; plain wheel and drag pan; keyboard `+`/`-`/`0` (fit) when the stage has focus (`tabindex="0"`).
- **Fit** on the first render of a run and whenever the step set changes while the user has not panned or zoomed since the last fit. **Follow** (default on): when the set of `active` steps changes, pan so their bounding box is centred, keeping the scale. Any manual pan/zoom turns Follow off; pressing Follow or Fit turns it on again. The viewport state is per run id, kept in memory only.
- **Sections in the run view:** `sections: { fork: string; join: string; state: 'waiting' | 'open' | 'joined'; paths: { nodes: string[]; title: string; branch: string | null }[] }[]` from `forkSections(run.workflow)`; `open` when the run has an open section for that fork (branch from it), `joined` when the join has a settled `pass` attempt and the section is not open, else `waiting`. Path `title` = first step title.
- **Lanes:** `layoutRun(steps, edges, entry, lanes?)` — when `lanes` gives a node a lane, its row is at least that lane's first row. `pathLanes(sections)` gives path i of an outer section the next free lane block; a path's block is `1 + (number of fail-only steps in the path > 0 ? 1 : 0)` rows tall, nested sections inside a path take as many rows as they need. Steps outside every section keep today's placement.
- **Bands:** one rect per path, the bounding box of its placed steps padded 8px, drawn behind the edges; label at the band's top-left: `<title> path` plus, for `open` sections, ` · ` and the branch in `<code>`.
- **Collapse:** a `joined` section collapses by default into one step `{ id: 'section:<fork>', title: 'Parallel · <path titles joined by " + ">', detail: 'Done · <duration from first path attempt start to join end>', state: 'done', kind: 'join', engine: '' }`, replacing every path node and the join; edges into the join and edges inside the section vanish; edges out of the join start at the box. Clicking the box expands it (expanded set per run id, in memory); an expanded joined section shows a small `Collapse` label button on its band.
- **Step click:** a step with an attempt opens its latest job: `dispatchEvent(new CustomEvent('quiet:agent-open', { detail: { jobId } }))`. `client/shell-activity.ts` listens: opens `#agents` (`showModal` if not open) and opens the row whose `jobId` matches, using the existing `openDetail`. A job with no row (not in the current scope) opens nothing and the drawer banner shows `That step's job is no longer in this session's list.` for 4 s.
- **Open in Studio:** header pill `#flow-studio` (`Open in Studio`; drafted runs: `Edit in Studio`) → `dispatchEvent(new CustomEvent('quiet:studio-run', { detail: { runId } }))`. `client/shell.ts` shows the Studio screen; `client/studio.tsx` listens, switches to the Runs screen and opens that run exactly as clicking it in the runs list does.
- **Sub-agents:** `JobManager` counts, per job, stream lines that are Claude `tool_use` blocks named `Agent` or `Task` (count each `tool_use` id once) and exposes `subAgents(id): number`. `RunAttemptView.subAgents: number`. Detail line of an active step with `subAgents > 0`: `<n> sub-agents · <elapsed>` (`1 sub-agent` singular); settled steps keep today's detail.

## Preserve

- Every Part 1–3 drawer behaviour and test: banner states, approval buttons, run menu, quick-work list, proposed ghosts, parallel step states.
- A flow of up to 6 steps with no fork renders at scale 1 with no controls needed: Fit never scales above 1.
- The `renderRunGraph` paint signature short-circuit (`host.dataset.sig`) keeps repaint cost low; the viewport transform is applied without repainting.

## Review Focus

1. The live SSE snapshot repaints the graph every second while the user drags: panning must not jump back. Test in Task 1 (transform survives a repaint).
2. A section that is `joined` and then re-entered by a loop around the whole section (fail edge from after the join back before the fork) must expand again automatically while it has live tokens. Test in Task 2.
3. A step whose job belongs to another scope: click shows the banner text, not a silent no-op. Test in Task 3.
4. Reduced motion: Follow jumps without animation. Test in Task 1 (`motionAllowed` false → no `animate` call).
5. A 20+ step flow with two forks and loops fits inside the stage at scale ≥ 0.35 without overlapping boxes. Test in Task 2 (layout of the Task 4 fixture has no two boxes intersecting).

---

### Task 1: Zoom, pan, fit and follow

**Files:** Create `client/flow-viewport.ts`; modify `client/flow-graph.ts`, `client/flow-drawer.ts`, `server/views/shell.ts` (stage controls markup), `public/quiet.css`; tests `test/flow-viewport.test.ts`, `test/flow-drawer-dom.test.ts`.

**Produces:**

```ts
export type View = { x: number; y: number; scale: number }
export const MIN_SCALE = 0.35, MAX_SCALE = 1.5
export function fitView(content: { width: number; height: number }, stage: { width: number; height: number }, padding = 16): View  // scale = min(1, fits); centred
export function zoomAt(view: View, factor: number, point: { x: number; y: number }): View  // clamps scale; keeps `point` (stage coords) fixed
export function followView(view: View, box: { x: number; y: number; width: number; height: number }, stage: { width: number; height: number }): View  // same scale, box centred
export function mountViewport(stage: HTMLElement, content: () => HTMLElement | null, options: { animate: () => boolean }): { refit(): void; follow(box: { x: number; y: number; width: number; height: number }): void; forget(): void }
```

- [ ] **Step 1: Failing tests** — `fitView({width: 2000, height: 300}, {width: 1000, height: 400})` → `{ scale: 0.484, … }` (compute from padding 16: `(1000 - 32) / 2000 = 0.484`), centred vertically; `fitView({width: 400, height: 100}, {width: 1000, height: 400})` → `scale: 1`; `zoomAt({x:0,y:0,scale:1}, 2, {x:100,y:50})` → `{ x: -50, y: -25, scale: 1.5 }` (scale clamps to 1.5; the point stays fixed: x = 100 - 100 × 1.5); `followView` centres the box; DOM test: after a manual drag (pointerdown/move/up on the stage) a new SSE snapshot keeps the same `transform` on `.flow-run`, and the `Follow` button reads `aria-pressed="false"`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** `renderRunGraph` returns the layout size and the active steps' bounding box; `flow-drawer.ts` calls `refit`/`follow` per Decisions.
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): the drawer zooms, pans, fits and follows the running step`.

---

### Task 2: Path bands, lanes and collapsed sections

**Files:** `server/run-view.ts`, `client/flow-graph.ts`, `client/flow-drawer.ts`, `public/quiet.css`; tests `test/run-view.test.ts`, `test/flow-graph.test.ts`, `test/flow-drawer.test.ts`.

**Produces:** `RunView.sections` per Decisions; `export function pathLanes(sections: RunView['sections']): Map<string, number>`; `layoutRun(steps, edges, entry, lanes?)`; `export function collapseSections(steps: GraphStep[], edges: GraphEdge[], sections: RunView['sections'], expanded: ReadonlySet<string>, now: number, attempts: RunAttemptView[]): { steps: GraphStep[]; edges: GraphEdge[] }`; `renderRunGraph(host, steps, edges, entry, { animate, bands })` where `bands: { nodes: string[]; label: string; branch: string | null }[]`.

- [ ] **Step 1: Failing tests** — run view of a run with one open section gives `state: 'open'` and the branch; after the join passed, `state: 'joined'`, `branch: null`; `pathLanes` for two paths gives path 2's nodes a lane ≥ 1 and path 1's nodes lane 0; `collapseSections` on a joined section yields one `section:<fork>` step with the literal title `Parallel · A + B` and removes the path and join steps; with the fork id in `expanded` it returns the input unchanged; a joined section that has a live token again is not collapsed; `renderRunGraph` with bands renders one `.flow-band` per path whose label text is `A path · flow-…-p1` for an open section; the 22-step fixture `test/fixtures/big-flow.json`, created in this task with the shape described in Task 4 and asserted valid by one `test/workflows.test.ts` test laid out with lanes has no two intersecting step boxes.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Band CSS: `.flow-band { position: absolute; background: #e2e6f080; border-radius: var(--r-lg) }`, `.flow-band-label { font-size: 11px; color: var(--muted) } .flow-band-label code { color: var(--accent); font-family: var(--mono) }` (use the token names that exist in `public/quiet.css`; check with grep).
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): parallel paths draw as bands and finished sections collapse`.

---

### Task 3: Step to job detail, Open in Studio, sub-agent count

**Files:** `server/jobs.ts`, `server/run-view.ts`, `client/flow-graph.ts`, `client/flow-drawer.ts`, `client/shell-activity.ts`, `client/shell.ts`, `client/studio.tsx`, `server/views/shell.ts`; tests `test/jobs.test.ts` (or the existing job-manager test file — find it with `grep -ln createJobManager test/`), `test/run-view.test.ts`, `test/flow-drawer.test.ts`, `test/flow-drawer-dom.test.ts`.

- [ ] **Step 1: Failing tests** — a job whose log streams two `tool_use` blocks named `Agent` (different ids) and one `Read` → `subAgents(id) === 2`; the same id streamed twice counts once; run view attempt carries `subAgents`; `stepsFor` detail for an active step with 3 → `3 sub-agents · <elapsed>`, with 1 → `1 sub-agent · <elapsed>`; DOM: clicking a step card with an attempt dispatches `quiet:agent-open` with its `jobId`; clicking `#flow-studio` dispatches `quiet:studio-run` with the run id; a `quiet:agent-open` for an unknown job shows the banner text from Decisions.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** per Decisions. Step cards with an attempt get `tabindex="0"`, `role="button"`, and open on Enter/Space too.
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): steps open their job, runs open in Studio, and steps show sub-agents`.

---

### Task 4: Browser check against a big flow

Uses `test/fixtures/big-flow.json` from Task 2: 22 steps — plan, verify, split into 2 paths (path 1: implement → test with a fail edge to a fix step that passes back to test; path 2: implement → nested split of 2 short task paths → nested join → check), outer join with a fail edge to a fix step, review, then a second split of 2 review-ish task paths and a final join and finish.

With the fake engine on a throwaway server on port 7795 (probe first; `MC_FAKE_ENGINES=1 MC_FAKE_ENGINE_CMD=scripts/fake-pass-engine.sh MC_FAKE_STEP_SECONDS=3`) in a scratch git repo: start the fixture as a drafted flow via `POST /api/studio/runs` (Bearer token), approve it in the drawer, and check at desktop width and at 390px: Fit shows every box with no overlap; Follow keeps the working steps in view as the run moves; both paths' bands carry their branch while open; the first section collapses to `Parallel · …` once joined and expands on click; clicking a done step opens the Agents dialog on that job; `Open in Studio` opens the run in Studio. Save screenshots under `.playwright-mcp/`. Stop the server by PID, restore the skill link, delete the scratch repo. Nothing to commit unless the check found a bug; fixes get their own commit.
