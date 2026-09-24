# Left to port: current app → new quiet design

Updated 2026-09-24 after the system-chat grilling (`docs/decisions/system-chat.md`). Section 1 (Terminals page) is the current task.

## 1. Terminals page — DESIGNED
- (1) DONE: several terminals + switching = **C · session rail**: a column of session cards left of the terminal (AI logo, name, AI · model · state, status dot green working / amber waiting / grey idle, latest line), + for the launcher; active card inset.
- (2) DONE: split = **A · drag a rail card onto the terminal**: right half opens it beside, bottom opens it below; each pane has a small header (logo, name, model, × to close); focused pane gets a faint lavender ring. Implement with **dockview-core** (MIT, zero deps, vanilla TS, v8.3.1): `api.onUnhandledDragOver(e => e.accept())` for rail-card drags, drop handler → `api.addPanel({ position: { referencePanel, direction } })`; it also gives resizable dividers, edge drop overlays, close, and layout save/restore. Replaces hand-written `client/resize.ts` + `client/resize-layout.ts`. Rejected: golden-layout (older, heavier), flexlayout-react / react-mosaic (React only), Split.js / allotment (resize only, no docking).
- (3) DONE: rename = **A · double-click the name on the rail card** → flat text field in place (`#e2e6f0`, 1px `#c9c0e3` border, no shadow); Enter saves, Esc cancels, empty keeps the old name, max 60 chars (matches `client/terminal.ts:245,318-334` and `PATCH /api/terminals/:id`).
- (4) DONE: end a session = **A with modal**: hovering a rail card shows a small ×; clicking it opens the confirm dialog "End <name>? This stops its running process. Its history stays in History." with Cancel / End session (danger `#b0556a`), then `DELETE /api/terminals/:id` as today (`client/terminal.ts:586-596`). The split-pane × only hides a pane.
- (5) DONE: drop files = **A · full overlay**: while files hover, the terminal dims behind a dashed lavender frame: "Drop to add N files", file-name chips, "Their paths are typed at the prompt · up to 100 MB each". On drop the quoted paths are typed at the prompt and an "Added N files" notice shows (behaviour as today, `client/terminal.ts:838-910`, `server/drops.ts:15`). File drags never show the split zones; only rail-card drags do (check the drag type before dockview `accept()`).
- (6) DONE: find = **B · in the terminal heading**. Closed: a small raised "Find ⌘F" button beside "Connected". ⌘F (or the button) swaps it for a flat field + "2 of 3" + previous / next / close; Enter next, Shift+Enter previous, Esc closes (as today, `client/terminal.ts:363-397,921`); count from xterm search add-on `onDidChangeResults`. Links: lavender, underline + "Open in a new tab" on hover, click opens (xterm web-links add-on, `client/terminal.ts:550`).
- (7) DONE: background = **A · dotted glow** (idea from Aceternity Dotted Glow Background, re-built in our own canvas JS; their licence forbids redistributing their source). Near-white dots on a 22px grid, drawn at 60% alpha, slow twinkle toward lavender. Mouse lens: 150px reach, follows at 12%/frame, dots fade at 8%/frame, brighten toward lavender, grow, ease up to 4px away. Click on empty background: ripple ring at ~450px/s, 36px band, fades over 1.1s, tints/grows/pushes dots; clicks on buttons, cards, terminal, headings, toolbar do nothing. Pause motion button bottom-left; starts paused under Reduce Motion. Replaces the ASCII horizon. Source: `visualizer/quiet-chat/terminals-7-background.html`.

All 7 Terminals items decided. Screens: `visualizer/quiet-chat/terminals-1-switching.html` … `terminals-7-background.html`.
- Decided elsewhere: resume Claude history and outside sessions live in History; chat-style transcript is replaced by the system chat; launcher is the flat one.

## 2. Agents and job conversations
| Current feature | New design | Status after system chat |
|---|---|---|
| Full agent conversation (`/api/jobs/:id/thread`, `/stream`, `/log`) | Only a one-line summary | Decided: team card row → Agents drawer shows the full thread. Not built. |
| Reply to an agent (`POST /api/jobs/:id/reply`) | Fake reply box | Decided: reply in the chat (relayed) or in the Agents drawer. Not built. |
| Kill a job (`/kill`) | Missing | Decided: the chat can stop its own agents, and a Stop button sits in the Agents drawer header of the open agent, shown only while it runs. Not built. |

The dev proxy only allows reads; every write above gets 405 until the design is wired to the real API.

## 3. Main page (work list) — REMOVED
Rule (user): "never use every feature under main page, get rid of everything that doesn't affect other pages' features".
Removed: work list, filters, search, detail panel, "Archived plans" filter, Land / Mark reviewed buttons, Usage page.
Kept (no UI): `/land`, `/reviewed`, plan `/run`, `/run/stop`, `/archive` endpoints — mc-dispatch uses them (`skills/mc-dispatch/SKILL.md:256,360,432`); quota data for the usage card.
Its APIs stay (mc-dispatch still posts plans and starts runs via `/api/flow/:label/plan` and `/run`, `skills/mc-dispatch/SKILL.md:301,331`); only the page goes.
- Plan Run / Stop: never had UI buttons; API-only, driven by mc-dispatch. Nothing to port.
- Archive: only surfaced as the Main page's "Archived plans" filter; goes with the page.
- Land / Mark reviewed: dropped, never used.
- Usage: keep, as the usage card at the top right of the new design (see 6).

