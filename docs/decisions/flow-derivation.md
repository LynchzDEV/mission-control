# Session-flow derivation

`GET /api/flow` used to serve a hand-written placeholder map. It now serves `deriveFlow()`
(`server/flow.ts`), a pure function over `{ jobs, terminals, now }` so the mapping is testable
without a live server. The response keeps the existing client contract — `{ source, current,
sessions }` where each session is `{ spec, impl, codex, verify, merged }` and each stage is
`[state, chipText]` — and adds `reviewCount` / `mergedToday`. `source` is now always `"live"`.

## What a session is

A session is one job `label`. Jobs dispatched with an empty label are their own session, keyed by
job id, so nothing silently merges into a shared bucket.

## Stage mapping

| Node | Source signal | States |
| --- | --- | --- |
| SPEC | none | always `done` — see below |
| IMPLEMENT | `claude` / `glm` jobs with that label | `running` → `active` (elapsed from `startedAt`, cwd basename), `done` → `done`, all failed → `error`, no such job → `future` |
| CROSS-REVIEW | `codex` jobs with that label | `running` → `active`, `done` → `done`, failed → `error`, none → `queued` when IMPLEMENT is done, else `future` |
| VERIFY | done jobs with a non-empty `diffStat` | unreviewed → `active` (this is the review-queue item), all reviewed → `done`, no diff → `future` |
| MERGED | `reviewedAt` on every job of the label | all reviewed → `done`, else `future`; chip always carries the count of labels merged today |

Precedence inside a node is running > done > failed, so a retried job does not drag a session
backwards into an error state.

SPEC has no direct signal in the system today — a spec is written before anything is dispatched, so
the existence of any job for the label is the only evidence that the spec stage completed. The node
therefore reports `done` for every derived session and only becomes `active` once a real
spec-tracking source (a session record created before dispatch) exists.

`queued` for CROSS-REVIEW is derived, not invented: a finished implementation with no codex job yet
is a cross-review that is waiting to be dispatched. Job records have no `queued` status of their own.

`current` is the first session with any `active` stage, otherwise the newest session by job start.

`terminals` is part of the `FlowInput` contract because the route owns the terminal registry and the
station lists are built from the same snapshot, but no stage currently reads it — an open pty is not
evidence about any pipeline stage. It stays in the input so adding a terminal-backed SPEC signal is a
one-function change rather than a route/signature change.

## Review lifecycle

`JobRecord` gained `reviewedAt: number | null`, persisted through the same jsonl append path, so a
review survives a manager reload. Records written before this field are normalised to `null` on load.
`POST /api/jobs/:id/reviewed` stamps it (idempotent — a second call returns the existing record). The
review queue, the `DIFFS TO REVIEW` counter in the top bar, and the VERIFY node all exclude reviewed
jobs from the same predicate (`awaitsReview`).

## Session plans (2026-08-28)

A derived stage box says a job is running; it does not say what the orchestrator intended. Any
dispatcher — an API client, a Claude session, a script — can now attach a plan to a session label:

- `POST /api/flow/:label/plan` with `{ steps: [{ title, assignee, status? }], next? }`
- `PATCH /api/flow/:label/plan/:index` with `{ status }`

`assignee` is one of `claude | glm | codex | user`, `status` is `pending | active | done` (default
`pending`). Plans are append-only records in `<configDir>/plans.jsonl`, last-write-wins per label on
load, so a restart keeps them. The store is an optional third argument to `flowRoutes` defaulting to
`createPlanStore()`, so mounting is unchanged.

`GET /api/flow` gains three per-session fields: `plan` (or `null`), `currentActivity` (the live
one-liner from that label's newest running job, else its newest job), and `activityJobId` (the job
whose `/api/jobs/:id/activity` feed the client should follow — the server already knows which job
that is, so the client does not re-derive it).

A label with a plan but no jobs is a session too: `planOnlySession()` supplies an all-`future`
fallback stage template so planning before dispatch is visible in the cockpit.

## Dynamic node graph

The five fixed nodes are no longer the whole story. When a session has a plan, the client builds one
node per plan step — title from the step, chip in the assignee's engine accent, node state from the
step status (`pending → future`, `active → active` and pulsing, `done → done`) — spaced evenly across
the flow band, wrapping to a second row past six steps (never more than two rows; a longer plan
splits evenly). Edges are drawn sequentially between consecutive step nodes with the same
node-rect mechanism the template uses, and `plan.next` renders as a trailing `NEXT →` label.

The five template nodes stay server-rendered in `lanes.tsx` and carry a `tpl` class; `.flow.planned`
hides them whenever a plan is present. That keeps the fallback path (jobs, no plan) purely
server-rendered and unchanged, and confines the dynamic path to `#plan-nodes`.

Node building is pure: `client/plan-view.ts` turns a plan into node specs (`id`, `className`,
`left`, `top`, `title`, chip) and a session's stages into template specs; `client/flow.ts` only
materialises specs into elements. This project has no DOM library in its test environment, so that
split is what makes "a 3-step plan renders 3 step nodes in the right states" unit-testable.

## Plan / activity panel

Below the graph, a two-column panel shows the numbered plan (status glyph, assignee chip, strike on
done, `NEXT →` line) and a live activity ticker for the selected session, newest first, at most 12
rows. The ticker polls `/api/jobs/:id/activity` every 3s and stops as soon as that job reports a
status other than `running`. Each column collapses when it has nothing to show, and the panel itself
collapses when both are empty — no empty boxes.

The flow poll re-renders the graph only when the graph *shape* changes (stages, plan, job id).
`currentActivity` changes every couple of seconds while a job runs, and keying the re-render on it
would restage the node entrance animation on every tick.
