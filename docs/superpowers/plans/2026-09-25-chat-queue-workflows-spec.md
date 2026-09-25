# Chat queue, restart-safe reports, Studio workflows from the chat, SPEC 2.0

**Goal:** (1) messages sent while the chat is replying queue up like Claude Code and go out in order; (2) agent reports survive a server restart and, when the app comes back, the chat catches up inside the conversation; (3) naming a Studio workflow in the chat runs it (optional — without a name the chat picks its own agents), with "Chat decides" steps using the chat's AI; (4) docs/SPEC.md describes 2.0.

**Spec:** `docs/decisions/system-chat.md` (binding), user decisions 2026-09-25: queue like Claude Code; after a restart the AI updates inside the chat like Claude Code after a reconnect; a workflow can be named but does not have to be.

## Global Constraints
- Trunk-based on `main`, commit per task, never push, never touch port 7777 (throwaway on 7781/7782).
- No comments except one line for a trap; no emoji; flat inputs.
- Full `bun test` green before each commit; tests in the style of test/chat-reports.test.ts and test/jobs-routes.test.ts.

---

### Task A: One persistent chat queue `[agent]`

**Files:** create `server/chat-queue.ts`; modify `server/chat-reports.ts`, `server/routes/jobs.ts`, `server/jobs.ts` (JobRecord `reportedAt?: number | null` + `updateJob` patch type), `server/index.ts`; tests `test/chat-queue.test.ts`, `test/chat-reports.test.ts`, `test/jobs-routes.test.ts`.

**Design:**
- Queued **user** messages persist in `<configDir>/chat-queue.json` (atomic write, same helper style as `atomicJson` in server/workflows.ts): `{ items: Array<{ id: string; chatId: string; text: string; queuedAt: number }> }`. `createChatQueue(path)` → `{ list(chatId), add(chatId, text) → item, remove(chatId, id) → boolean, take(chatId) → items (removes them), chats() → string[] }`.
- **Agent reports are derived, not stored:** a chat agent needs reporting when `chatId` is set, it is settled (`status !== 'running'`), it is not part of a workflow run (`!workflowRunId`), and `reportedAt` is null. When a report goes into a chat turn, set `reportedAt: Date.now()` on the agent via `manager.updateJob` (persisted). This makes reports survive a restart with no extra store.
- **One serial flusher per chat** (reuse the per-chat promise chain already in `createReportPoster`; rename/extend it into `createChatFlusher(manager, resolver, { queue, notify, logReader, retryMs?, retryLimit?, schedule? })` exporting `{ kick(chatId), onAgentSettled(record), recoverAll() }`). A flush for a chat, when its chain is idle and has a session id: take all queued user messages + all unreported agents; if nothing, return. Build ONE turn: user messages first (joined by a blank line), then, if there are reports, a blank line and the report block (existing `agentReport` messages joined). `source` = `'user'` when any user message is in it, else `'agent'`. Mark the included agents `reportedAt`. The breaker (12 agent rounds without a user turn) still applies only to agent-only turns. If the chain is running → schedule a retry (existing `wait`), never drop user messages (no retry limit for them; the agent-only retry limit stays but no longer drops — it just keeps waiting, since reports are now durable; remove the drop-on-limit for reports and keep the log line).
- **Restart catch-up:** `recoverAll()` runs once at startup (server/index.ts after the manager exists): for every chat root that has queued user messages or unreported settled agents, `kick` it. When the turn it builds contains reports of agents that settled while the server was down or while the report was waiting across a restart, prefix the report block with the line `[Mission Control restarted — catching up]`. Detect "across a restart" simply: the flusher remembers which agents it has seen settle in this process (`onAgentSettled`); unreported agents it did not see are restart catch-ups. Orphans adopted at startup that settle later go through `onJobSettled` normally.
- **Reply route** (`POST /api/jobs/:id/reply`) for chat threads: if the chain is running, instead of 409 add to the queue and return **202** `{ queued: true, item }`; if idle, keep today's immediate turn, but first `take` any queued items for that chat and prepend them to the message so nothing is lost or reordered. After any chat turn settles (`onJobSettled` for `purpose === 'chat'`), `kick(threadRoot)` so the queue drains.
- New routes: `GET /api/jobs/:id/queue` → `{ items }` (id = chat root or any turn; resolve to the root); `DELETE /api/jobs/:id/queue/:itemId` → `{ ok: true }` or 404.
- `server/index.ts`: chat turns settling → `flusher.kick(record.threadRoot)`; chat-spawned agents settling (have `chatId`, no `workflowRunId`) → `flusher.onAgentSettled(record)`; keep skipping auto-review for them.

