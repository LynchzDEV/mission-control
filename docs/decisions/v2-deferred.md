# 2.0 — what was deferred

Every item below was found by a review during the 2.0 port (2026-09-24/25), judged not to block the release, and left open. Items that were fixed later in the port are not listed. Grouped by area; each line names the phase whose ledger recorded it.

## Chat and agents
- A user reply and an agent report arriving in the same instant can both pass the "chat is running" check; the reply route and the report poster are not one queue (phase 2).
- Agent reports waiting for a busy chat live in memory and are lost on a server restart (phase 2).
- Retry cap: concurrent spawns of the same step can each pass the count before any is recorded; reserve a slot synchronously (phase 2).
- The API token is read after the worktree is prepared; a failed read leaves the worktree behind (phase 2).
- POST and PATCH validate a chat's project differently (PATCH also requires it under Chat home) (phase 2).
- A trailing "?" in an agent's last message raises Needs you even for a rhetorical offer (phase 2).
- "Edited directly" cards show the file but not the diff and Undo the decision doc describes (phase 2).
- Auto-review jobs carry no chatId, so their pass/fail never reaches a chat's team rows; chats that order their own reviews are unaffected (phase 2).
- "Chat decides" on a Studio step still resolves through the stored roles at run start rather than the chat's AI chip; Runs has no "View in chat" link (phase 4).

## Terminals
- `client/terminals.ts` would read better split four ways (view, rail, find, drop) (phase 1).
- Split and rename are mouse-only (drag, double-click); no F2 or keyboard split (phase 1).
- Reordering the rail blurs a focused card; the empty rail line flashes before the first render (phase 1).
- File drop: one failed upload aborts the rest; no client-side 100 MB pre-check; the overlay covers the whole stage in a split (phase 1).
- Find: reopening with the same term steps one match forward; Reconnect can appear beside the open find bar without its status text (phase 1).
- The backdrop canvas is not scaled for devicePixelRatio; the motion button can overlap a scrolled rail on narrow screens (phase 1).

## History
- The external-sessions cache and the history scan have no single-flight; two callers at expiry each run the scan (phase 3).
- Owned pids include ended jobs, so a reused pid could hide an unrelated outside session (phase 3).
- The usage card can list a just-started agent as outside for up to 60 s (phase 3).
- No client tests for the `quiet:open-terminal` branches (id, resume, cwd) (phase 3).

## Studio
- Opening two runs quickly: the last reply wins and the other card can stay open without detail (phase 4).
- Rules renders nothing if `/api/studio/policy` fails (only the error banner) (phase 4).
- A stopped run's last attempt still reads "running" (server) (phase 4).
- Outcome selects no longer offer a self-loop; the server still accepts one (phase 4).
- The Studio bundle is at about 90% of the 500 KB test budget (phase 4).
- No committed browser check for Studio; verification runs against a throwaway instance with Playwright (phase 4).

## Access and foundation
- `Origin: null` skips the Origin check and relies on Fetch Metadata; a few guard edge cases have no test (phase 0).
- `@elysiajs/cookie` is still a dependency though nothing uses cookies (phase 0).
- `docs/SPEC.md` still describes the pre-2.0 app (phase 5).
