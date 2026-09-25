# Mission Control 2.0 · Phase 1 · Terminals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The quiet shell runs several live terminals at once with the session rail, drag-to-split, rename, end, file drop, Find and the dotted-glow background decided in the Terminals study.

**Architecture:** One island (`client/terminals.ts`) owns a `Map` of terminal views (xterm + fit + search + web-links + socket each) and renders the rail; a small pane module (`client/terminal-panes.ts`) wraps dockview-core for the split layout and dividers only — dragging a rail card and the drop zones are ours, matching the study; pure helpers (`client/terminal-state.ts`) carry the testable logic. Markup lives in `server/views/shell.ts`; styles in `public/quiet.css`. No server changes: every feature uses the existing terminal API (`GET/POST/PATCH/DELETE /api/terminals`, `POST /api/terminals/drops`, `/ws/terminal/:id`).

**Tech Stack:** Bun, Elysia views, xterm 6 (`@xterm/xterm`, `addon-fit`, `addon-search`, `addon-web-links` — all installed), `dockview-core` 8.3.1 (new, MIT, zero deps), `bun test`, `tsconfig.shell.json` type-check test.

**Spec:** `docs/new-design-port-status.md` §1 (items 1–7 with the chosen variants), studies `docs/design/quiet-chat/terminals-{1..7}-*.html`, `docs/design/quiet-chat/terminals.css`; roadmap `docs/superpowers/plans/2026-09-24-v2-roadmap.md`.

## Global Constraints

- Trunk-based on `main`; one commit per task; every task's work is committed before the next starts; never `git merge`; never push without the user.
- Comments: max 1 line, only for a trap no refactor can express. No emoji. Provider identity = `/providers/<id>.svg`.
- Form fields flat (`#e2e6f0`, no inset). Neumorphism on cards, dialogs, buttons only.
- `bun test` green after every task; `test/shell-typecheck.test.ts` covers every quiet island — add new islands to `tsconfig.shell.json`.
- The app on 7777 is the user's live tool: server view changes take effect only when the user restarts. Verify on a throwaway instance (`MISSION_CONTROL_PORT=7781 MISSION_CONTROL_CONFIG_DIR=<scratch>`), stop it by PID.
- Status dots: green `#5b8a6a` = output in the last 5 s, grey `#9aa3b5` otherwise. Amber "waiting for you" needs prompt detection and is deferred to phase 2's chat (ledger ruling).
- The rail lists every running terminal from `GET /api/terminals` (polled every 5 s, and refreshed after create/rename/end); the active terminal id is remembered in `localStorage` `mc.quiet.terminal`; a reload restores the remembered one (or the first running).

## Review Focus

1. Two terminals open, one ended from the rail while it is also shown in a split pane → the pane must disappear and the other terminal keep its socket. (Task 4 test on `paneLayoutAfterEnd` + manual.)
2. A terminal that finished by itself (socket close 4410) → its card shows "Ended", is removed on the next poll, and the active view falls back to another terminal instead of a dead pane. (Task 1 test `nextActiveAfterRemoval`.)
3. Dropping a rail card onto its own pane, or onto a pane already showing it → no duplicate pane, no error. (Task 2 test `splitPlan` rejects same id.)
4. Dragging files (not a card) over the stage must show the file overlay, never the split zones; dragging a card must never show the file overlay. (Task 5 test `dragKind`.)
5. ⌘F while typing in the terminal must open Find without sending `f` to the shell; Esc closes Find and returns focus to the terminal. (Task 6 manual check + `findKeys` test.)

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `client/terminal-state.ts` (new) | pure: `sessionState`, `latestLine`, `nextActive`, `splitPlan`, `dragKind`, `findKeys`, `renameValue` | 1–6 |
| `client/terminals.ts` (new, replaces `client/shell-terminal.ts`) | views map, sockets, rail render, launcher wiring, restore | 1, 3, 4, 5, 6 |
| `client/terminal-panes.ts` (new) | dockview wrapper: single/beside/below, pane header, close | 2 |
| `client/backdrop.ts` (new) | dotted-glow canvas + pause | 7 |
| `server/views/shell.ts` | rail + stage markup, find bar, drop overlay, backdrop canvas, pause button | 1, 5, 6, 7 |
| `public/quiet.css` | rail, panes, rename field, end dialog, drop overlay, find, backdrop | 1–7 |
| `test/terminal-state.test.ts` (new) | pure helpers | 1–6 |
| `test/shell.test.ts` | markup markers | 1, 5, 6, 7 |
| `client/shell-terminal.ts`, `client/shell-launch.ts` | deleted / trimmed after Task 1 (launcher helpers move into terminals.ts; `shell-launch.ts` keeps the pure ones) | 1 |

