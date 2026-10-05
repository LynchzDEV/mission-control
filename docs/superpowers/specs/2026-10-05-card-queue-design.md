# Card Queue — a generic work queue in MC, with ClickUp as the first source

Status: design, awaiting review. Hosting is out of scope (decided later).

You line up items (ClickUp cards first). MC works them one at a time, 24/7: plan, review plan, execute, review code, then hands the requester a live preview and asks if it is OK. Replies loop back as fixes until the requester approves. Nothing reaches the remote until a dev clicks Land.

## Generic core vs source plugin

MC core knows "an item from a source, with a requester I can talk to". It never knows what ClickUp is.

| MC core (generic) | ClickUp plugin + per-repo config (specific) |
|---|---|
| Queue: ordered items, one build slot, replies jump the line | Read card → context markdown |
| Run per item in its own worktree, with the picked flow | Post comments with the MC marker; Thai templates |
| Parked state "waiting on requester"; resume on reply | Fetch replies since last seen; download images |
| Reply check approve / change / unclear (prompt text from the source) | Verify ClickUp webhook HMAC |
| Preview supervisor: recipe, port, health probe, proxy | Status mirroring |
| Land gate: rebase, CI, 6-concern report, confirm, push | Repo start recipes + CI commands (config, not code) |
| Webhook door `POST /hooks/:pluginId` → forwards to the plugin | |

### Source contract (plugin methods; host calls plugin, as plugins work today)

```
source.item({ id })                    → { title, url, contextMarkdown }
source.post({ id, kind, text })        → { commentId }          kind: ask | ready | fixed | landed | clarify
source.replies({ id, sinceId })        → { replies: [{ id, author, text, images: [{ name, path }] }], lastId }
source.webhook({ rawBody, headers })   → { itemIds: string[] }  verifies signature; [] when invalid
source.templates()                     → { ask, ready, fixed, landed, clarify, classifyPrompt }
```

Host additions only:
1. `POST /hooks/:pluginId` — its own route class (no `requireLocal`), body size cap, forwards raw body + headers to `source.webhook`, then runs the reply check for returned ids. The rest of MC stays localhost-only (`local-access.ts`, `secrets.ts:52-57` unchanged).
2. Screen host-api permission `queue.add` so a plugin screen can add an item (beside `sessions.startChat`, `client/plugins/host-api.ts`).
3. Images returned by `source.replies` land in the plugin data folder; the host copies them into the item worktree.

A dummy source (in tests) proves the engine before ClickUp plugs in.

## The loop

```
queued ─► plan ─► review plan ─fail─► plan (cap)
              │ blocked with questions
              ▼
        source.post(ask) ─► WAITING INFO ─reply─► queued (front) ─► new run, Q&A appended
              │ pass
              ▼
        execute ─► review code ─fail─► execute (cap)
              │ pass
              ▼
        preview up ─► source.post(ready: link + steps) ─► WAITING REQUESTER
                                                          │ reply (text/images)
                                     ┌─── reply check ◄───┘
                       change request│        │ approve           unclear → source.post(clarify), stay
                                     ▼        ▼
            queued (front) as a fix run      READY TO LAND ─► dev: Review & Land
            (execute ─► review ─► restart preview ─► post(fixed))   ─► rebase, CI, report, push ─► post(landed)
```

One item builds at a time. Parked items do not hold the slot.

## Decisions

