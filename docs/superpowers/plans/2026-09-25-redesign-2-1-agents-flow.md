# Redesign 2.1 — Lane 2: Agents sidebar + Flow graph

Repo: mission-control (Bun + Elysia, vanilla TS client, `bun test`). Base branch: `main`.
Design source: `docs/design/redesign-2-1/DECISION.md` §1 (Agents, Variant E) and §2 (node/edge styling reused for Flow). Mockup to match pixel-for-pixel: `docs/design/redesign-2-1/agents-e.html` + `agents.css` (serve with `npx live-server docs/design/redesign-2-1 --port=51960` if not already up).

## Decisions
- The Agents drawer always follows the open chat: `client/chat.ts` `openChat(id)` and the first successful `startChat` dispatch `quiet:chat-agents` with the chat id; `quiet:new-chat` dispatches `quiet:activity-scope` with `null`. Terminal scope (`quiet:activity-scope` from terminals) keeps working as today.
- Agents list = Variant E exactly: header row (`Agents` 17px/500 · muted `N working · M total` · 32px raised round close button, X color `#b0556a`); per agent an item (row: 24px engine tile, label, elapsed `m:ss`/`Ns`, status pill) + for running agents one grey line with the latest activity that fades on change; needs-you shows its reason line in red (`Failed` job → reason = last error line from the job's `currentActivity`, else `Needs you`); done shows no line. Hover/open block, inset dividers, click-to-open detail (dark log, model + reason, reply box, Stop) — all values in DECISION.md §1.
- Detail log content: `GET /api/jobs/<id>/activity` events, newest last, max 40 lines, rendered as `HH:MM:SS <Tool> <detail>` with the colors in DECISION.md. Refreshes every 3s only while that item is open.
- Status mapping keeps today's `agentState` in `client/shell-activity.ts` (Working / Needs you / Landed→Done pill / In review→Working pill with text `In review` / Done).
- Activity line text uses the same plain-words step mapping as lane 1 (`Reading x`, `Editing x`, `Running x`, `Searching x`), implemented locally in `client/shell-activity.ts` as `plainActivity(text: string): string` that maps a `currentActivity` string starting with `Read `/`Edit `/`Write `/`Bash `/`Grep `/`Glob ` to those words and returns anything else unchanged.
- Flow graph replaces the card columns in `#live-flow-steps` with an SVG graph built from `flowColumns(item)` (`client/awareness.ts`, unchanged): nodes laid out left→right by column, vertically centered within their column, node 168×64, column gap 64px, row gap 14px. Node = flat card (`#f6f7fb`, 1px `--line`, 12px radius): title 13px/500, detail 11px muted, left 3px stripe in the assignee engine color (claude `#d4a091`, glm `#91b0dc`, codex `#bfd38b`, none → `--line`). Edges: every node in column i connects to every node in column i+1, cubic curves, 1.75px `#8a93a8`, 6px arrowhead. States: done node border `#bcd6c4` and its outgoing edges `#6f9c7e`; active node accent border + pulsing ring (`box-shadow 0 0 0 4px #8062bd1f` ↔ `0 0 0 8px #8062bd00`, 1.6s) and its incoming edges carry the flowing accent dash (`stroke-dasharray 6 14`, dashoffset 0→−20, 1.1s linear infinite); failed node border `#e8c4cd`, detail red.
- First paint of a graph draws edges in: `stroke-dashoffset` from path length to 0 over 700ms, staggered 140ms per edge (the pre-2.0 `client/flow.ts` behaviour; see `git show ce5b8e3^:client/flow.ts`, lines around `strokeDashoffset`). Repaints with the same node keys do not replay it. Respect the motion toggle: when `localStorage['mc.motion.paused'] === 'true'` no dash animation and no draw-in.
- Flow for a chat: `quiet:chat-agents` scope also fills the Flow panel. Its items = `awarenessFlows(buildWork(<chat's agent jobs>, states))` where the chat's agent jobs are `GET /api/jobs?chat=<id>` minus `purpose === 'chat'`, and `states` from `GET /api/flow?includeArchived=1` `sessions`. With no agents: status text `No agents in this chat yet.`
- Flow opens reliably: `toggle-flow` always calls `refresh()` after opening, and `refresh()` runs while the Agents drawer is open and also while the Flow panel is open (today's guard stays).

## Preserve
- `setActivityScope` generation guard against stale responses (`client/shell-activity.ts`).
- Stop (`POST /api/jobs/<id>/kill`) and reply (`POST /api/jobs/<id>/reply`) behaviour and their error texts.
- Terminal-scoped agents and flow (`quiet:activity-scope` with a session) — same data as today, new visuals.
- `#live-flow-select` appears only with 2+ flows.
- Mobile (`max-width: 600px`) opens the drawer as a modal (`client/shell.ts` `showAgents`).
- `awareness.ts`, `work.ts`, `plan-view.ts` public functions and their tests are unchanged.

## Tasks (one commit each, in order)

### Task 1 — Agents drawer follows the chat
Files: `client/chat.ts`, `client/shell-activity.ts`, new `test/shell-activity.test.ts` (use the hand-rolled DOM technique already used in `test/shell.test.ts`).
- Dispatch events per Decisions. Test: after `quiet:chat-agents` with `'c1'`, a stubbed `getJson` is called with `/api/jobs?chat=c1` when the drawer is open.
- Commit: `fix(agents): the Agents drawer follows the open chat`

### Task 2 — Variant E list and header
Files: `server/views/shell.ts` (`#agents` dialog header markup only), `client/shell-activity.ts` (`paintChatAgents`, `paintAgents`, new `plainActivity`), `public/quiet.css` (replace the `.agent`, `.agent summary`, `.status`, `.agent-body`, `.agent-actions`, `.live-agent-body`, `.drawer .dialog-heading` rules used by the drawer; copy values from `docs/design/redesign-2-1/agents.css` `.ag-*` rules).
- Tests (in `test/shell-activity.test.ts`): `plainActivity('Read client/chat.ts')` → `'Reading client/chat.ts'`; `plainActivity('Bash bun test')` → `'Running bun test'`; `plainActivity('Thinking')` → `'Thinking'`.
- Commit: `feat(agents): one line per agent with a live activity line`

### Task 3 — click-to-open detail
Files: `client/shell-activity.ts`, `public/quiet.css`.
- Item click toggles `.open`; detail = log (Decisions) + model/reason + reply form (move the existing `#agent-reply` form into the open item) + Stop for running jobs. Clicks inside the detail do not toggle.
- Commit: `feat(agents): open an agent to see its live log, reply or stop it`

### Task 4 — Flow graph
Files: new `client/flow-graph.ts` exporting `renderFlowGraph(host: HTMLElement, columns: FlowStep[][], options: { animate: boolean }): void` and `graphLayout(columns: { key?: string; title: string }[][]): { nodes: { key: string; x: number; y: number }[]; edges: { from: string; to: string }[]; width: number; height: number }`; `client/awareness.ts` exports its `FlowStep` type; `client/shell-activity.ts` `paintFlow` calls `renderFlowGraph`; `public/quiet.css` replaces `.live-flow-steps/.live-flow-column/.live-flow-node` rules with `.flow-graph` rules.
- Tests (`test/flow-graph.test.ts`): `graphLayout([[{title:'Direction'}],[{title:'a'},{title:'b'}],[{title:'Your review'}]])` → 4 nodes, 4 edges, node `Direction` at x 0, nodes `a`/`b` at x 232, `Your review` at x 464; `a.y < b.y`; width 632; a single column → 0 edges.
- Commit: `feat(flow): the session flow is a node graph with animated lines again`

### Task 5 — Flow for chats
Files: `client/shell-activity.ts`.
- Chat scope loads flows per Decisions; `#live-flow` is shown for chat scope too.
- Commit: `feat(flow): chats show their agents' flow`

## Tests to run while iterating
`bun test test/shell.test.ts test/awareness.test.ts test/flow-graph.test.ts test/shell-typecheck.test.ts` plus any test file you create.

## Visual check (required before reporting done)
Run a throwaway server: `MISSION_CONTROL_CONFIG_DIR=$(mktemp -d) MISSION_CONTROL_PORT=7792 MC_FAKE_ENGINES=1 bun server/index.ts` (never touch port 7777; stop it by its PID when done), open a chat, dispatch fake agents, screenshot the drawer and the Flow panel, and compare with `docs/design/redesign-2-1/agents-e.html`. Report the screenshot paths.

## Constraints
- Do not push. Do not restart or kill the running Mission Control on port 7777.
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- While iterating run only the tests for files you touch; run the full suite ONCE at the end.
- Only edit `public/quiet.css` rules named in your task or add new ones; `server/views/shell.ts` only inside the `#agents` dialog and `#flow` section. Other lanes edit these files in parallel.
