# Redesign 2.1 — Lane 3: left sidebar, terminal corner bar, History fix

Repo: mission-control (Bun + Elysia, vanilla TS client, `bun test`). Base branch: `main`.
Design source: `docs/design/redesign-2-1/DECISION.md` §3 (sidebar A open + C collapsed) and §4 (terminal corner bar). Mockups to match: `sidebar-a.html`, `sidebar-c.html`, `terminal-c.html` with `sidebar-mock.css` and `terminal-mock.css` (serve with `npx live-server docs/design/redesign-2-1 --port=51960` if not up).

## Decisions
- One `<aside id="sidebar" class="sb">` in `server/views/shell.ts`, placed before `<main class="canvas">`, inside a new wrapper `<div class="sb-shell">` (`grid-template-columns: 264px minmax(0,1fr)`; collapsed `60px minmax(0,1fr)`). It is visible on every screen (welcome, conversation, history, studio, terminals).
- The toolbar's left `nav[aria-label="Chats"]` (search button, New chat split button, `#new-chat-menu` popover) is removed; its actions move into the sidebar: search icon → opens the History screen (same as today's `#search`), `New chat` → today's `#new-chat` behaviour, `New terminal` → today's `[data-live]` behaviour (opens the launcher).
- Keep the element ids `new-chat` and `search` on the sidebar buttons so `client/shell.ts` handlers keep working; `[data-live]` moves onto the `New terminal` button.
- Sidebar rows come from `GET /api/history` filtered to `kind === 'chat' || kind === 'terminal'`, grouped `Today / Yesterday / Earlier` via `historyDay` (`client/chat-view.ts`; `Earlier` = anything not Today/Yesterday). Row click: chat → `openChat(id)`; terminal → `dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { id } }))`. Selected row = the open chat or the active terminal.
- Row dot: chat uses `chatSignal` (running purple pulse, needs-you red, landed green); terminal = green pulse. Sub-line: `N agents` when a chat has running agents, `N needs you` when failed agents exist.
- Terminal row actions keep today's rail-card features: end session (hover `×` → `#end-session` dialog), rename (double-click title), drag a terminal row onto the terminal stage to split (`drop-right` / `drop-bottom` zones). Port these from `client/terminals.ts` `buildCard` / `paintCard` / `startRename` / `askEnd` onto the sidebar rows; delete `#rail`, `.with-rail` and their CSS.
- Collapsed state: the toggle button collapses to Variant C (60px strip: toggle, accent `+` new chat, search, divider, one 36px icon per live item — running chats and live terminals — with its dot and a `title` tooltip, History icon at the bottom). Persist in `localStorage['mc.sidebar.open']` (`'0'` = collapsed). Under `max-width: 900px` the sidebar starts collapsed.
- `All history` footer button opens the History screen, which keeps listing every kind (chats, terminals, Claude history, outside sessions).
- Terminal corner bar replaces `.live-heading`: per dockview pane, an absolutely positioned bar at the pane's top-right (values in DECISION.md §4): engine logo tile · name (ellipsis 260px, `title` = cwd) · status pill · divider · Find icon. `setStatus` maps: text starting `Connected` → Live pill (`#3f7352` on `#dcece1`, pulsing dot); `Connecting…`/`Reconnecting…` → muted pill with that text; anything else → red pill `Disconnected · Reconnect` that runs today's `#live-reconnect` action. Clicking the Find icon or ⌘F widens the active pane's bar into today's find controls (`#find` input, count, prev/next, close). Inactive panes' bars are 70% opacity.
- History fix (server): in `server/quota.ts` `parsePsOutput`, decide the engine from the executable only: take the first whitespace-separated token of `command`; engine is `claude` when its basename is `claude`, or when the basename is `node`/`bun` and the second token's basename is `claude` or `cli.js` inside a path containing `/claude-code/`; `codex` when the first token's basename is `codex`, or `node` + second token basename `codex`. Skip the process when the command contains any of ` -p `, ` --print`, `--output-format stream-json`, `--input-format stream-json`.

## Preserve
- `openChat`, `quiet:new-chat`, `quiet:open-terminal` (with `id`, `restore`, `resume`, `cwd` details) behaviour.
- History screen and its search (`#history`, `#chat-search`) unchanged.
- Terminal find (`openFind`, `closeFind`, `findStep`, ⌘F), drag-and-drop file upload (`#drop-over`), toast, end-session dialog, rename API calls (`client/terminals.ts`).
- `buildHistory` owned-pid filtering and `outsideItem` output shape (`server/history.ts`); the existing `parsePsOutput` tests in `test/quota.test.ts` for real `claude`/`codex` processes keep passing.
- Toolbar right side (usage card, Studio, Agents, Flow, motion, Access) unchanged.

## Tasks (one commit each, in order)