---

### Task 1: Several terminals and the session rail `[here]`

**Files:** Create `client/terminal-state.ts`, `client/terminals.ts`, `test/terminal-state.test.ts`. Modify `server/views/shell.ts` (`#live` section), `public/quiet.css`, `tsconfig.shell.json`, `test/shell.test.ts`. Delete `client/shell-terminal.ts` (its launcher/socket code moves into `client/terminals.ts`).

**Interfaces:**
```ts
// client/terminal-state.ts
export type Session = { id: string; engine: string; cwd: string; title: string; model?: string | null }
export type SessionState = 'working' | 'idle' | 'ended'
export function sessionState(lastOutputAt: number | null, ended: boolean, now: number): SessionState  // working when now - lastOutputAt < 5000
export function latestLine(raw: string): string  // strip ANSI/CSI/OSC, last non-empty line, max 80 chars
export function nextActive(ids: string[], removed: string, current: string | null): string | null
```
- Markup (`#live`): `<div class="with-rail"><aside class="rail" id="rail" aria-label="Terminals"><div class="rail-head"><span id="rail-count">Terminals</span><button class="round" id="rail-new" aria-label="New terminal">+</button></div><div id="rail-cards"></div></aside><div class="live-main" id="live-main"><header class="live-heading">…existing…</header><div id="live-stage" class="live-stage"></div></div></div>`. Each terminal's xterm host is a `div.term-host` inside `#live-stage`; only the active one is shown until Task 2.
- Rail card (rendered by `terminals.ts`): `<button class="session-card" data-id aria-current><header><img class="logo" src="/providers/<engine>.svg"><span class="card-title">title</span><span class="dot" data-state></span></header><small>Engine · model · state</small><code>latest line</code></button>`.
- Steps: write the three pure functions with tests (RED → GREEN); port the socket/attach code from `shell-terminal.ts` into a `TerminalView` class keyed by id; `refreshSessions()` polls `GET /api/terminals` every 5 s and reconciles cards (add/remove, keep xterm instances); clicking a card activates it (`showView(id)`, fit, focus); `rail-new` and the New chat → Terminal item both open the launcher; after `POST /api/terminals` the new terminal is added and activated without replacing others; `remember(id)` on activate; `restoreRequested(location)` restores the remembered id else the first running.
- Tests (`test/terminal-state.test.ts`): `sessionState` boundaries (4999 ms working, 5000 idle, ended wins); `latestLine` strips `\x1b[31m`, OSC titles, `\r`, returns the last non-empty line, truncates at 80; `nextActive` picks the neighbour after the removed one, then the previous, then null.
- Commit: `feat(terminals): session rail with several live terminals`.

### Task 2: Drag a card onto the terminal to split `[here]`