**Tests (write first):** queue store add/list/take/remove survive a new instance on the same file; reply while running → 202 and the item is listed; when the running turn settles the queued message becomes the next turn's prompt (two queued messages → one turn, in order); an agent settling while a turn runs is folded into the next turn after the queued user text; `reportedAt` is set and a second flush does not repeat it; recovery: a manager loaded from a jsonl that has a settled chat agent with no `reportedAt` and a chat root with a session → `recoverAll()` creates one turn whose prompt starts with `[Mission Control restarted — catching up]`; DELETE removes a queued item; existing breaker/needs-you tests keep passing (adapt the drop-on-limit test to "keeps waiting and logs").

**Commit:** `feat(chat): queued messages and restart-safe agent reports in one per-chat queue`

---

### Task B: Name a Studio workflow in the chat `[agent]` (after A)

**Files:** `server/workflow-runner.ts`, `server/routes/studio.ts`, `server/chat-profile.ts`, `server/chat-reports.ts` (run report), `server/index.ts`; tests `test/workflow-runner.test.ts`, `test/studio-routes.test.ts`, `test/chat-profile.test.ts`, `test/chat-reports.test.ts`.

- `POST /api/studio/runs` accepts optional `chat` (existing chat root id), `chatTurn`, `engine`, `model`. `start()` stores `chatId`, `chatTurn` on the run; `agentsFor(workflow, chatDefault?)` resolves every step whose `agent.engine` is unset to `chatDefault.engine` / `chatDefault.model` when given (else the stored roles, as today). Jobs the runner creates for a chat run carry `chatId`, `chatTurn` and `reason: 'Studio · <workflow name> · <step title>'` so they appear on the chat's team card; their `label` is the step title.
- Step jobs of a run (`workflowRunId` set) are never reported individually. When a chat run reaches a final status (done / failed / blocked / stopped), the runner calls an injected `onRunSettled(run)`; server/index.ts turns that into a flusher report: `[workflow <name> · <status>]` + one line per attempt (`<step> · <outcome> · <summary>`), treated like an agent report (durable: persist `reportedAt` on the run record, and include unreported settled chat runs in `recoverAll`).
- CHAT_RULES: replace the one-line "Naming a Studio workflow makes you follow it instead." with a short section: when the owner names a Studio workflow (GET $MC_URL/api/studio/workflows lists them by name; match case-insensitively), start it with POST $MC_URL/api/studio/runs {"workflowId","revision","cwd":<project>,"label","request":<the owner's request>,"chat":"$MC_CHAT_ID","chatTurn":"$MC_JOB_ID","engine":<your own engine>,"model":<your model or omit>} instead of spawning agents yourself; the run reports back as "[workflow …" turns; do not spawn agents for the same work. Without a named workflow, keep choosing agents yourself. The chat's own engine/model: add them to `chatRules` context (`engine`, `model`) and state them in the text.
- Tests: runner resolves unpinned steps to the chat default and keeps pinned ones; chat run jobs carry chatId/chatTurn/reason and no individual reports; `onRunSettled` fires once with the final status; studio route rejects an unknown `chat`; CHAT_RULES mention `/api/studio/runs` and `$MC_CHAT_ID`.

**Commit:** `feat(chat): naming a Studio workflow runs it from the chat; Chat decides uses the chat's AI`

---

### Task C: Queue UI in the chat `[here]` (after A)
- Send stays enabled while the chat replies; `POST reply` 202 → the message shows under the conversation as a muted "Queued" bubble with ×; `GET /api/jobs/:id/queue` polled with the thread; × calls DELETE; queued bubbles disappear when their turn starts. Catch-up turns render like agent reports with their first line.

### Task D: docs/SPEC.md for 2.0 `[agent]` (parallel)
- Rewrite docs/SPEC.md as the engineering contract of 2.0 from the code (server/index.ts routes, server/*.ts modules, client islands, config files, security model), keeping the existing section structure where it still fits. Every endpoint listed with method, path, body, response, guard. Mention the chat queue and workflow-from-chat only as "in progress" if Tasks A/B have not landed when you write; the main session will update those lines after.