### Task 1 — History ignores helper processes
Files: `server/quota.ts`, `test/quota.test.ts`.
- Implement the Decisions rule in `parsePsOutput(raw: string, ownedPids: ReadonlySet<number>)`.
- Tests, each a one-line `ps` row after the header `  PID ELAPSED COMMAND`: `75479 37:49 claude` → claude; `111 01:00 /Users/x/.local/bin/claude --resume abc` → claude; `112 01:00 node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js` → claude; `113 01:00 codex` → codex; `8460 03-06:14:35 /Users/x/.bun/bin/bun /Users/x/.claude/plugins/cache/thedotmack/claude-mem/12.3.9/scripts/worker-service.cjs --daemon` → skipped; `8510 03-06:14:33 /Users/x/.local/bin/uv tool uvx --python 3.13 chroma-mcp --data-dir /Users/x/.claude-mem/chroma` → skipped; `9224 30:08 /bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh` → skipped; `32970 00:13 /Users/x/.local/bin/claude --output-format stream-json --verbose --input-format stream-json` → skipped; `114 00:10 claude -p hi` → skipped.
- Commit: `fix(history): only real claude and codex sessions count as outside sessions`

### Task 2 — sidebar shell and collapse
Files: `server/views/shell.ts`, `client/shell.ts`, `public/quiet.css`, `test/views.test.ts` (or the existing shell markup test).
- Markup per Decisions (static parts: head row, New chat, New terminal, empty `<nav id="sidebar-list">`, footer; collapsed strip markup). Move ids/handlers. CSS from `sidebar-mock.css` (`.sb*` rules) adapted to real ids.
- Test: rendered shell contains `id="sidebar"`, `id="new-chat"`, `data-live`, and no `aria-label="Chats"` nav.
- Commit: `feat(shell): a ChatGPT-style sidebar holds New chat, search and the session list`

### Task 3 — sidebar rows from history
Files: new `client/sidebar.ts` exporting `sidebarGroups(items: HistoryItem[], now: number): { day: 'Today' | 'Yesterday' | 'Earlier'; items: HistoryItem[] }[]` and the painter; `client/chat.ts` (export a small hook so the sidebar knows the open chat id — dispatch `quiet:chat-open` with the id in `openChat`); `server/views/shell.ts` (add the script tag); `test/sidebar.test.ts`.
- Poll `/api/history` every 5s while the tab is visible (reuse the idle cadence), repaint only when the signature changes.
- Tests: items updated today/yesterday/5 days ago land in `Today`/`Yesterday`/`Earlier`; `claude-history` and `outside` items are dropped; empty groups are omitted.
- Commit: `feat(shell): chats and terminals listed by day in the sidebar`

### Task 4 — terminal rows take over the rail
Files: `client/terminals.ts`, `client/sidebar.ts`, `server/views/shell.ts`, `public/quiet.css`.
- Port rename / end / drag-to-split onto sidebar terminal rows; remove `#rail`, `#rail-cards`, `#rail-toggle`, `#rail-new`, `.with-rail`, `renderRail`'s DOM and their CSS. The live terminal list data (`sessions`) still drives the terminal rows so live terminals appear instantly without waiting for the history poll.
- Commit: `feat(terminals): terminal sessions live in the sidebar`

### Task 5 — terminal corner bar
Files: `server/views/shell.ts` (remove `.live-heading` markup; keep `#find` controls, moved into a template), `client/terminals.ts` (`setStatus`, `openFind`, `closeFind`, per-pane bar), `client/terminal-panes.ts` (mount a bar per pane via its header/content hook), `public/quiet.css` (bar rules from `terminal-mock.css` `.th-*`).
- Commit: `feat(terminals): a floating corner bar shows name, live status and find`

## Tests to run while iterating
`bun test test/quota.test.ts test/history.test.ts test/views.test.ts test/shell.test.ts test/terminals.test.ts test/sidebar.test.ts test/shell-typecheck.test.ts`

## Visual check (required before reporting done)
Run a throwaway server: `MISSION_CONTROL_CONFIG_DIR=$(mktemp -d) MISSION_CONTROL_PORT=7793 MC_FAKE_ENGINES=1 bun server/index.ts` (never touch port 7777; stop it by its PID when done). Screenshot: sidebar open on a chat, sidebar collapsed, a terminal with its corner bar, find open, and a split with two bars. Compare with `sidebar-a.html`, `sidebar-c.html`, `terminal-c.html`; report the paths.

## Constraints
- Do not push. Do not restart or kill the running Mission Control on port 7777.
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- While iterating run only the tests for files you touch; run the full suite ONCE at the end.
- In `server/views/shell.ts` do not touch the `#agents` dialog or the `#flow` section; in `public/quiet.css` only edit rules named in your task or add new ones. Other lanes edit these files in parallel.