1. **Item = Studio run in its own worktree.** Runs edit `cwd` in place today (`workflow-runner.ts:407`); a parked item must keep its changes while the next builds. Reuse `job-worktrees.ts` `prepareWorktree`; the run's `cwd` is the worktree.
2. **Repo comes from the source.** For ClickUp: card → board → `board.folder`.
3. **Flow is picked per item** when queuing; default = the source's last-used flow, else the default flow.
4. **Missing info reuses `blocked`.** Plan instructions: if info is missing, end `MC_RESULT blocked` with each question as an `evidence` item (`workflow-runner.ts:25`). Blocked with questions → `source.post(ask)`, park. Blocked without a result (cap hit) → "Waiting on you". On reply: a new run on the same worktree, original request + Q&A appended. No runner change.
5. **Feedback fixes are new runs.** `/reply` refuses workflow jobs (`routes/jobs.ts:589-592`). Each round = fix run (implement → review) on the same worktree, prompt = request + plan + all prior feedback + this reply + image paths. Cap 3 rounds → "Waiting on you".
6. **Agents never touch the source or git push.** MC writes `<worktree>/.mission-control/context/<source>/item.md` and `feedback-<n>.md` (already git-excluded by `context-files.ts`); agents only read files and return text. MC posts. Biz text can never make an agent post or push.
7. **ClickUp talk is API, not MCP.** The workspace already exhausts its daily MCP pool with normal use. The plugin uses the REST API with the personal token (100/min per token, no daily cap). One serial call lane in the plugin; on 429 wait for the reset header and retry; 3 consecutive failures → "Waiting on you: source unreachable".
8. **MC comments carry a marker** (`— Mission Control`) because the token posts as the user; marked comments are skipped, the user's own unmarked comments count.
9. **Replies: webhook ping, then fetch.** ClickUp `taskCommentPosted` (HMAC SHA-256 in `X-Signature`) only says "item changed"; MC then calls `source.replies(sinceId)`, which also covers threaded replies. Safety net: every 15 min, a reply check on parked items only (concern 6 allows this cadence). `lastSeenId` is saved per item so a reply is never processed twice, including across restarts.
10. **Land is a dev click, never automatic for queue items** (overrides "landing is always automatic" for this pipeline only). Fetch remote trunk → rebase item branch → repo CI → 6-concern report → confirm → fast-forward push. Never merge.

## UI

1. **Queue** — new core screen in the sidebar beside Studio. Rows: drag handle, state pill, title, source badge + link, flow, progress (`Execute 2/4`, `round 1/3`, `asked 2 questions`), preview link, `Review & Land` on ready rows. Row click opens the run in Studio's flow view. Header: `Check replies`. No source-specific logic in the screen.
2. **Review & Land** — the existing review screen with diff, CI result and the 6-concern table; Land / Reject. Ready items also raise a "Waiting on you" item (new attention kind `queue`).
3. **ClickUp board screen** (plugin) — "Add to queue" + flow picker per card, via the `queue.add` permission.

## Phases

**Phase 1 — queue engine + ClickUp source (local, no preview, no push)**
- Queue store `<config>/queue.json` (atomic write like `chat-queue.ts`): items `{ id, source, itemId, title, url, flowId, state, worktree, runIds, lastSeenId, rounds }`, states `queued | building | waiting-info | waiting-requester | ready | landed | failed | removed`. Restart: reload; a `building` item re-attaches through the runner's `recover()`.
- Event-driven scheduler (run settled / item added / reply arrived) + 15-min reply check for parked items.
- Source contract + dummy source in tests; ClickUp plugin implements it (client gains POST; comment, replies, attachment download).
- Decision 4 end to end. Queue screen. `mctl queue add|list|move|check|remove`. Attention kind `queue`.

**Phase 2 — preview and requester loop**
- Preview recipe per repo; supervisor (port, health, max 3 alive, teardown); proxy for `<item>.preview.<domain>`; Cloudflare Tunnel + Access; webhook door.
- `ready` post, reply check, fix runs, `fixed` post.

**Phase 3 — land**
- 6-concern report produced by code (today prose in `skills/mc-dispatch/SKILL.md:268-333`); Land button flow; `landed` post + status mirror.

**Phase 4 — host it** (separate decision).

## Open
- Does a threaded reply fire `taskCommentPosted`? Decision 9 makes it not matter; confirm in phase 2.
- ClickUp status names per board (phase 3). Per-repo CI command for the land gate (`bin/ci` for klangtech api; others TBD).
