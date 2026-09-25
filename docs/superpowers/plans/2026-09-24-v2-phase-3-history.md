# Mission Control 2.0 — Phase 3: History as one list

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** History shows one list — chats, live terminals, resumable Claude history and outside sessions — each labelled, newest first, with the dots and counts the chat already computes, and outside sessions no longer include Mission Control's own agents.

**Architecture:** A new server aggregate `GET /api/history` (`server/history.ts`, pure builder + `server/routes/history.ts`) merges four sources the server already has: chat roots (`manager.listJobs()`), live terminals (`registry.list()`), Claude transcripts on disk (`listSessions(cwd)` from `server/transcripts.ts` for every known project folder) and outside sessions (`fetchExternalSessions(ownedPids)` from `server/quota.ts`, now given the pids Mission Control owns). The client history renderer in `client/chat.ts` switches from `/api/jobs` to `/api/history` and adds per-kind labels and actions.

**Tech Stack:** Bun + Elysia, client islands, `bun:test`.

**Spec:** `docs/decisions/system-chat.md` §Around the chat ("History is one list… Sessions started by Mission Control's own agents are excluded from outside sessions"), `docs/new-design-port-status.md` §1 (Resume / external sessions rows), design `docs/design/quiet-chat/index.html` `#history`.

## Global Constraints

- Trunk-based on `main`, commit per task, never push, never touch port 7777 (verify on the 7781 throwaway).
- No code comments except one line for a trap; no emoji; flat inputs; Neumorphism only on cards/dialogs/buttons; SVG sprite icons; provider logos from `/providers/<engine>.svg`.
- `/api/history` must not read whole transcripts: `listSessions` already reads only directory entries and sizes; keep it that way. Outside-session detection keeps its existing `ps`/`lsof` cost (cached 60 s through `createQuotaCache`).
- Every existing test keeps passing; new server behaviour gets route tests in the style of `test/quota-routes.test.ts` / `test/terminals-routes.test.ts`.

## Review Focus

1. A spawned agent (job pid) or a live terminal (pty pid) must never appear under outside sessions — pass every owned pid, including the chat turns' pids (T1 test).
2. A Claude transcript that belongs to a Mission Control chat or terminal (same `sessionId`) must not be listed twice as "Claude history" (T1 dedupe test).
3. Resuming a Claude history item from History must open the live view on the new terminal, not the launcher (T2).
4. A history item for a terminal that ended between polls must disappear on the next poll without a stale click (T2: re-render on signature change already).
5. `listSessions` over many project folders must stay bounded: limit 20 per folder, folders = the distinct set of known project paths (T1).

---

### Task 1: `GET /api/history` `[agent]`

**Files:**
- Create: `server/history.ts`, `server/routes/history.ts`
- Modify: `server/index.ts` (mount; pass deps), `server/routes/quota.ts` (`/api/sessions/external` passes owned pids too)
- Test: `test/history.test.ts` (pure builder), `test/history-routes.test.ts`

**Interfaces:**
- `type HistoryItem =`
  `| { kind: 'chat'; id: string; title: string; updatedAt: number; project: string | null; running: boolean; agents: Array<{ id: string; label: string; status: string; chatId: string; startedAt: number; landedAt: number | null; stoppedAt: number | null }> }`
  `| { kind: 'terminal'; id: string; title: string; updatedAt: number; cwd: string; engine: string; sessionId: string | null }`
  `| { kind: 'claude-history'; id: string; title: string; updatedAt: number; cwd: string; bytes: number }`
  `| { kind: 'outside'; id: string; title: string; updatedAt: number; engine: 'claude' | 'codex'; pid: number; cwdHint: string | null; etime: string }`
- `buildHistory(input: { jobs: readonly JobRecord[]; terminals: readonly TerminalRecord[]; transcripts: Array<{ cwd: string; sessions: SessionSummary[] }>; outside: ExternalSession[]; now: number }): HistoryItem[]` — pure: chat roots (`purpose === 'chat' && threadRoot === id`) with `updatedAt` = latest turn `startedAt`, `running` = any turn or agent running, `agents` = jobs with `chatId === root`; terminals with `updatedAt = createdAt`; transcripts flattened, excluding any session id equal to a job's or terminal's `sessionId`, titled from `SessionSummary.title`; outside sessions titled `${engine} · ${basename(cwdHint) ?? 'unknown folder'}` with `updatedAt = now - etimeMs(etime)` (`etime` formats `MM:SS`, `HH:MM:SS`, `D-HH:MM:SS`); sorted by `updatedAt` desc.
- `etimeMs(etime: string): number` exported for its test.
- `ownedPids(jobs, terminals): Set<number>` — every job `pid` (running or not is fine; harmless) and terminal `pid`.
- Route `GET /api/history` → `{ items: HistoryItem[] }`; deps `{ manager, registry, knownDirectories: () => string[], external: () => Promise<ExternalSession[]> }`; transcripts come from `listSessions(cwd, { limit: 20 })` for each distinct known directory (chat home if configured, job `baseRepo ?? cwd`, terminal cwds), errors per folder swallowed to `[]`.
- `/api/sessions/external` (existing) → also pass `ownedPids` so the usage card and anything else stop listing agents.