## 4. New job (Dispatch) — REMOVED
Decided: the manual New job form is dropped; the system chat and mc-dispatch start jobs. `POST /api/jobs` stays (both use it).

## 5. Review — REMOVED
Decided: the Review page and its header count are dropped; "needs you" in History and on the Agents button replace them. `/reviewed` stays for mc-dispatch.
- Decided: no manual review/land step. The chat (like mc-dispatch) lands automatically once the cross-family review passes; team cards show "Landed", History dots and the Agents count flag "needs you" and "landed".

## 6. Header
- Decided: bring back the usage card (Claude, GLM, Codex, 5-hour and weekly) at the top right of the new design. The chat also reads this usage to route work.
- New job and Review links: gone with their pages. New chat is a split button (chat / Terminal).
- Settings: already in the new design as Studio → Manage AIs, plus the Access dialog. No new UI.
- Rule: every AI picker (composer AI chip, terminal launcher engine, Studio step engine, …) lists every connected provider, custom ones included, from one shared list. Adding a provider anywhere makes it appear in all pickers.
- Usage card: DONE in `visualizer/quiet-chat` (usage-card.js). 3 providers visible; more than 3 auto-scrolls left to right at 14 px/s, 5 s pause, back, 5 s pause, loop; pauses on hover/focus, still under reduced motion. Bars use each provider's logo colour (Claude #d97757, GLM #3485ff, Codex #7a9dff, Qwen #6f69f7).

## 7. Settings
- Work defaults (Plan / Execute / Review roles, Automatic review switch): REMOVED. The chat's AI chip picks the chat's AI and the chat picks every agent's AI; a new chat and the terminal launcher start with what you used last. Cross-family review is always on. The planned **Chat** role is dropped too.
- Connections section (Claude status, Codex sign-in, GLM base URL/token): REMOVED. Provider setup lives in Studio → Manage AIs (+ Add a connection); no separate providers view.
- Password system: REMOVED entirely (login page, setup, `/api/login`, `/api/setup`, session cookies). Mission Control is locked to this machine: always listens on `127.0.0.1`, bind address setting removed, server keeps the local-access guards (peer, Host, Origin, Fetch Metadata) against other sites, embedded pages and DNS rebinding. API token stays (mc-dispatch uses it); copy / rotate still to be wired.
- Decided: add **Chat home** (default = deepest folder shared by known projects, never `~`).

## 8. Studio — port every feature (user: "studio is good in feature now")
Source: `client/studio.tsx`, `client/studio-settings.tsx`. New design: `visualizer/quiet-chat/index.html` Studio sections. ✓ = in the new design, ✗ = missing.

**Home**
- ✓ Describe → Build workflow · ✗ Stop drafting · ✗ "drafting…" status
- ✗ "Try an example" chips (Plan, implement, review · Research and verify)
- ✓ Use default / Browse templates / Start from scratch · ✗ compact template shortcuts
- ✗ "Continue editing <name> · Unsaved changes" · ✗ "Your workflows" saved list

**Editor**
- ✓ Name, status · ✗ step count
- ✓ Save · ✗ Run workflow dialog (run title, project folder, what to accomplish, Start run)
- ✗ Real canvas: drag steps, connect steps, branches (when it succeeds / if it fails / if it needs help), zoom controls, empty-canvas state
- ✗ Add step picker: search, step presets, Custom task (new design just appends a step)
- ✓ Ask AI panel · ✗ draft summary, "Before running" setup notes, suggested edits, "AI draft" notice
- ✗ Core rules dialog (only a note on the canvas)
- History: ✓ versions (sample) · ✗ Open version, ✗ Use as default workflow, ✗ Make a copy

**Step editor**
- ✓ Step name, instructions, who does it (built-ins only), remove step
- ✗ Tools, skills & checks (MCP tools, skill files, acceptance checks)
- ✗ Task purpose · ✗ branch wiring per outcome · ✗ model · ✗ maximum attempts · ✗ model family
- ✗ Preview full instructions · ✗ Add next step / Done · ✗ "+ Connect another AI"

**Runs**
- ✓ Recent runs list (sample) · ✗ Refresh
- ✗ Run detail: status, Stop run, Retry current step, request, folder, error, each attempt (AI + model, summary, evidence, check output, job log link, instructions used), versions used

**Rules**
- ✓ Core rules, core prompt editor · ✗ start from an earlier version · ✗ Save prompt · ✗ placeholder hint ({{core_rules}}, {{workflow}}, {{assignment}})

**Manage AIs**
- ✓ AI list, + Add a connection, Check connection (disabled)
- ✗ Presets (Grok Build, Qwen Code, OpenCode, custom ACP agent, custom headless CLI)
- ✗ Fields: connection ID, name, adapter, command, arguments, environment variables/references, models, model family, output format, auto-approve, base URL, API key variable, provider ID, terminal arguments · ✗ Save / Remove connection
- Work defaults: REMOVE (decided in 7)

**Everywhere**
- ✗ Error banner · ✗ toast notices · ✗ unsaved-changes guard on leaving

**Decided:** a step's "Who should do it?" default is **Chat decides** (replaces "Use default", since roles are gone). Unpinned steps start from the AI + model picked in the chat's AI chip; the chat may switch per task by strengths and usage. Pinning a specific AI + model per step stays.