**Files:** `bun add dockview-core@8.3.1`; create `client/terminal-panes.ts`; modify `client/terminals.ts`, `client/terminal-state.ts` (`splitPlan`), `server/views/shell.ts` (head links `/js/terminals.css` for dockview's stylesheet emitted by Bun.build — same pattern as `/js/studio.css`), `public/quiet.css`, tests.

**Interfaces:**
```ts
// client/terminal-state.ts
export type SplitPlan = { id: string; direction: 'right' | 'below' } | null
export function splitPlan(dragged: string, shown: string[], zone: 'right' | 'bottom' | null): SplitPlan  // null when dragged already shown or no zone
// client/terminal-panes.ts
export type Panes = { show(id: string, host: HTMLElement, header: PaneHeader): void; split(id: string, host: HTMLElement, header: PaneHeader, direction: 'right' | 'below'): void; hide(id: string): void; shown(): string[]; onHide(cb: (id: string) => void): void }
export type PaneHeader = { logo: string; title: string; caption: string }
export function createPanes(root: HTMLElement): Panes
```
- Read `node_modules/dockview-core/dist/cjs/index.d.ts` for the exact `createDockview` options before coding (`createComponent`, `createTabComponent`, `addPanel({ position: { referencePanel, direction } })`, `panel.api.close()`, `onDidRemovePanel`); import `dockview-core/dist/styles/dockview.css` from `terminal-panes.ts`.
- The tab component renders the study's pane header (logo, name, model caption, × that calls `hide`, not end). One panel per group. Dockview's own dnd is disabled (`disableDnd: true`); the rail card is `draggable` with `dataTransfer.setData('text/x-mc-terminal', id)`; while dragging, `#live-stage` shows the two zones from the study (`.drop-zone.right`, `.drop-zone.bottom`), highlighting the one under the pointer; on drop, `splitPlan` decides and `panes.split(...)`. Hiding the last-but-one pane returns to single view. Dividers: dockview's, restyled to 14px gap with the paper colour.
- Tests: `splitPlan` — same id → null; no zone → null; right → `{ direction: 'right' }`; bottom → `'below'`.
- Commit: `feat(terminals): drag a session card onto the terminal to open it beside or below (dockview)`.

### Task 3: Rename from the rail card `[here]`
- `renameValue(current: string, typed: string): string | null` (trim; empty or unchanged → null; max 60) + tests. Double-click on `.card-title` swaps in a flat `input.name-edit` (study `terminals-3-rename.html` styles); Enter → `PATCH /api/terminals/:id { title }` then refresh; Esc/blur → cancel; hint line "Enter to save · Esc to cancel · empty keeps the old name".
- Commit: `feat(terminals): rename a session from its rail card`.

### Task 4: End a session `[here]`
- Hovering a card shows `.card-x` (study `terminals-4-end.html`); click → `<dialog id="end-session">` "End <title>? This stops its running process. Its history stays in History." with Cancel / End session (`.danger` `#b0556a`); confirm → `DELETE /api/terminals/:id`, `panes.hide(id)`, dispose the view, `nextActive`, refresh. Socket close 4404/4410 marks the card "Ended" until the next poll removes it.
- Test: `nextActive` already covers fallback; add `endLabel(title)` trivial? No — test the dialog markup marker in `test/shell.test.ts` instead.
- Commit: `feat(terminals): end a session from its rail card with a confirm dialog`.

### Task 5: Drop files into a terminal `[here]`
- `dragKind(types: readonly string[]): 'card' | 'files' | 'none'` + tests (`text/x-mc-terminal` → card; `Files` or `text/uri-list` → files; else none). While files hover over the active pane, show the study overlay (`.drop-over`: "Drop to add N files", file-name chips from `dataTransfer.items`, "Their paths are typed at the prompt · up to 100 MB each"). On drop: port `handleDrop`/`uploadDrop` from `client/terminal.ts:838-882` (uses `shellQuote`, `pathsFromUriList` from `client/shared.ts`); type the quoted paths into the active terminal's socket; toast "Added N files" (`.toast`, 2 s).
- Commit: `feat(terminals): drop files onto a terminal to type their paths`.

### Task 6: Find and clickable links `[here]`
- Load `WebLinksAddon` and `SearchAddon` per view (`@xterm/addon-web-links`, `@xterm/addon-search`; `onDidChangeResults` gives `{ resultIndex, resultCount }`). Heading gets `<button class="pill find-open" id="find-open">Find <kbd>⌘F</kbd></button>` which swaps for `.find` (flat input, "n of m", prev/next/close — study `terminals-6-find.html`). `findKeys(event: { key, metaKey, ctrlKey, shiftKey })` → `'open' | 'next' | 'prev' | 'close' | null` + tests; `terminal.attachCustomKeyEventHandler` returns false for ⌘F so the shell never sees it.
- Commit: `feat(terminals): find in the terminal and clickable links`.

### Task 7: Dotted-glow background `[here]`
- `client/backdrop.ts` from the study script (`terminals-7-background.html`: 22px grid, near-white dots at 60% alpha, twinkle, mouse lens 150px follow .12 fade .08, click ripple 450px/s band 36 life 1100 ms, ripple ignored on interactive elements); `<canvas id="backdrop" aria-hidden>` fixed behind `.canvas`; `.canvas` background transparent, `.term`/cards keep `var(--paper)`; `<button class="pill motion-toggle" id="motion">Pause motion</button>` bottom-left, state in `localStorage` `mc.motion.paused`, starts paused under `prefers-reduced-motion`. `test/shell.test.ts` markers; island in `tsconfig.shell.json`.
- Commit: `feat(ui): dotted-glow background with mouse lens, click ripple and pause`.

## Restart points
Every task touches `server/views/shell.ts` → the user's 7777 shows Phase 1 only after a restart; all verification happens on a throwaway.

## Self-review
- Spec coverage: §1 items 1–7 → Tasks 1–7; "resume/outside sessions in History" and the chat transcript are phases 3/2 by decision.
- Type consistency: `Session`, `SplitPlan`, `Panes`, `PaneHeader` defined once (Tasks 1–2) and reused; `nextActive` used by Tasks 1 and 4.
- Review Focus 1–5 pinned to Tasks 4, 1, 2, 5, 6.
