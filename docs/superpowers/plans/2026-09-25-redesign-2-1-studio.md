# Redesign 2.1 — Lane 4: Studio canvas + Manage AIs

Repo: mission-control (Bun + Elysia, React island `client/studio.tsx` with `@xyflow/react`, `bun test`). Base branch: `main`.
Design source: `docs/design/redesign-2-1/DECISION.md` §2 (canvas A + C run states) and §2b (Manage AIs A). Mockups to match: `studio-canvas-a.html`, `studio-canvas-c.html` (run states only), `manage-ais-a.html`, with `studio-mock.css` / `manage-mock.css` (serve with `npx live-server docs/design/redesign-2-1 --port=51960` if not up).

## Decisions
- No neumorphism anywhere in the Studio editor canvas, its toolbar, zoom controls or step nodes: flat, bordered surfaces only (values in DECISION.md §2). Studio's home, templates, runs and rules screens are out of scope — leave them as they are.
- Node (`TaskCard` in `client/studio.tsx`) becomes 180×150: step-kind icon (18px accent) · title 14px/500 · 2-line description 12px muted (the node's `instructions` first sentence, clipped with `-webkit-line-clamp: 2`) · footer divider · AI tag `<Role> AI · <agentLabel>` with the engine logo on its tint (claude `#d4a091`, glm `#91b0dc`, codex `#bfd38b`; no engine → `auto-icon` on `--line` tint). Role word: `plan` → `Plan`, `execute` → `Execute`, `review` → `Review`.
- Kind → icon: `plan` → document icon, `verify-plan` → check-circle, `implement` → code `</>`, `review` → eye, `task` → spark. Add the four missing SVG symbols (`plan-icon`, `check-circle-icon`, `code-icon`, `eye-icon`) to the symbol sheet in `server/views/shell.ts` using the exact paths in `docs/design/redesign-2-1/gen_studio.py` `ICONS`.
- Handles: 9px circles, `#f6f7fb` fill, 1.5px ring `#8a93a8`; fail handle ring `#b0556a`, blocked ring `#d4a091`; vertically centered for pass/target.
- Edges: path 1.75px `#8a93a8`; arrow marker via `markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#8a93a8' }`; every pass edge also animates a flowing accent dash overlay. Implement with a custom edge type `flow` (`client/studio.tsx`) that renders `BaseEdge` twice: the solid path and an overlay path with class `edge-flow` (`stroke: var(--accent); stroke-width: 2; stroke-dasharray: 6 14; animation: st-flow 1.1s linear infinite`). Fail/blocked edges: dashed `6 5` in their color, label chip with red/orange 1px border. Motion toggle: when `localStorage['mc.motion.paused'] === 'true'` or `prefers-reduced-motion`, `.edge-flow` is `display: none`.
- Canvas container (`.flow-host`): 1px `--line` border, 16px radius, `color-mix(in srgb, #fff 25%, var(--paper))` background, React Flow `<Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cfd5e3" />`. `Add step` / `Ask AI` buttons and the zoom controls: flat, 1px `--line`, 10px radius, no box-shadow.
- Editor heading shows the full workflow name — remove whatever truncates it today (the user saw "Plan, verify, execute, revi").
- Run states on the canvas: while the editor is open, poll `GET /api/studio/runs` every 3s; take the newest run whose `revision` equals the open graph's `revision` and `status === 'running'`; fetch `GET /api/studio/runs/<id>` for `attempts`. Per node: latest settled attempt with `result.outcome === 'pass'` → `passed`; with `fail` or `blocked` → `failed`; the run's `currentNodeId` → `running` (overrides); other nodes → `waiting`. No running run → no state classes. Styling from DECISION.md §2: passed border `#bcd6c4` + outgoing pass edge `#6f9c7e`; running accent border + `0 0 0 4px #8062bd1f` + `Running · m:ss` label with pulse dot; failed border `#e8c4cd` + red label `Needs attention`; waiting label `Waiting` muted.
- Manage AIs (`client/studio-settings.tsx` `Connections`): layout exactly `manage-ais-a.html`. Left list: `AIs` + muted `N connected`, each row logo tile (28px) + name + connection line + green 7px dot. Detail card: header (40px logo, name 20px/500, line, `Ready` pill), description, two columns Usage (bars from `GET /api/quota` the same way `client/provider-usage.ts` reads them) and Used for (role pill(s) from `GET /api/roles` for every role whose engine is this AI; none → muted `Not assigned`), Models chips from `GET /api/models[<id>]`, settings section (GLM form / connection form), footer `Check connection` + muted `Checked when a job starts`. Built-in AIs have no `Check connection` probe today — for them the footer shows only the muted text. Replace the broken `<span class="status">Built in</span> Checked when a job starts.` line.
- Inputs in Manage AIs: flat `#e2e6f0`, 10px radius, no inset shadow. Primary Save button: accent background, white text, 10px radius.

## Preserve
- Workflow save/draft/history/run/rules dialogs, node drag, connect-to-set-order, unsaved guard, keyboard `Enter` opens the step editor (`client/studio.tsx`).
- `graphEdges` edge ids and `sourceHandle` values (`${source}-${outcome}`); saved workflow JSON shape unchanged.
- `agentLabel` in `client/studio-graph.ts` and its tests.
- GLM secrets form behaviour and messages; connection save / probe / remove flows and the remove confirm dialog (`client/studio-settings.tsx`).
- Studio home, templates, runs and rules screens' markup.

## Tasks (one commit each, in order)

### Task 1 — flat canvas, node anatomy, icons
Files: `client/studio.tsx` (`TaskCard`), `server/views/shell.ts` (symbol sheet only: add 4 symbols), `public/quiet.css` (`.flow-host*`, `.workflow-node*` rules), `test/studio-graph.test.ts` (or new `test/studio-node.test.ts`).
- Export from `client/studio-graph.ts`: `kindIcon(kind: WorkflowNode['kind']): string` and `roleWord(role: 'plan' | 'execute' | 'review'): string`.
- Tests: `kindIcon('plan')` → `'plan-icon'`; `kindIcon('verify-plan')` → `'check-circle-icon'`; `kindIcon('implement')` → `'code-icon'`; `kindIcon('review')` → `'eye-icon'`; `kindIcon('task')` → `'spark-icon'`; `roleWord('execute')` → `'Execute'`.
- Commit: `feat(studio): flat step nodes with icon, description and AI tag`

### Task 2 — visible, animated edges
Files: `client/studio.tsx` (custom `flow` edge type, `graphEdges` sets `type: 'flow'`), `public/quiet.css`.
- Commit: `feat(studio): workflow lines are visible, with arrows and a flowing dash`

### Task 3 — run states on the canvas
Files: `client/studio-graph.ts` (export `nodeRunStates(run: { status: string; currentNodeId: string; attempts: { nodeId: string; status: string; result: { outcome: string } | null; startedAt: number }[] } | null): Record<string, 'passed' | 'running' | 'failed' | 'waiting'>`), `client/studio.tsx` (poll + classes), `public/quiet.css`, `test/studio-graph.test.ts`.
- Tests: `nodeRunStates(null)` → `{}`; a running run with attempts plan=pass(settled), verify=pass(settled), currentNodeId `execute`, nodes known only through attempts and currentNodeId → `{ plan: 'passed', 'verify-plan': 'passed', execute: 'running' }`; a settled `fail` attempt on `review` → `review: 'failed'`; two attempts on one node, older `fail` then newer `pass` → `'passed'`.
- Nodes absent from the result render as `waiting` only while a running run exists.
- Commit: `feat(studio): a running workflow shows each step's state on the canvas`

### Task 4 — Manage AIs list + detail
Files: `client/studio-settings.tsx`, `public/quiet.css` (`.connection-*` rules), `test/studio-routes.test.ts` only if an API shape changes (it should not).
- Commit: `feat(studio): Manage AIs shows each AI with usage, role, models and settings`

## Tests to run while iterating
`bun test test/studio-graph.test.ts test/studio-routes.test.ts test/workflows.test.ts test/shell-typecheck.test.ts test/views.test.ts`

## Visual check (required before reporting done)
Run a throwaway server: `MISSION_CONTROL_CONFIG_DIR=$(mktemp -d) MISSION_CONTROL_PORT=7794 MC_FAKE_ENGINES=1 bun server/index.ts` (never touch port 7777; stop it by its PID when done). Screenshot the default workflow editor, a node selected, Manage AIs with GLM selected and with Claude selected; compare with `studio-canvas-a.html` and `manage-ais-a.html`; report the paths.

## Constraints
- Do not push. Do not restart or kill the running Mission Control on port 7777.
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- While iterating run only the tests for files you touch; run the full suite ONCE at the end.
- In `server/views/shell.ts` only add the four symbols; in `public/quiet.css` only edit Studio rules named here or add new ones. Other lanes edit these files in parallel.
