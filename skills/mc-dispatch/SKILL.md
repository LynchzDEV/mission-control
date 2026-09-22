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

The worker executes; the orchestrator decides. Every design choice the ticket
involves is made in the main session, from reading the code, before dispatch.
The job log (2026-09-14, 494 jobs) shows what leaving them open costs: nearly
every fix-loop reply was a decision the worker made alone — subset vs exact
header match, a return shape that had to be preserved, sliding vs fixed rate
window, a spec asserting against the constant it tests — at 50–400 worker
turns plus a review round each.

A spec is a numbered execution plan. Its parts, in this order:

1. Header: `You are a Mission Control worker job: implement directly in this
   tree, do NOT dispatch, do NOT post plans, do NOT invoke mc-dispatch. Execute
   the steps below exactly; do not redesign. If a step cannot be done as
   written, stop and report which one.`
2. Repo, stack, base branch, ClickUp id.
3. **Decisions** — every choice the ticket involves, each written as the chosen
   answer: `Recall rule: remembered header set ⊆ file header set.` A spec
   containing "or", "either", "as appropriate", "if it makes sense",
   "whichever fits" is not ready.
4. **Preserve** — each existing behaviour the diff touches, with its source:
   `unrecognised slot → { value: nil, tag: "unknown" } (leads_helper.rb:41)`.
5. **Steps** — numbered, one file per step: exact path, exact
   method/function/type signature, exact commit message. Literal values
   (constants, strings, Thai text, SQL, config keys) are copied into the step.
   Prose is only for what the worker derives mechanically from a file you name.
6. **Tests** — spec file path plus each example name with its literal expected
   value. Expected values are never computed from the constant under test.
7. **Constraints** — no commit / no push / no restart as applicable; the two
   comment-rule lines verbatim; `While iterating run only the tests for files
   you touch; run the full suite ONCE at the end.` (measured: 55–62 full-suite
   runs per job without it).
8. The acceptance baseline block below, verbatim.

Writing 3–6 means reading the code the steps touch. That is the cost, and it
is smaller than the review-fix loop it replaces. Contract or type changes that
cross modules: every exact type goes in the spec.

### Pre-dispatch gate

Check the finished spec against this list before `POST /api/jobs`. A miss
means edit the spec, not dispatch. The cockpit enforces the section, hedge
and file-path checks itself: a prompt for the execute engine that fails them
gets a 422 with the miss list, and no job is created.

- [ ] every step names a file path and a signature
- [ ] zero "or" / "either" / "as appropriate" in Decisions and Steps
- [ ] every existing behaviour the diff will touch appears under Preserve
- [ ] a new validation, constraint or required association lists EVERY
      creation site it breaks (grep the factories, specs and services that
      build the record) as tasks — "about ten files" on 2026-09-14 was 28,
      and the gap became an 84-minute job
- [ ] every test example has a literal expected value
- [ ] every step under `db/migrate/`, `config/credentials*`, or a deploy
      file was checked against global + project CLAUDE.md; a migration step
      changes schema only, data moves are a rake task with a spec
- [ ] at most 8 steps inline; a longer plan lives in
      `docs/superpowers/plans/*.md` in the tree and the spec says
      "execute tasks N..M of <file> in order"

### One task = one job (one employee, one deliverable)

A worker is one employee with one deliverable: one plan task, one commit,
then stop. Never hand a worker the whole plan. A single 8-task job on
2026-09-14 ran 84 minutes and 607 turns, most of it improvising around a
sibling repo that moved underneath it; at turn 30 a worker is sharp, at turn
600 it is writing throwaway scripts in /tmp.

**Fan out first, chain only what must chain.** One long `o---o---o` is the
slowest shape that works and it is the one you reach for by reflex. Before
dispatching, walk the plan and write the dependency next to each task — the
file it edits, the symbol it needs to already exist. Tasks with no arrow into
them start NOW, in parallel:

```
o---o---o        reflex: 3 sequential jobs, 3x the wall clock
o---o            what to dispatch instead: two chains plus a loner, all
o---o            starting at once, landing in order by cherry-pick
o
```

- **Independent tasks fan out** into separate worktrees under separate labels,
  dispatched in the same breath, landed in order by cherry-pick. That is where
  unlimited headcount pays; never two jobs on one tree at once.
