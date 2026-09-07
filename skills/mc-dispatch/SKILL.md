---
name: mc-dispatch
description: COCKPIT-FIRST implementation routing. Use for ANY implementation request — create/build/write/fix/add CODE that ships (features, fixes, scripts, pages) — whenever Mission Control is running (curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7777/api/health returns 200 — or 401 on pre-2026-09 builds; both mean UP, anything else means down). NOT for analysis output — scans, audits, reports, docs-vs-reality checks, codebase Q&A go to native Explore/read-only agents (writing the report file does NOT make it implementation); post a plan label to the cockpit for visibility instead. NEVER dispatch a user's meta/routing question as a job prompt — answer it. The session stays orchestrator (plan → post plan → dispatch → review); the labor runs as a cockpit job (engine per GET /api/roles: `execute` for jobs, `review` for cross-review) so the user sees it in the session flow, agents panel, and review queue. Also triggers on "dispatch to glm", "send to codex", "/mc-dispatch". Skip only when the cockpit is not running, or the work is judgment/prod-critical per the dispatch table.
---

# mc-dispatch — cross-engine dispatch via Mission Control

## ARE YOU THE WORKER? (read first)

Cockpit jobs run the same `claude` binary as your interactive sessions, so
they load this CLAUDE.md, this skill, and every hook. If ANY of these hold,
you are the dispatched labor, not the orchestrator:

- `$MC_JOB_ID` is set in your environment
- your prompt says "You are a Mission Control worker job" / "do NOT dispatch"
- you are running headless (`-p` / print mode) inside a repo with a spec-shaped prompt

Then: implement directly in the working tree, never post a plan, never call
`POST /api/jobs`, never invoke this skill again. A worker that re-dispatches
creates a second job on the same tree (happened 2026-09-04, job 43ba1200 →
cfb3ddde) and nothing lands in the parent's diff.

Mission Control (the local cockpit at `http://127.0.0.1:7777`) runs jobs on other
engines: `glm` (GLM-5.3-Flash via z.ai — bulk implementation labor) and `codex`
(Codex CLI — cross-family review / overflow). Dispatching through it (instead of
raw `ccglm`/`codex exec`) gets you: session-flow tracking, live logs, diff-stat
capture, and the review queue.

## Auth

Token lives in `~/.config/mission-control/secrets.json` field `apiToken` (starts
`mct_`). It is LAZY-GENERATED: if the field is absent, fire one throwaway Bearer
request first (`curl -s -o /dev/null -H "Authorization: Bearer probe" http://127.0.0.1:7777/api/flow`)
and re-read the file — never conclude the feature is missing from an absent key. Read it with a scoped jq/python read — NEVER print it:

```sh
MC_TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.config/mission-control/secrets.json'))['apiToken'])")
```

All calls: `-H "Authorization: Bearer $MC_TOKEN"`. Scope covers /api/jobs*,
/api/flow, /api/quota, /api/meta, /api/roles, /api/models only.

## Roles (which engine does what)

The cockpit Settings page maps `plan | execute | review` to engines. READ IT
FIRST — never hardcode glm/codex:

```sh
ROLES=$(curl -s -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/roles)   # {"plan":{"engine":"claude","model":null},"execute":{"engine":"glm","model":null},"review":{"engine":"codex","model":null}}
EXEC_ENGINE=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['execute']['engine'])")
EXEC_MODEL=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['execute']['model'] or '')")
REVIEW_ENGINE=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['review']['engine'])")
REVIEW_MODEL=$(printf '%s' "$ROLES" | python3 -c "import json,sys;print(json.load(sys.stdin)['review']['model'] or '')")
```

Each role also carries an optional `model` (null = engine default). `GET /api/models`
returns the current per-engine model lists (same Bearer token) when you need a valid model id. Pass it on
every dispatch as `"model":"$EXEC_MODEL"` / `"model":"$REVIEW_MODEL"` — an empty
string is ignored server-side, so always include the field. The cockpit turns it
into `claude --model X` or `codex -m X`.

- implementation jobs → `"engine":"$EXEC_ENGINE"` (codex jobs run with full access: no sandbox, no approvals — the user asked for it; keep prompts scoped to the worktree)
- cross-family review jobs → `"engine":"$REVIEW_ENGINE"`
- `plan` is the engine you are driving from (NEW TERMINAL default); nothing to dispatch
- auto-review (Settings → AUTO-REVIEW) is OFF by default: reviews are on demand
  (see "After completion"). When on, a done `execute` job with a diff spawns one
  `review` job (marked `reviewOf`), never a second

