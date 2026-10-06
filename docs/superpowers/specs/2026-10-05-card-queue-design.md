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

## Multi-repo items (added 2026-10-06)

"Build in" may be a single repo (unchanged) or a folder under $HOME whose direct children are repos (e.g. `~/klangtech/{api,backoffice,...}`). For a folder, the plan picks the repos it needs by default (`repos: []`); ticking them (up to 8) is an optional override ("Pick them yourself" in the dialog, `--repos` in the CLI).

- The run request lists the real repos at `<folder>/<name>` as READ-ONLY (read and plan only) and says work happens only in `<workspace>/<name>`. To get a copy the agent ends the step `MC_RESULT blocked` with one evidence item `repo: <name>` per repo; other evidence items stay questions.
- A blocked run with repo requests: each name is checked like an add (plus the build-time checks), added to `repos` and its worktree made. Repo requests only → back to the front of the queue for a new run on the same workspace, nothing posted. With questions too → repos added and the questions posted/parked as before. An unknown name, asking only for repos it already has, a 4th repo-only rerun, or more than 8 repos fails the item with a plain reason. `repo:` lines never reach the source.
- Asks are read leniently (any case, backticks, quotes, bullets, `repo: a, b`). A single-repo item that only asks for repos fails with a plain reason. A folder that can no longer be listed, or has no repos left, fails the item before a run starts.
- Real repos are read-only by instruction. Each run fingerprints them (HEAD + `git status`) at start and settle; a change does not fail the item (the user may be working there) but is recorded on the item, shown on its row and raised as an alert.
- An empty `repos.json` only marks a workspace that a queue item owns (its stored worktree); the item's workspace is stored before its run starts.

- `GET /api/queue/folder?path=` → `{ path, isRepo, repos }`. A child counts only if it is a real directory (symlinks refused), does not start with a dot, and is its own git top level.
- `POST /api/queue` takes optional `repos: string[]` (may be empty); a folder of repos without `repos` is stored with `repos: []`. Names are re-checked against the listing at add time. Item keeps `repo` = folder and gains `repos`; old `queue.json` loads unchanged.
- One workspace per item: `<folder>/.worktree/<branch>/` with one git worktree per ticked repo at `<workspace>/<repo>`, all on the item's branch. The run's cwd is the workspace root, so the agent sees the repos side by side. `.mission-control/repos.json` (0600) marks the folder as a workspace; queue context and answers sit at the root, outside every child repo.
- Restore recreates only missing child worktrees. Remove keeps worktrees and branches, as single-repo removal does.
- A job's diff stat and a step's workspace fingerprint are the union over child repos, paths prefixed `repo/…`, unchanged repos left out. The Git tree view does not draw per-repo lanes for multi-repo items yet.
- Parallel paths (fork/join) work in a multi-repo workspace, mirroring single-repo paths per repo:
  - MC_SHAPE files are repo-prefixed (`api/app/x.rb`, `web/src`); the prefix must be a repo of the folder, the "no file in two paths" rule applies to the prefixed paths, and the planner is told so. A path naming a repo with no copy yet gets the copy before the fork (cap 8); the queue item picks the new repo up when the run settles.
  - Fork: each path gets `<folder>/.worktree/flow-<run>-<path>/` holding one worktree per repo of the workspace, each on branch `flow-<run>-<path>` from a snapshot of that repo's copy (same snapshot commit as single-repo, uncommitted files included). The same link/realpath/repo re-checks apply, and the folder gets a repos record so its jobs, diff stat and fingerprint work.
  - Join: per path, every repo is first checked (`git apply --check`), then the path's work is applied to the run's copy of each repo as a patch (no merge, as single-repo), so a path joins all its repos or none. Repos a path did not touch apply nothing. A conflict blocks (or fails to the fix step) with repo-prefixed files.
  - Cleanup removes each path's worktrees and folder, keeping branches only for unjoined paths, as single-repo. A path folder deleted by hand is recreated (from its branch, or from the fork snapshot, never the base HEAD) only while the path has finished no step; after that its work is gone and the run blocks saying so. Repo folders inside a path folder must be plain directories; links are refused and never force-removed. Repos a run records in its workspace are adopted by the queue item only if they pass the folder listing rules and the 8-repo cap.
- Add: Queue screen → Add item → Build in `~/klangtech` (optionally "Pick them yourself"); or `mctl queue add <source> <id> --repo ~/klangtech [--repos api,backoffice]`.

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
- Multi-repo items: land acts per changed repo (a repo with no commits or changes vs its trunk is skipped). Rebase each onto its own remote trunk and push it; one 6-concern report for the item with a section per repo. A failed push does not undo the others: record a per-repo outcome (pushed / failed + why) and let a retry act on the failed repos only.
- Known gap (L4): a single-repo job's diff stat (`git diff --stat HEAD`) ignores new untracked files, so a job that only adds files skips auto-review; multi-repo stats list them. Align both before land relies on "changed".
- Known gap (L6): files an agent writes at a multi-repo workspace root, outside every child repo, are in no diff, fingerprint or commit; land must surface or refuse them.

**Phase 4 — host it** (separate decision).

## Open
- Does a threaded reply fire `taskCommentPosted`? Decision 9 makes it not matter; confirm in phase 2.
- ClickUp status names per board (phase 3). Per-repo CI command for the land gate (`bin/ci` for klangtech api; others TBD).
