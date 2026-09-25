# Mission Control 2.0 — Phase 5: Cleanup and v2.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing of the pre-2.0 UI remains — pages, islands, stylesheets, preview tooling and their tests are gone; the two settings that lived on the old Settings page (API token, Chat home) have a home in the shell; the README describes 2.0; `main` is tagged `v2.0`.

**Architecture:** The quiet shell (`server/views/shell.ts` + the islands its script tags load: shell, shell-composer, chat, studio, terminals, shell-activity, usage-card, backdrop) is the whole UI. Everything else under `server/views/`, `client/` and `public/` that is not reachable from it is deleted, with its tests. The Access dialog grows an API-token row (reveal / rotate) and a Chat home row, both flat, using existing routes (`/api/secrets/api-token/reveal`, `/rotate`, `/api/chat/home`).

**Tech Stack:** Bun + Elysia, client islands, bun:test.

**Spec:** roadmap `docs/superpowers/plans/2026-09-24-v2-roadmap.md` row 5; `docs/new-design-port-status.md` §3–§5 (Main/Dispatch/Review removed), §7 (Settings removed; API token stays; Chat home setting).

## Global Constraints

- Trunk-based on `main`, commit per task, never push, never tag until the user says so is NOT required here — the roadmap names the tag as part of this phase, but a tag is a shared-branch side effect: create it locally only (`git tag v2.0`), never push it.
- Never touch port 7777; verify on the 7781 throwaway.
- No comments except one line for a trap; no emoji; flat inputs; Neumorphism only on cards/dialogs/buttons.
- Deletion is dependency-aware: a module goes only when nothing reachable from the shell's script tags (transitively) or from `server/index.ts` imports it. Keep `client/shared.ts`, `client/work.ts`, `client/awareness.ts`, `client/markdown.ts`, `client/shell-launch.ts`, `client/terminal-state.ts`, `client/terminal-panes.ts`, `client/chat-view.ts`, `client/studio-*.ts(x)`; move `providerName` (and the `icon` helper `awareness.ts` uses) out of `client/terminal-view.ts` into `client/shared.ts` and delete `terminal-view.ts`.
- `bun test` green after every task; `test/transpile.test.ts`, `test/views.test.ts` and `test/shell.test.ts` updated rather than deleted where they still describe the shell.

## Review Focus

1. A route or link that still points at a deleted page (`/lanes`, `/dispatch`, `/review`, `/settings`, `/terminals`) — grep every `href` and every `TAB_PAGES` entry (T1).
2. The API token must never render into the DOM until Reveal is clicked, and Rotate must confirm first (T2).
3. `scripts/postinstall.ts` and `public/` must still serve xterm, Neumo, provider logos and fonts after the old stylesheets go (T1).
4. `docs/design/quiet-chat/` stays (design source of truth); `public/quiet-chat/` (a stale copy) goes only if nothing serves it (T1).
5. The tag is local only (T3).

---

### Task 1: Delete the pre-2.0 UI `[agent]`

**Files:**
- Delete: `server/views/dispatch.tsx`, `lanes.tsx`, `layout.tsx`, `model-picker.tsx`, `review.tsx`, `settings.tsx`, `terminals.tsx`, `work.tsx`; `client/agents.ts`, `dialog.ts`, `dispatch.ts`, `flow.ts`, `forms.ts`, `lanes.ts`, `model-picker.ts`, `nav.ts`, `ping.ts`, `plan-view.ts`, `provider-usage.ts`, `quota.ts`, `resize-layout.ts`, `resize.ts`, `sprites.ts`, `terminal-layout.ts`, `terminal-view.ts` (after moving `providerName`/`icon`), `terminal.ts`, `thread-drawer.ts`, `thread-view.ts`, `transcript-view.ts`, `workspace.ts`; `public/theme.css`, `public/theme-tokens.css`, `public/terminal-design.css`, `public/ui-preview/`, `public/quiet-chat/` (verify nothing under `server/` references them first); `scripts/render-ui-preview.ts`; tests that only cover deleted code (`test/model-picker.test.ts`, `plan-view.test.ts`, `settings-refresh.test.ts`, `terminal-layout.test.ts`, `thread-view.test.ts`, `transcript-view.test.ts`, `nav-client.test.ts`, `resize.test.ts`, and any other test whose imports are all deleted — list them in the report).
- Modify: `server/index.ts` (`TAB_PAGES` gone; `/`, `/terminals`, `/lanes`, `/dispatch`, `/review`, `/settings` all 302 to `/` — or `/?screen=studio` for `/studio` as today — with the local guard; remove the `roles`/`models` reads that only fed the old pages; delete `settingsPage`/`terminalsPage`; keep `/api/roles` routes if `server/routes/roles.ts` is still used by the runner — check `readRoles` callers), `server/routes/*.ts` that only served old pages (none expected — verify), `test/views.test.ts` (only the shell and redirects remain), `test/transpile.test.ts` (drop cases for deleted islands), `test/auth.test.ts`/`test/http.test.ts` references to old paths, `README.md` (§"Work, dispatch, and review" and the ui-preview paragraph rewritten for 2.0: chat, terminals, Studio, History, local-only access), `docs/new-design-port-status.md` (§3–§5 "removed" rows note the commit).
- Keep: `client/shell-activity.ts`, `client/work.ts`, `client/awareness.ts` (still used by the Agents/Flow panels).