## Cockpit-first rule (overrides "trivial = do it myself")

If the cockpit answers on :7777, implementation work is dispatched through it BY
DEFAULT — including small/trivial tasks. Rationale: the user's goal is to see
every piece of AI labor in the cockpit (flow graph, agents panel, review queue);
a 2-minute task done silently in the main session defeats that. Main session =
orchestrator only: plan, post plan, dispatch, monitor, review, mark reviewed.
Trivial task → still post a 2–3 step plan + one glm job. The only exceptions are
the "native agent, NOT here" rows below and pure Q&A/discussion (no code output).
"Visible in the cockpit" for analysis work means a PLAN LABEL, not a glm job —
never downgrade judgment work to glm just to make it show up in the panel.

## When to dispatch vs native agent

| Work | Route |
|---|---|
| Spec'd implementation ticket, mechanical/bulk, tests, docs | `glm` job here |
| Cross-family second-opinion review of a risky diff | `codex` job here |
| Judgment-heavy, house-style-critical, prod-adjacent | native Claude agent (Agent tool), NOT here |
| Scan / audit / report / docs-vs-reality / codebase Q&A (report file included) | native Explore/read-only agent + cockpit plan label, NOT a glm job |
| User's meta/routing/process question | answer it in prose — NEVER a job prompt |

Workers run on a slim profile (glm: `CLAUDE_CONFIG_DIR=~/.config/mission-control/worker-claude`,
codex: `CODEX_HOME=.../worker-codex`): no global CLAUDE.md, agents, skills,
hooks or plugins — measured 91k → ~20k tokens and 12s → 3s per turn. The prompt
is the worker's whole world and MUST open with the line
`You are a Mission Control worker job: implement directly in this tree, do NOT
dispatch, do NOT post plans, do NOT invoke mc-dispatch.` (belt and braces
against the cockpit-first rule if a worker ever runs on the full profile).
Check peak first: `GET /api/quota` → `peak.peak` true means 2× GLM credits
(Mon–Fri 13:00–17:00 Thai); prefer deferring bulk fleets during peak.

## Spec writing (the biggest lever after the profile)

A spec is goal + acceptance + pointers, not a pre-digested implementation:

- 1 line goal, 3–6 acceptance bullets (observable, testable), 2–5 file
  pointers ("start at server/routes/terminals.ts POST handler"), constraints
  (no commit, no restart, comment rule). Under ~60 lines for a small ticket.
- Do NOT pre-read the whole feature to write it — the worker reads anyway; you
  reading 15 files first doubles the cost. Read only what you need to name the
  pointers and the acceptance. Exception: schema/contract changes across many
  modules, where exact types belong in the spec.
- Always include: `While iterating run only the tests for files you touch; run
  the full suite ONCE at the end.` (measured: 55–62 full-suite runs per job
  without it).
- One ticket = one job. Split only along worktree boundaries; never fan out
  4–6 parallel glm jobs on one tree.

## Plan first (makes the cockpit graph real)

Post the plan AS SOON AS it is agreed in discussion — do not wait for dispatch.
A plan-only label immediately appears in the cockpit as a session with pending
steps, so the user watches the plan the moment it exists; re-POST when the
discussion changes it (last-write-wins). Then dispatch when ready.

Post the plan for the ticket — the cockpit renders it as the
session's node graph (one node per step, assignee-colored, live states):

```sh
curl -s -X POST http://127.0.0.1:7777/api/flow/<label>/plan \
  -H "Authorization: Bearer $MC_TOKEN" -H 'content-type: application/json' \
  -d '{"steps":[{"title":"<step>","assignee":"claude|glm|codex|user","status":"pending|active|done"}],"next":"<what happens after>"}'
```

- steps ≤32, non-empty; POST replaces the whole plan (last-write-wins)
- as work progresses, PATCH single steps (0-based):
  `curl -s -X PATCH .../api/flow/<label>/plan/<i> -H "Authorization: Bearer $MC_TOKEN" -H 'content-type: application/json' -d '{"status":"done"}'`
- keep the plan honest: mark your own steps active/done as you do them; the
  dispatched job's live activity feed shows automatically (no action needed)

## Dispatch