- **Dependent tasks chain** in one worktree under one label, through the plan
  runner below. Each job starts with fresh context; a failure re-runs one
  task, not the plan. A chain needs a named dependency — "it feels sequential"
  is not one, and neither is "they touch the same repo".
- **Cross-repo dependencies serialize.** A chain that depends on another
  repo's change (army on core, api on core) does not start until that change
  has landed; its first task pins to the landed SHA. Both chains running at
  once is what stranded the 84-minute job.
- A single-task ticket is still one `POST /api/jobs`.

### Acceptance baseline — paste into EVERY worker prompt (claude, glm, codex)

Workers run on the slim profile, so the prompt is their only contract. Every
spec ends with these lines verbatim, after the ticket-specific acceptance
bullets (2026-09-08, user-mandated; scoped 2026-09-09 so the full suite runs
once per landed change, not once per worker iteration; concern 4 added
2026-09-14; concern 5 added 2026-09-22):

```
Done means all of these hold, verified by you before you report:
1. Every spec for a file you touched, plus every spec that references a class or module you changed, passes locally. Run those specs while iterating and once more at the end. Do NOT run the full suite or bin/ci: the orchestrator runs it once at landing.
2. Those runs have no hard or forced waits (no sleep, no fixed wait_for/timeout padding) and are clean: zero warnings, zero error logs, zero deprecation output.
3. Nothing on the remote is lost and the code stays compatible: fetch and rebase onto the latest remote tip before you finish, never force-push or drop commits, and keep existing callers, data and already-applied migrations working.
4. The engine HAS TO spin up on its own: `spec/dummy` boots and its specs run with no host, no sibling engine and no host table; you added no dependency that is not necessary, and any that is enters through a settings adapter, never a direct constant.
5. Migrations track schema changes and nothing else: create every new migration with `bin/rails g migration` so it carries a real wall-clock timestamp, never rename or re-timestamp one that is committed or already applied anywhere, and never add, update or delete data inside one — a data move is its own rake task with a spec.
Report the exact spec command you ran and its summary line as evidence for 1 and 2, the dummy boot command for 4, and the generator command plus resulting filename for any migration you added for 5.
```

A job that reports done without that evidence is not done: reply to it
(`/reply`) asking for it before review.

**Landing gate (orchestrator, not the worker):** after `POST /api/jobs/<id>/land`
cherry-picks onto the base branch, run `bin/ci` (or the repo's full test
command) ONCE on the base branch before any push. One full run per landed
change, serialized, never concurrently across worktrees — several full rspec
runs against the shared test DB are what produced the
`PG::TRDeadlockDetected` failures on 2026-09-03. A failure here is a NO-SHIP:
fix via `/reply` to the job, re-land, re-run.