- [ ] **Step 1: Map the import closure.** From the shell's script tags (`server/views/shell.ts`) walk `client/*` imports transitively; from `server/index.ts` walk `server/*` imports. Write the two keep-lists to the report before deleting anything.
- [ ] **Step 2: Move `providerName` and `icon` from `client/terminal-view.ts` into `client/shared.ts`**; update the three importers; delete `terminal-view.ts`; `bun test test/shell.test.ts test/shell-typecheck.test.ts`.
- [ ] **Step 3: Delete the views and `TAB_PAGES`**; add the redirects; run `bun test` and fix every test that imported a deleted module (delete tests that only covered deleted code; trim the others).
- [ ] **Step 4: Delete the islands, stylesheets, preview dir and script**; `grep -rn` for each deleted name across `server client test scripts docs README.md` and fix stragglers; verify `bun scripts/postinstall.ts` still populates `public/vendor` and `public/providers`.
- [ ] **Step 5: README + port-status.** Rewrite the two README sections; note the removal commit in port-status §3–§5.
- [ ] **Step 6: `bun test` green; start a throwaway; `curl -s -o /dev/null -w '%{http_code}'` for `/`, `/lanes` (302), `/settings` (302), `/js/shell.js` (200), `/vendor/xterm.css` (200), `/providers/claude.svg` (200).**
- [ ] **Step 7: Commit** `chore(ui): remove the pre-2.0 pages, islands, stylesheets and preview tooling`.

---

### Task 2: API token and Chat home in the Access dialog `[here]`

**Files:** `server/views/shell.ts` (`#access` dialog), `client/shell.ts` (or a small `client/access.ts` island), `public/quiet.css`, `test/shell.test.ts`

- Access dialog rows (flat `.field-stack`): **Address** (as today); **API token** — a read-only input showing `••••••••` with a `Reveal` text-button (`POST /api/secrets/api-token/reveal` → shows the value, `Copy` button, hides again on dialog close) and a `Rotate` text-button (flat confirm dialog → `POST /api/secrets/api-token/rotate` → shows the new value); **Chat home** — flat input prefilled from `GET /api/chat/home` (path when ok, else the `reason`), `Save` → `PUT /api/chat/home`, error text inline. The Settings link is gone.
- Markers in `test/shell.test.ts`: `id="access-token"`, `id="access-home"`.
- Verify on the throwaway: Reveal shows a `mct_` token not present in the DOM before the click; Rotate changes it; Chat home save round-trips and rejects `~`.
- Commit `feat(shell): API token and Chat home live in the Access dialog`.

---

### Task 3: Phase check and v2.0 `[here]`

- Roadmap rows 3, 4, 5 DONE; `docs/new-design-port-status.md` header notes 2.0 complete; delete the deferred-items sections that are now done.
- Collect every "deferred" line from the five SDD ledgers into `docs/decisions/v2-deferred.md` (one bullet each, with the ledger it came from) so nothing is lost when the `.superpowers` scratch goes.
- `bun test` green; throwaway smoke: chat send, terminal open, Studio home, History list.
- Commit `docs: 2.0 complete — deferred items recorded`; then `git tag v2.0` (local only; never pushed by this session).

## Self-review
- Roadmap row 5 covers: delete pages + islands (T1), README (T1), tag (T3). §7's "API token stays; copy/rotate still to be wired" and "Chat home editable in Settings" land in T2.
- Review Focus 1–5 pinned to T1, T2, T1, T1, T3.
