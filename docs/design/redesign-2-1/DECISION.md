# Decisions: Redesign 2.1

## 1. Agents sidebar
**Chosen:** Variant E — one row per agent plus one grey live-activity line; click a row to open C's detail in place. Mockup: `agents-e.html`.
**Why:** The user wants to see every agent working without clicking (C needed a click), but D's per-agent dark logs were too much. One fading grey line keeps it calm.
**Real files to touch:** `client/shell-activity.ts` (`paintChatAgents`, `setActivityScope`), `server/views/shell.ts` (`#agents` dialog header), `public/quiet.css` (`.agent`, `.status`, `.drawer .dialog-heading`), activity text from `server/activity.ts` events via `currentActivity`.
**Implementation notes:**
- Header is one row: `Agents` (17px/500) + grey count `N working · M total` (12px) + a 32px raised neumorphic close button with a red X (`#b0556a`, the existing `.danger` red), `box-shadow: var(--raised)`, inset on press.
- Row: 24px engine tile (engine color at 22% on white, logo 14px) · label · elapsed time (11px, muted) · status pill. Pills: Working `#6b4fb0` on `#e6def7` with a pulsing dot; Needs you `#a13f58` on `#f5dde3`; Done `#3f7352` on `#dcece1`.
- Working agents: one grey 12px line under the row, indented 44px, showing the latest step in plain words ("Installing marked"). On change it fades out (opacity 0, 300ms), swaps text, fades in. Needs-you shows its reason in red, static. Done shows no line.
- Hover and open state cover the whole item (row + line) as one block: `color-mix(#fff 45%, paper)` background, 12px radius; open adds an inset 1px `--line` ring. Cursor pointer.
- Dividers: 1px `--line` hairline between items, inset 10px from each side; hidden next to a hovered or open item.
- Click toggles detail under the item: dark log (`#2b2f3a`, Menlo 11.5px, timestamps `#8c93a6`, tool names `#b9a3ec`, diff `#9cc9a7`), model + reason line, "Message this agent…" reply box, Stop (red) right-aligned. Clicks inside the detail don't collapse it.
- No neumorphism on the list itself — flat items only. The only raised element is the close button.
- Bug to fix alongside: opening a chat must set the Agents scope to that chat (today only the team card's "Open in Agents" does, so the toolbar button shows "No agents yet").
**Rejected:** A — card per agent, too heavy; B — grouped by state, still cards; C — needs a click to see work; D — every agent's dark log at once, too much.

## 2. Studio canvas
**Chosen:** Variant A — the pre-2.0 node anatomy in the light theme, flat, with visible arrows and a flowing dash; plus C's run-state styling during a run. Mockups: `studio-canvas-a.html` (layout), `studio-canvas-c.html` (run states only).
**Why:** User liked C's live states, but role rows force the layout (a linear workflow zig-zags, free drag is lost). A restores the "node + line animation" look lost in 2.0.
**Real files to touch:** `client/studio.tsx` (React Flow node renderer and edge props), studio stylesheet served at `/js/studio.css` (`.react-flow__edge-path`, node classes), `client/studio-graph.ts` (step presets → icon), `server/workflow-runner.ts` (per-node run state feed).
**Implementation notes:**
- No neumorphism on the canvas: canvas = 1px `--line` border, 16px radius, `color-mix(#fff 25%, paper)` background with a 20px `#cfd5e3` dot grid. Toolbar buttons (Add step, Ask AI), zoom stack are flat bordered, 10px radius.
- Node 180×150, `#f6f7fb`, 1px `--line`, 12px radius, shadow `0 1px 2px #b4c1d633`; hover border `#c9bfe6`. Contents: 18px accent icon per kind (plan/check/code/review/spark), title 14px/500, 2-line description 12px muted, footer divider + AI tag `<Role> AI · <engine>` with the engine logo on its tint.
- Handles: 9px circles, `#f6f7fb` fill, 1.5px `#8a93a8` ring, vertically centered.
- Edges: 1.75px `#8a93a8`, arrowhead marker 6px; overlay a 2px accent dash (`6 14`) animating `stroke-dashoffset` 0 → −20 over 1.1s linear, infinite. Respect the motion toggle (pause the dash when motion is paused).
- Run states (from C): passed node border `#bcd6c4` + edge `#6f9c7e`; running node accent border + `0 0 0 4px #8062bd1f` glow + "Running · m:ss" with pulse dot; waiting = muted label. Fail/blocked edges dashed `6 5` `#b0556a` with a red-bordered label chip ("Changes requested").
- Editor header keeps the full workflow name (today it truncates to "revi").
**Rejected:** B — pills drop the description, titles truncate; C layout — role rows force positions.

## 2b. Manage AIs
**Chosen:** Variant A — list + detail, designed. Mockup: `manage-ais-a.html`.
**Why:** User picked A: keeps today's familiar structure, fixes the empty, broken detail.
**Real files to touch:** `client/studio-settings.tsx` (`Connections`, `GlmSettings`), studio stylesheet (`.connection-list`, `.connection-choice`, `.connection-settings`), usage from `client/provider-usage.ts` / `/api/quota`, role from `/api/roles`, models from `/api/models`.
**Implementation notes:**
- Left list (260px): `AIs` + muted `N connected`; each row = 28px engine logo tile · name (14px/500) · connection line (12px muted) · 7px green dot when ready. Selected row: `color-mix(#fff 45%, paper)` + 1px `--line` border, 12px radius. "Add an AI" is a dashed 1px `#c5cbdb` button.
- Detail card: 1px `--line` border, 16px radius, 24/28px padding, max 720px. Header = 40px logo tile, name 20px/500, connection line, `Ready` pill (done colors from Agents). Then description; a two-column row of Usage (bars in engine color, label/percent) and Used for (role pill `#ece7f8`/`#6b4fb0` + "Change in Workflows · Roles"); Models as mono chips; per-AI settings (GLM: z.ai base URL + token, flat `#e2e6f0` fields, accent Save); footer divider with "Check connection" + "Checked when a job starts · last OK <time>".
- Replaces the broken inline `Built in Checked when a job starts.` line.
- Added connections (Qwen, OpenCode, CLI) use the same card; their existing form fields (name, advanced settings, auto-approve switch, check/remove) go in the settings section.
**Rejected:** B — card grid; C — roles-first.

## 3. Left sidebar (chats + terminals)
**Chosen:** A when open (ChatGPT-style list grouped by day) + C when collapsed (60px icon strip of live items). Mockups: `sidebar-a.html`, `sidebar-c.html`.
**Why:** User picked "a+c". One shared sidebar replaces the terminal-only rail, so chat and terminal screens match, and it can collapse.
**Real files to touch:** `server/views/shell.ts` (new `<aside>` before `.canvas`; toolbar's search / New chat / caret menu move into it; `#rail` in `#live` removed), `client/shell.ts` (collapse toggle, persisted in `localStorage`), `client/chat.ts` (`paintHistory` data → sidebar rows; History screen stays for full search), `client/terminals.ts` (rail cards → sidebar rows, keep end-session / rename / drag-to-split on the row), `public/quiet.css` (`.rail*` rules → sidebar rules).
**Implementation notes:**
- Open: 264px, right border 1px `--line`, background `color-mix(#fff 18%, paper)`. Top row: sidebar toggle (left) + search (right), 32px flat icon buttons. Then `New chat` (bordered, accent plus icon) and `New terminal` (ghost). List groups `Today / Yesterday / Earlier` (11px uppercase muted). Footer: `All history` → the existing History screen.
- Row: 18px icon (chat bubble, or terminal icon tinted `#6b7ea3`) · title (13.5px, ellipsis) · optional sub-line (`2 agents`, `1 needs you`) · 7px state dot: running purple pulse, live terminal green pulse, landed green, needs-you red. Selected row: `color-mix(#fff 55%, paper)` + inset 1px `--line`.
- Content: only this app's chats and live terminals. Claude-history and outside sessions stay in All history.
- Collapsed: 60px strip — toggle, accent `+` (new chat), search, a divider, one 36px icon per live item with its dot (title as tooltip), History at the bottom.
- Bug fix alongside (server): `server/quota.ts` `parsePsOutput` matches `\bclaude\b` anywhere in the command line, so claude-mem's worker, chroma-mcp, plugin MCP servers and Claude Code's own shell subprocesses show as "Claude · <folder>" outside sessions. Match on the executable's basename only (`claude` / `codex`, or `node …/claude`), and skip headless runs (`-p`, `--output-format stream-json`, `--input-format`).
**Rejected:** B — Running-now group + filter tabs.

## 4. Terminal header
**Chosen:** Variant C + name — no header row; a floating bar at each terminal's top-right: engine logo · terminal name · Live pill · Find icon. Mockup: `terminal-c.html`.
**Why:** User picked C and asked for the name in it. Removes the heavy "Find ⌘F" pill + bare status text, gives the terminal its height back, and works per pane when split.
**Real files to touch:** `server/views/shell.ts` (`.live-heading` removed; bar lives inside each pane), `client/terminals.ts` (`setStatus` → pill state; find bar opens from the icon), `client/terminal-panes.ts` (one bar per dockview pane), `public/quiet.css` (`.live-heading`, `.find-open`, `#live-status` → new bar rules).
**Implementation notes:**
- Bar: absolute top 12px / right 12px inside the terminal host, 1px `--line` border, 14px radius, `color-mix(#fff 45%, paper)`, padding 5/6px, gap 8px.
- Contents: 26px engine logo tile (8px radius, engine tint) · name 13px/500 `#505e75`, ellipsis at 260px, `title` = full cwd · status pill · 1px divider · 28px borderless Find icon (tooltip "Find · ⌘F").
- Status pill: Live = `#3f7352` on `#dcece1` with a pulsing 7px dot; Connecting/Reconnecting = muted pill; Disconnected = red pill that doubles as the Reconnect button.
- Find: clicking the icon (or ⌘F) widens the bar into the existing find field (input, count, prev/next, close) in place.
- Split panes: each pane shows its own bar; the active pane's bar is full opacity, others 70%.
**Rejected:** A — header row with status pill; B — always-visible find field.