```sh
curl -s -X POST http://127.0.0.1:7777/api/jobs \
  -H "Authorization: Bearer $MC_TOKEN" -H 'content-type: application/json' \
  -d '{"engine":"'"$EXEC_ENGINE"'","model":"'"$EXEC_MODEL"'","cwd":"<ABS_PATH_GIT_REPO>","label":"<kebab-ticket-name>","prompt":"<SELF-CONTAINED SPEC>","terminalId":"'"${MC_TERMINAL_ID:-}"'"}'
```

- `cwd` must be a git repo under $HOME (use the task's worktree, not trunk checkout)
- `terminalId`: always pass `$MC_TERMINAL_ID` as shown — set automatically when the
  session runs inside a Mission Control terminal; empty elsewhere (harmless). It ties
  the job to the dispatching terminal so the cockpit's agents panel can scope per-terminal.
- `label` = the ticket name; it becomes the session in the cockpit's flow graph —
  reuse the SAME label for follow-up jobs (codex review of the same ticket) so
  stages chain: IMPLEMENT → CROSS-REVIEW → VERIFY → MERGED
- returns `{id, status:"running", ...}`

## Monitor

```sh
curl -s -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/jobs            # {jobs:[...]} newest first
curl -s -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/jobs/<id>/log   # full log
curl -s -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/flow            # plans + stages + currentActivity per label
curl -s -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/jobs/<id>/activity  # live feed: what the model is doing now
```

Poll `/api/jobs` until the job's `status` is `done`/`failed` (spawn a background
Bash with a sleep loop rather than blocking). `failed` → read the log, fix the
spec, re-dispatch same label.

Time budget — a small ticket (UI tweak, one endpoint, a fix) should finish in
5–10 min on the slim profile:
- at 10 min, read `/api/jobs/<id>/activity`; if it is looping (re-reading the
  same files, re-running the full suite, retrying a failing command), kill it:
  `curl -s -X POST -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/jobs/<id>/kill`
  then re-dispatch with a tighter spec (name the exact file + change).
- 20 min without a diff on a small ticket = wrong spec, not a slow model. Stop
  and rewrite; do not wait it out.

## Talk to a running/finished job (thread continuation)

Every job is a resumable thread (claude/glm via `--resume`, codex via `exec resume`).
To steer or follow up without re-dispatching:

```sh
curl -s -X POST http://127.0.0.1:7777/api/jobs/<id>/reply -H "Authorization: Bearer $MC_TOKEN" \
  -H 'content-type: application/json' -d '{"message":"<follow-up instruction>"}'   # → new chained job, same context
curl -s -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/jobs/<id>/thread   # full ordered transcript: user/thinking/tool(+input,+result)/text/result
```

Use reply for: "also add tests", "you missed X", "explain what you changed" — cheaper than a fresh spec, keeps the agent's context.

## After completion (no review loops)

The old loop — implement → codex review → NO-SHIP → glm reply → review again —
turned 10-minute UI tickets into 2-hour sessions. Replace it with:

1. `done` + non-empty `diffStat` → read the diff yourself (`git diff` in the
   worktree, or the review queue). Run the tests once. This is THE review for
   a small ticket. GLM never self-certifies, but codex is not the default
   certifier either.
2. Cross-family codex review only when the diff touches auth, payments, data
   migrations, prod config, or concurrency — or when the user asks. ONE pass,
   same label, `{"engine":"$REVIEW_ENGINE","model":"$REVIEW_MODEL","prompt":"Review ONLY the diff of <commit|worktree>; read at most the files in it; report bugs, data loss, security, broken behavior only; first line SHIP or NO-SHIP"}`.
3. NO-SHIP findings: act only on real bugs. Worktree noise (database names,
   ports, .env, generated files) and style are not findings. Fix via one
   `/reply` to the implementation job. Do NOT dispatch a second review after
   the fix — verify the fix yourself by reading the reply's diff.
4. Verified good → commit per the repo's rules yourself, then mark it:
   `curl -s -X POST -H "Authorization: Bearer $MC_TOKEN" http://127.0.0.1:7777/api/jobs/<id>/reviewed`
   → flow shows MERGED, review counter drops.
5. Verification proportional to risk: browser/Playwright checks for UI the user
   will click; curl for endpoints; nothing beyond `bun test` for internal
   refactors. Do not spin a throwaway server for a one-line change.

## Failure modes

- Connection refused → cockpit not running: tell the user to `bun run start` in
  mission-control; do NOT fall back to raw ccglm silently.
- 400 "engine environment is not configured" → z.ai token missing in cockpit
  Settings — surface to user.
- 401 → token rotated; re-read secrets.json.
