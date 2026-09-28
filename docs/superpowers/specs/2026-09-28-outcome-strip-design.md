# Outcome strip — design

Date: 2026-09-28 · Status: draft for review · Placement decision: `docs/design/outcome-strip/DECISION.md` (variant B)

## Intent

The user wants to see, at a glance, how the AI working in a session is doing: a line of green and red squares, one per finished action (tests run, commands executed, edits, spawned agents finishing), and hovering a square says what it was and how it ended.

- **Scope:** per session (a live terminal or a chat), including everything that session spawned: Claude Code sub-agents and cockpit jobs / workflow runs started from it.
- **What earns a square:** actions only. Shell commands, file edits/writes, a spawned sub-agent or job finishing, a workflow acceptance check. Reads, searches, todo updates and other lookups do not.
- **Long-term shape (user's call: "design the best solution for long term and scalable"):** an incremental, persisted outcome ledger rather than re-parsing logs per request.

Success looks like: a failing `bin/ci` shows up as a red square within a few seconds; hovering it shows the command, "Failed · exit 1" and the first error line; a sub-agent's failed test shows as a hollow red square attributed to that sub-agent; the totals count the whole session even after it runs for hours; the line survives a server restart.

## UX (settled in the mockup)

See DECISION.md for exact tokens. In short: a flat line on the session's bottom edge (below the xterm, above the chat composer): `This session` · squares (oldest → newest) · `N passed · N failed`. Solid squares = main agent, hollow = spawned. When the line is full, the oldest squares fall off the left; totals always cover the whole session. Hover shows a popover: tool + target, result, optional detail, who did it, relative time. Before the first action the line shows a muted "No actions yet" so it is visibly working rather than missing.

## What counts, and how pass/fail is decided

| Source | Counted | Pass / fail |
|---|---|---|
| Claude `tool_use` → `tool_result` (main transcript, sub-agent transcripts, Claude job logs) | `Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Agent`/`Task` | `tool_result.is_error` (Claude sets it for a non-zero Bash exit and failed edits). Exit code parsed from the result text (`Exit code N`) when present, for the tooltip. |
| Claude `Agent`/`Task` result | one square when the result says the agent finished (sync result, or `status: "completed"`) | `is_error` → fail. `async_launched` results emit nothing; the sub-agent's own actions still appear from its transcript. |
| Codex terminal rollout (`~/.codex/sessions/**/rollout-*.jsonl`) | `function_call` shell/exec commands; `custom_tool_call` `apply_patch` (edit) | Exit code from the output JSON (`"exit_code": N`) or `Exit code: N` / `Process exited with code N` text. **No exit code found → no square** (never guess a pass). |
| Codex job log (`codex exec --json`) | `item.completed` with `command_execution`; `file_change` | `exit_code` / `status` on the item. |
| Cockpit job linked to the session | one square when the job settles | `status === 'done'` and no reported failure (`reportedJobOutcome`) → pass; otherwise fail, with `exitCode` in the detail. |
| Workflow run linked to the session | one square per acceptance check result | `exitCode === 0 && !timedOut`. |

Out of scope: plan runs (no link to a terminal or chat), sessions Mission Control did not start (external Claude sessions), a global strip, click-to-jump, filters. The same ledger can feed any of these later.

A `tool_use` whose result has not arrived yet produces nothing; the strip only shows finished actions.

## Architecture

```
sources (files + job/run records)
   │  tail from saved byte offsets, only new complete lines
   ▼
outcome-sources.ts   pure parsers: lines → Outcome drafts
   ▼
outcomes.ts          ledger: dedupe, assign seq, append JSONL, totals, cursors
   ▼
routes/outcomes.ts   GET /api/outcomes?terminal=<id>|chat=<id>&after=<seq>
   ▼
client/outcome-strip.ts   poll with the cursor, append squares, tooltip
```

### Session keys and their sources

- `terminal:<id>`, resolved through the terminal registry:
  - main transcript: `registry.transcriptPath(id)` (Claude session file, or the Codex rollout found by `findCodexRollout`)
  - Claude sub-agents: `<transcript without .jsonl>/subagents/agent-*.jsonl`, listed on each sync. The label comes from the parent's `Agent`/`Task` `tool_use` input `description`, linked through `toolUseResult.agentId` on the parent's result line (remembered in the cursor state)
  - cockpit jobs with `terminalId === id` (their logs + their settle outcome)
  - workflow runs with `terminalId === id` (acceptance checks)
- `chat:<rootId>`:
  - main: jobs with `purpose === 'chat'` and `threadRoot === rootId` (the chat's own turns)
  - spawned: other jobs with `chatId === rootId` or `threadRoot === rootId` (same filter as `GET /api/jobs?chat=`); a job that matches the "main" rule is always main, even if it also carries `chatId`
  - workflow runs with `chat === rootId`

### Ledger (`server/outcomes.ts`)

```ts
type Outcome = {
  seq: number                 // 1-based per session, the API cursor
  at: number                  // ms epoch of the result
  ok: boolean
  kind: 'command' | 'edit' | 'agent' | 'job' | 'check'
  tool: string                // 'Bash', 'Edit', 'Agent', 'Job', 'Check', 'apply_patch', …
  target: string              // command line, file path, agent/job label (clipped 200)
  result: string              // 'Passed · exit 0', 'Failed · exit 1', 'Saved', 'Failed', 'Done'
  detail: string              // first meaningful error/summary line(s) (clipped 300)
  actor: { by: 'main' | 'spawned'; label: string; engine: string }
  key: string                 // dedupe identity: `${sourceId}:${toolUseId | jobId | runId#attempt#check}`
}
```

- Storage under `configDir()/outcomes/`: `<sessionKey>.jsonl` holds the outcomes (append-only, one line each), and `<sessionKey>.state.json` holds the cursors: per source path, the byte offset plus `pending` (tool_use id → `{tool, target, actor}` for uses waiting on their result), the `agentId → label` map, and `closed` sources. The state file is written atomically (tmp + rename, the jobs.ts pattern). File names use the session key with `:` replaced by `_`.
- In memory, per session loaded on first read: totals, `lastSeq`, the dedupe `Set<key>`, and the last 500 outcomes. Older ones are read from the file only when `after` asks for them.
- **Sync** (`syncSession(key)`): single-flight per key and throttled to once per 2 s. It resolves the sources, and for each one that is not closed it stats the file, reads `[offset, lastNewline)`, parses, dedupes, appends and advances the offset. A file that shrank (rotated or truncated) resets to offset 0, and dedupe keys prevent duplicates. A job source is marked `closed` once the job has settled and its log is read to the end, so finished jobs cost nothing on later syncs.
- **Write order:** append outcomes first, then save the state. A crash in between re-reads the same bytes next time, and the dedupe keys drop the repeats. This is at-least-once with idempotent apply.
- **Retention:** on startup, delete ledgers untouched for 30 days.

Scaling: a sync costs a `stat` per open source plus the new bytes only. Nothing is re-parsed. Only sessions someone is viewing are synced. Known ceiling: a session with hundreds of simultaneously open sources stats all of them every 2 s. Upgrade path: switch those sources to `fs.watch`, or push-ingest from the job manager's `onJobSettled`, which already exists.

Parsing reuses and extends the existing parsers rather than adding new ones: `session-transcript.ts` (`attachResult` pairing, `parseCodexTranscript`) and `activity.ts` (`collectToolResults`, `reportedJobOutcome`, `codexItemEvents`, which gains `command_execution` / `file_change`). Each parser is a pure function `(lines, pendingState, actor) → { outcomes, pendingState }` so it can be tested on fixture lines alone.

Security: `target` and `detail` pass through the existing `log-redaction.ts` before they are stored (commands can carry tokens). The route sits behind the same local-access guard as every other route.

### API (`server/routes/outcomes.ts`)

`GET /api/outcomes?terminal=<id>` or `?chat=<id>`, with optional `&after=<seq>` (default 0) and `&limit` (default 200, max 500).

→ `200 { items: Outcome[], totals: { passed, failed }, last: number }`: the items after the cursor, oldest first. A first load with no `after` returns the newest `limit` items. Returns `404` for an unknown terminal or chat, and `400` for a bad or missing parameter.

### Client (`client/outcome-strip.ts`)

- `mountOutcomeStrip(host, source)` returns `{ setSource, destroy }`. It polls every 5 s while the page is visible (the same rhythm as the sidebar and terminal polls), sending `after=last`. It appends new squares, drops the oldest ones past the capacity (`floor(width / 13)`, recomputed on resize) and repaints the totals.
- Terminal: the line becomes the last child of each `.term-host`, and the xterm fits into the remaining height (the host becomes a flex column). Chat: the line sits above `#composer` and follows the open chat (`quiet:chat-open` / `quiet:new-chat`). It hides on the welcome screen.
- One shared tooltip element. The relative time is computed when you hover.
- Pure helpers (capacity, tooltip text, result wording, relative time) are exported and unit-tested.

## Error handling

- A missing or unreadable source is skipped this round and its offset kept, so it is retried next sync. A malformed JSON line is skipped. A partial trailing line is left for the next sync.
- If writing the ledger fails, the server logs it once per session and still returns the in-memory items. The client then shows what it has.
- If the fetch fails, the client keeps the current squares and retries on the next tick. No toast, because the strip is passive.
- If a terminal ends, its ledger stays on disk, and the chat or terminal history can still show it later.

## Testing

- Parsers (`test/outcome-sources.test.ts`), using fixture lines in the style of `session-transcript.test.ts`:
  - Claude Bash pass and fail; edit failure; a result arriving in a later chunk (pending carry-over); sync and async Agent results
  - Codex exit code from the JSON output and from text, and the no-exit-code skip; `apply_patch`
  - Codex job `command_execution`; job settle pass and fail; a workflow check with a timeout
  - redaction applied
- Ledger (`test/outcomes.test.ts`, temp `MISSION_CONTROL_CONFIG_DIR`):
  - appending and reloading keep `seq` and totals
  - dedupe across a simulated crash (outcomes written, state not)
  - a partial trailing line waits for the next sync
  - a truncated file rescans without duplicates
  - a closed job source is not re-read
  - the `after` cursor and `limit`
  - retention prune
- Route (`test/outcomes-routes.test.ts`, the fake-registry style of `terminals-routes.test.ts`): terminal and chat lookups, 404 and 400, the cursor.
- Client helpers: `test/outcome-strip.test.ts`.
- End to end: a throwaway server with `MC_FAKE_ENGINES=1`, a terminal whose transcript fixture grows, and a check that the squares and tooltip appear. Screenshot compared with the mockup.

## Build order

1. Parsers plus tests
2. Ledger and sync plus tests
3. Route plus tests
4. Client strip in the terminal view
5. Chat view
6. End-to-end check against the mockup
