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