**Autonomous push conditions (default in the project's acceptance checklist):**
when the user sets a session-scoped finish-and-push condition ("push to tip
of remote once done"), default to including the project's own documented
acceptance gate rather than waiting for them to append it — e.g. klangtech
sessions have a standing `four-concerns-checklist` project memory (the worker
contract's 4 acceptance lines) that is easy to forget in the condition's
phrasing. Check for a matching project memory before treating "done" as
"tests pass". [daily-retro 2026-09-21 E09 — the same gap recurred
2026-09-15, 2026-09-18, and 2026-09-21]

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

### Plan review before task 1 (codex, ~2 min)

Of the 8 correction commits on 2026-09-14, 5 were design gaps a reader of the
plan could name before any code existed: a race inside a transaction, a destroy
with no cascade rule, a direct write that bypassed the parent's validation, a
uniqueness collision in a backfill, a dry run that reported work it would skip.
So the plan gets the adversarial pass, not only the diff:

`{"engine":"$REVIEW_ENGINE","prompt":"Read <spec> and <plan> only. For each task list what breaks: concurrency, deletion/cascade, writes that bypass a validation, uniqueness collisions, dry-run vs real accounting, callers not in Preserve. Findings only, one line each; first line SHIP or NO-SHIP."}`

Every finding becomes a Decision, a Preserve line, or a task BEFORE the run
starts. Show the user the Decisions list at this point; a five-minute read of
twenty decisions is where "data in a migration" gets caught, not commit 12.

### Multi-task plan → the plan runner (default)

```sh
curl -s -X POST "http://127.0.0.1:7777/api/flow/<label>/run" \
  -H "Authorization: Bearer $MC_TOKEN" -H 'content-type: application/json' \
  -d '{"engine":"'"$EXEC_ENGINE"'","model":"'"$EXEC_MODEL"'","cwd":"<ABS_PATH_GIT_REPO>","terminalId":"'"${MC_TERMINAL_ID:-}"'",
       "preamble":"<header + repo line + Decisions + Preserve + Constraints + acceptance baseline>",
       "tasks":[{"title":"<task 1 title>","prompt":"<task 1 step body with exact path, signature, code, commit message>"}, ...]}'
```

- The server composes one prompt per task (preamble + `### Step N of M — title`
  + body + "one commit, then stop"), lints every task up front (422 with
  misses), and dispatches task 1 in `.worktree/<label>`. Each settle checks the
  worktree HEAD: new commit → next task, same worktree, fresh context; no
  commit or non-zero exit → run `failed`, remaining tasks stay `pending`.
- The task list becomes the label's plan, so the flow graph shows one step
  per task moving pending → active → done on its own; do not also POST a plan.
- `GET .../run` reads state (`tasks[].status`, `commit`, `error`);
  `POST .../run/stop` kills the current job and halts. 409 if a run is
  already running for the label.
- Task prompts are Steps bodies only; Decisions, Preserve and the baseline
  live once in the preamble. Put "re-pin <dep repo> to <SHA>" as task 1 when
  the chain depends on another repo's landed change.

### Single task → one job

```sh
curl -s -X POST http://127.0.0.1:7777/api/jobs \
  -H "Authorization: Bearer $MC_TOKEN" -H 'content-type: application/json' \
  -d '{"engine":"'"$EXEC_ENGINE"'","model":"'"$EXEC_MODEL"'","cwd":"<ABS_PATH_GIT_REPO>","worktree":true,"label":"<kebab-ticket-name>","prompt":"<SELF-CONTAINED SPEC>","terminalId":"'"${MC_TERMINAL_ID:-}"'"}'
```

- `cwd` is the repo root under $HOME; the cockpit makes `.worktree/<label>` itself; land with `POST /api/jobs/<id>/land` after review (cherry-pick, never merge).
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

0. Review happens on the WORKTREE, before `land`. Landing first and reviewing
   after turned a 9-task feature into 17 commits on local main (8 of them
   corrections) that the owner could not review, and the day ended with a
   rebuild onto a fresh worktree. Order: worker done → review → fix on the
   worktree → land once, clean.
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
   **Fixes fold into the task they correct, never on top.** The worktree's
   history is private until `land`, so the fix reply says: `git commit
   --fixup <sha of the task commit>`; before landing run `GIT_SEQUENCE_EDITOR=:
   git rebase -i --autosquash <base>` on the worktree. The landed history then
   has exactly one commit per task however many review rounds ran. Migration
   files keep their filename and timestamp through the squash.
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
- `PG::DuplicateTable` / "already exists" on a worker's `db:migrate` inside a
  worktree → do not treat it as a code bug first. The dev DB is shared across
  worktrees/sessions (same root cause as klangtech-worktree-up's 2026-07-17
  "shared dev DB schema.rb pollution" guardrail — this cockpit path spawns its
  own worktrees and does not route through that skill). Run `git worktree
  list`, check whether another worktree/session already applied a migration
  creating the same table, and resolve which branch owns it before re-running
  or rolling back. [daily-retro 2026-09-14 E10]
- Codex review job fails repeatedly with `"The '<model>' model requires a
  newer version of Codex. Please upgrade..."` (e.g. gpt-6-astra) → this is a
  PATH problem, not a model problem: the cockpit resolved an outdated `codex`
  binary (a `brew`/`nvm` install) ahead of the mise-managed one that actually
  supports the model. Do not retry the identical dispatch. Run `which -a
  codex` and compare every match's `codex --version` against the mise
  install (`~/.local/share/mise/installs/node/*/bin/codex` or the active mise
  shim) — the cockpit's own PATH/fallback-dir order needs the mise-managed
  binary to resolve first. Fix the PATH/symlink once, then re-dispatch.
  [daily-retro 2026-09-21 E03 — 4 identical failures in one session before
  this was isolated]