- [ ] **Step 1: Failing tests** — `test/history.test.ts`: `etimeMs('05:30')`, `('01:02:03')`, `('2-00:00:10')`; `buildHistory` with one chat root + one agent turn, one terminal whose `sessionId` matches a transcript (dedupe), one outside session — asserts kinds, order, `running`, the dedupe, the outside title. `test/history-routes.test.ts`: app with a job manager holding a chat root (echo resolver), a registry stub `{ list: () => [...] }`, `knownDirectories` returning a temp projects dir seeded with one fake transcript file under `<projectsDir>/<slug>/<id>.jsonl` (see how `test/transcripts.test.ts` seeds one), `external` stub returning one session whose pid equals the job's pid plus one foreign pid → the response has the chat, the transcript and exactly one outside item.
- [ ] **Step 2: Red.**
- [ ] **Step 3: Implement** as specified; `server/index.ts`: `.use(historyRoutes({ manager: jobManager, registry: terminalRegistry, knownDirectories, external: () => externalSessionsCache.get() }))` — look at how `/api/sessions/external` and the quota cache are built in server/index.ts / server/routes/quota.ts and reuse the same cache with `ownedPids(jobManager.listJobs(), terminalRegistry.list())` computed at call time (the cache fetcher must read the current pids each refresh).
- [ ] **Step 4: `bun test` green.**
- [ ] **Step 5: Commit** `feat(history): one history feed — chats, terminals, Claude history and outside sessions without our own agents`.

---

### Task 2: History screen renders the one list `[here]`

**Files:** `client/chat.ts` (`paintHistory` reads `/api/history`), `client/chat-view.ts` (`historyLabel(item)` pure + test), `client/terminals.ts` (`quiet:open-terminal` gains `{ id }` to activate an existing terminal and `{ resume: { sessionId, cwd } }` to create one with `resumeSessionId`), `server/views/shell.ts` (`#history-title` → `History <span id="history-count">`), `public/quiet.css`, `test/chat-view.test.ts`, `test/shell.test.ts`

- Each item is a `.history-item` details: summary = dot (from `chatSignal` for chats; a live dot for terminals; none otherwise) + title + `<time>` from `historyDay`; the body line = kind label + detail (`Chat · project`, `Terminal · live · <cwd basename> · <engine>`, `Claude history · <cwd basename> · <n KB>`, `Outside session · <engine> · <cwd basename or unknown> · running <etime>`); footer left = the label, right = the action: chats **Continue chat** (`openChat`), terminals **Open terminal** (dispatch `quiet:open-terminal` `{ id }`), Claude history **Resume in a terminal** (dispatch `quiet:open-terminal` `{ resume: { sessionId: id, cwd } }` → `POST /api/terminals { engine: 'claude', cwd, resumeSessionId, title, cols, rows, ...default workflow }` via the existing `createTerminal` path, then `activate`), outside sessions **Open a terminal here** when `cwdHint` exists (launcher prefilled with the cwd) else no action.
- `#history-count` = total items; the search filter (shell.ts) keeps working on text.
- `historyLabel(item): string` pure, tested for the four kinds.
- Verify on the throwaway: a chat, a live terminal, a Claude transcript (the throwaway's own chat sessions create transcripts under `~/.claude/projects` for Chat home — they must be deduped since they belong to chats; open a plain terminal in `/Users/lynchz`, type `exit`, and its transcript appears as Claude history once the terminal is gone), and an outside session (the user's real Claude Code session running this work should appear as outside; the throwaway's spawned agents must not).
- [ ] Commit `feat(history): one list with chats, terminals, Claude history and outside sessions`.

---

### Task 3: Phase check `[here]`
- Roadmap row 3 DONE; `docs/new-design-port-status.md` §1 rows for Resume / external sessions marked done with the commit; ledger closed.

## Self-review
- Spec coverage: one list (T1+T2), labels (T2), spawned agents excluded (T1 ownedPids), dots/counts (already in chatSignal, reused), notifications (Phase 2).
- Types: `HistoryItem` is the single contract between T1 and T2; `ExternalSession` and `SessionSummary` reused unchanged.
- Review Focus 1–5 pinned to T1, T1, T2, T2, T1.
