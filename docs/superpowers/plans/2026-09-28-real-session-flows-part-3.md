# Real Session Flows — Part 3 Implementation Plan (parallel paths)

> **For agentic workers:** execute one task at a time, in order, unless the task says it may run beside another. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A flow can split into paths that run at the same time, each in its own git worktree, and meet again at a join step that brings every path's changes back into the run's workspace. A join conflict takes the join's fail edge (normally an implement fix step followed by a review).

**Architecture:** `server/workflows.ts` allows several `pass` edges per step (a fork), a `join` kind and a fork `setup` list, validated through `forkSections()`. `server/workflow-runner.ts` replaces the single current step with tokens. Routing happens in one place, `advance(run)`, which does nothing while the run is paused or a Part 2 change waits. A fork snapshots the parent workspace into a commit that is on no branch, adds one worktree per path from that snapshot, and starts a token in each. A join commits each path on its own internal branch, then applies each path's diff to the parent workspace with `git apply`, recording progress so a crash or retry resumes where it stopped.

**Spec:** `docs/superpowers/specs/2026-09-28-real-session-flows-design.md` ("Parallel paths (part 3)"; Task 5 updates that section to this plan's join mechanism). Conventions: Part 1 and Part 2 plans in this folder.

## Global Constraints

- Part 1 and Part 2 Global Constraints apply (comment rule, no emoji, `bun test`, `bunx tsc -p tsconfig.shell.json` + `bun run typecheck:studio`, one commit per task, no `Co-Authored-By`, never push or merge, restore the skill link after the last test run of a task: `ln -sfn /Users/lynchz/Desktop/kingpinggroup/mission-control/skills/mc-dispatch ~/.claude/skills/mc-dispatch`).
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- **The flow never commits, stages or switches branches in the run's own workspace** (`run.cwd`). Commits happen only inside path worktrees, on `flow-*` branches the runner owns.
- Every git command goes through `git()` from `server/job-worktrees.ts`. Every run mutation goes through the run's `exclusive()` queue; nothing inside the queue waits on an agent or an acceptance check.
- Safety rules hold per path (see Task 2 `covers`/`lineage`).

## Decisions

- **Path ids.** The run's workspace is path `main`. A fork whose attempt number is `k` creates paths `a<k>-1`, `a<k>-2`… in edge order; a nested fork inside path `P` creates `P.a<k>-1`… `lineage(x, y)`: `x === y`, or one starts with the other + `.`, or either is `main`. `covers(r, i)`: `r === i`, `i.startsWith(r + '.')`, or `r === 'main'`.
- **Where path worktrees live:** `<configDir>/workflow-runs/<runId>/<pathId>` (realpath'd). If that is not under the home directory → block `Path worktrees must be under your home directory` (jobs refuse a cwd outside home). If `run.cwd` is a subdirectory of its repo (`git rev-parse --show-prefix` non-empty), the path workspace is `<worktree>/<prefix>`. Branch: `flow-<runId first 8>-<pathId>`, checked with `git check-ref-format --branch`.
- **Fork (snapshot, no commit on the user's branch):** in `run.cwd`'s repo top: `GIT_INDEX_FILE=<tmp> git add -A` (from the repo top), `tree = git write-tree`, `snapshot = git commit-tree <tree> -p HEAD -m "<label>: snapshot before <fork title>"` with the internal identity. Unrelated uncommitted files in the user's checkout are copied into the paths as they are, but nothing is committed or staged in the user's repo. Then per path: `git worktree add -b <branch> <dir> <snapshot>`, then run the fork's `setup` commands in the path workspace (a failure blocks the fork).
- **Internal identity and environment** for every commit the runner makes: `git -c user.name="Mission Control" -c user.email=mission-control@localhost -c commit.gpgsign=false commit --no-verify` (`commit-tree` gets the same `-c` flags plus `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env). `git()` gains an optional timeout (default none; fork and join steps pass 120 000 ms).
- **Join (apply, not commit):** loop 1 commits every path worktree that has changes (`<label>: <path title>`, path title = its first step's title). Loop 2, per path in order, skipping ids already in `section.joined`: `patch = git diff --binary <snapshot> <branch>`; empty → joined with 0 changes; else `git apply --check` in the parent workspace → on success `git apply`, push the path id to `section.joined`, persist; on failure run `git apply --check --reverse` → success means the patch is already in (a crash between apply and persist) → mark joined; otherwise it is a conflict: files = the paths named in the `--check` error lines (`error: patch failed: <file>:<n>` and `error: <file>: does not match index` / `already exists`), stop.
  - All joined → outcome `pass`, summary `Joined <n> paths`, evidence one line per path `<pathId>: <files changed> files`. Worktrees removed, branches deleted, path claims released, section closed, one parent token routed on `pass`.
  - Conflict → outcome `fail`, summary `Paths could not be joined: <files comma-separated>`, evidence `['Joined: <ids or none>', 'Conflicts in <pathId>: <files>', 'Unjoined paths kept on branches: <branches>']`. Worktrees removed; the unjoined paths' branches are kept and recorded in `run.keptBranches`; section closed; the parent token routes on `fail`. No `fail` edge → the run is `blocked` with that summary (spec: blocked with the file list).
  - A non-conflict git error → outcome `blocked` with the git message: nothing is removed, the section stays open with its `waiting` tokens, Retry runs the join again and skips `joined` paths.
- **Checks leave the queue:** `settle` marks the attempt `checking`, persists, leaves `exclusive`, runs the checks in the token's workspace, then re-enters `exclusive` to record them and route. Stop and other paths are never held behind a check.
- **Routing is deferred:** settle records the result and sets the token to `settled`. `advance(run)` routes every `settled` token under the current graph, runs joins whose section is fully `waiting`, and dispatches every `ready` token — and returns without doing anything while the run is not `running`, a later version is pending, or a proposal is arriving. Approve, Keep, propose, resume, retry and recover all end with `advance(run)`. This replaces Part 2's `advance(run, attempt)` and `continueAfterChange()` (rename, do not duplicate).
- **Run end:** `finish()` for `failed`, `blocked` or `stopped` kills every running job and check of the run, marks their attempts settled as interrupted, and sets those tokens back to `ready` at their node. Worktrees, branches, sections and tokens stay so Retry resumes every path. `done` removes any remaining path worktrees; `keptBranches` stay (they hold work a fix step may not have used) and are listed in the run.
- **Crash safety:** the section and each path record are persisted before their `worktree add`; a fork is idempotent (an existing dir or branch for that path id is removed first). `recover()`: an unsettled join attempt → the run is blocked `Join interrupted; Retry resumes it`; open sections' path workspaces are claimed again (`Another run owns <workspace>` blocks); every `working` token is handled like today's single attempt.
- **Joins and dispatch:** a `join` node is never dispatched as a job: `dispatch` blocks `<title> has no open paths to join` if asked to. `join()` checks the node's `maxVisits` and the 256-attempt limit before recording its attempt, with the same block messages as `dispatch`.
- **Part 2 changes:** `guardChange` also refuses removing a node that holds a token (`<title> is in progress and cannot be removed`), and for every open section the new graph must have a section with the same fork, join and path first steps in the same order (`Wait for the parallel paths to join before changing <fork title>`). The guard runs again in `approve` of a later version. In `changeSize`, a new fork (a node with 2+ pass edges that had fewer before) is big.

## Preserve

- A flow with no fork behaves exactly as today: every Part 1 and Part 2 runner, route, run-view and drawer test stays green (only fixture additions for new fields).
- Run files from before this part load: `tokens` defaults to one `main` token at `currentNodeId` (`working` with the last attempt when it is unsettled, `settled` when the last attempt is settled and the run is live and held by a pending change, otherwise `ready`); attempts without `pathId`/`tokenId`/`from` read as `main` / that token / `[number - 1]`.
- `currentNodeId` stays on the record: the first token's node.
- Error texts already asserted (`Only one edge per node outcome is allowed`, `Implementation requires a successfully verified plan`, `Review must use a different model family…`, Part 2's refusal messages) stay the same.

## Review Focus

1. Two paths settle in the same tick: exactly one join runs. (Task 3)
2. A passing review in one path never clears an unreviewed implementation in another path at the review after the join. (Task 2 `covers`; Task 1 validation; Task 3 runtime)
3. Restart with one path working and one waiting at the join: both resume; the join runs once. Restart between two applies: the join resumes and does not apply a path twice. (Task 3)
4. Stop while two paths work: both jobs are killed, the run is `stopped`, both paths' worktrees still exist, and Retry finishes the run `done` with both paths joined. (Task 3)
5. The user's checkout has an unrelated uncommitted file and an untracked file before the run: after a forked run finishes, `git log` on the user's branch has no new commits, `git diff --cached` is empty, and the unrelated file is untouched. (Task 3)

---

### Task 1: Forks and joins in the workflow schema

**Files:** `server/workflows.ts`, `test/workflows.test.ts`, `client/studio-graph.ts`, `client/studio.tsx`

**Produces:**

```ts
// nodeSchema: kind enum gains 'join'; new field setup: z.array(commandSchema).max(10).default([])
export type ForkSection = { fork: string; join: string; paths: string[][] }  // paths[i] = node ids of path i, every step reachable from the path's first step by any edge without passing its join (nested sections included); ordered outermost first
export function forkSections(graph: Workflow): ForkSection[]  // only for a graph that passed validateWorkflow
export function passTargets(graph: Pick<Workflow, 'edges'>, id: string): string[]
```

Validation (literal messages, `<title>` = step title):

- Two `fail` or two `blocked` edges from a step, or two `pass` edges from a step to the same target → `Only one edge per node outcome is allowed`.
- Fork = a step with 2+ `pass` edges. Walking a path along `pass` edges (a nested fork jumps to its own join) must end at a `join`; all paths of one fork at the same join → otherwise `<fork title> paths must meet at one join` (also for a dead end or a revisited step before any join).
- A fork `pass` edge straight to its join → `<fork title> has a path with no steps`.
- A join reached by no fork or by two forks → `<join title> must close exactly one fork`. A join with 2+ pass edges → `<join title> cannot split again; add a step after it`.
- Any edge into a join from a step outside that join's paths → `<join title> can only be reached from its own paths`.
- A step in two paths → `<title> belongs to more than one path`. An edge from one path into another path of the same fork, or into a path from outside it other than the fork's pass edge → `An edge from <source title> crosses into another path`.
- A `fail`/`blocked` edge from a path step to a step outside its own path → `<source title>: loops must stay inside one path`.
- A `join` with `checks`, `skills`, `mcpServers` or `agent.engine` → `<title>: a join runs no agent`. `setup` on a step that is not a fork → `<title>: only a step that splits can have setup commands`.
- The planned/verified/dirty walk follows every pass target; a `join` sets `dirty = true` when any of its paths contains an `implement` step (the combined result needs its own review).

- [ ] **Step 1: Failing tests** in `test/workflows.test.ts` (literal expectations; fixture titles are the ids capitalised):
  1. `plan → verify → split ⇉ [a(implement), b(implement)] → join → review` → `[]`; `forkSections` → `[{ fork: 'split', join: 'join', paths: [['a'], ['b']] }]`.
  2. `b --pass--> review` instead of join → contains `'Split paths must meet at one join'`.
  3. `split --pass--> join` as a third edge → contains `'Split has a path with no steps'`.
  4. An orphan `join2` step → contains `'Join2 must close exactly one fork'`.
  5. `a --fail--> b` → contains `'An edge from A crosses into another path'`; `a --fail--> review` → contains `'A: loops must stay inside one path'`; `a --fail--> fix-a(implement) --pass--> a` → `[]` and `forkSections(...)[0].paths[0]` equals `['a', 'fix-a']`.
  6. `review --fail--> join` → contains `'Join can only be reached from its own paths'`.
  7. Nested: path 1 = `a ⇉ [a1, a2] → join-a → a3`, path 2 = `b` → `[]`; outer section first with `paths: [['a', 'a1', 'a2', 'join-a', 'a3'], ['b']]`, then `{ fork: 'a', join: 'join-a', paths: [['a1'], ['a2']] }`.
  8. Implement paths each followed by their own review, join → finish with no review after → contains `'Join cannot finish successfully without a subsequent review'`.
  9. A join with a check → contains `'Join: a join runs no agent'`; `setup` on `a` → contains `'A: only a step that splits can have setup commands'`.
  10. Two `fail` edges from one step → contains `'Only one edge per node outcome is allowed'`.
- [ ] **Step 2: Run** `bun test test/workflows.test.ts`, see them fail.
- [ ] **Step 3: Implement.** Studio: `kindIcons.join` = the icon id used for merging if one exists in the sprite (`grep -o 'id="[a-z-]*-icon"' server/views/*.ts | sort -u`), else `'spark-icon'`; `purposeLabels.join = 'Join paths'`; `graphEdges` ids `${edge.source}-${edge.outcome}-${edge.target}`; `wire()` for `pass` keeps the step's other pass edges and only replaces one to the same target.
- [ ] **Step 4: Tests + both typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(workflows): a step can split into parallel paths that meet at a join`.

---

### Task 2: Tokens, deferred routing and checks outside the queue (no fork yet)

**Files:** `server/workflow-runner.ts`, `test/workflow-runner.test.ts`

**Produces:**

```ts
export type TokenState = 'ready' | 'working' | 'settled' | 'waiting'
export type WorkflowToken = { id: string; nodeId: string; pathId: string; workspace: string; state: TokenState; attempt: number | null; from: number[] }
// WorkflowAttempt gains tokenId: string; pathId: string; from: number[]
// WorkflowRun gains tokens: WorkflowToken[]; sections: OpenSection[]; keptBranches: string[]
export type OpenSection = { fork: string; join: string; forkAttempt: number; parentPathId: string; parentWorkspace: string; snapshot: string; joined: string[]; paths: { pathId: string; branch: string; dir: string; workspace: string; firstNodeId: string }[] }
export function lineage(a: string, b: string): boolean
export function covers(reviewPath: string, implementPath: string): boolean
```

- `dispatch(run, token)`: attempt carries `tokenId`, `pathId`, `from: token.from`; job `cwd: token.workspace`; `token.state = 'working'`, `token.attempt = n`. Verified-plan check and upstream inputs use attempts in `lineage` with the token's path. Family check: an implement attempt is cleared by a later passing review attempt whose path `covers` it; the step is refused when an uncleared implement attempt in `lineage` with its path shares its family. Visit counts stay per node.
- `settle(run, record)`: attempt = `run.attempts.find(a => a.jobId === record.id)`, token = by `attempt.tokenId`. Checks per Decisions ("Checks leave the queue"), in the token's workspace; `runCheck(run, attempt, cwd)`; `checks` becomes `Map<string, Map<number, () => void>>` (run → attempt → kill). `workspaceSnapshot(token.workspace)`. Then `token.state = 'settled'` and `advance(run)`.
- `advance(run)` per Decisions. Routing a `settled` token (`route`): one target → `nodeId = target`, `state = 'ready'`, `from = [attempt]`; no edge → the run finishes as today (and Part 2's hold still applies: while a change waits, `advance` does nothing, so the token stays `settled`).
- Part 2 code: `continueAfterChange` and the old `advance(run, attempt)` are replaced by the new `advance(run)`; `propose`'s refusal path, `approve`/`reject` of later versions, `resume`, `retry` and `recover` call `advance(run)`. `retry` sets `working` tokens whose job is not running back to `ready` (their attempt marked settled) and re-routes `settled` tokens. No remaining `run.attempts.at(-1)` in the runner except the load migration.
- `stop` kills every running job and check of the run. `finish` per Decisions ("Run end").
- `persist` workspace release: release `run.cwd` when not live and no attempt of the run has a live `checkPid` and no job of the run is running.
- Load migration per Preserve.

- [ ] **Step 1: Failing tests:** (a) finished default run: every attempt `pathId: 'main'`, `tokenId === run.tokens[0].id`, attempt n>0 `from: [n - 1]`; (b) a run file with `tokens`, `sections`, `keptBranches` and the new attempt fields deleted on disk, runner reloaded → one `main` token at `currentNodeId`, and a blocked copy retries to `done`; (c) `lineage('main', 'a3-1.a7-2') === true`, `lineage('a3-1', 'a3-1.a7-2') === true`, `lineage('a3-1', 'a3-2') === false`; `covers('main', 'a3-1') === true`, `covers('a3-1', 'a3-1.a7-1') === true`, `covers('a3-2', 'a3-1') === false`, `covers('a3-1.a7-1', 'a3-1') === false`; (d) a step with a `sleep 2` check: while the check runs, `runner.stop(id)` resolves in under 1 s and the run is `stopped`; (e) all existing Part 1 and Part 2 runner tests unchanged and green.
- [ ] **Step 2: Run, see the new ones fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `test/workflow-runner.test.ts` fully green; both typechecks; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `refactor(runner): runs move by tokens and route in one place`.

---

### Task 3: Forks run in worktrees; joins apply them back

**Files:** `server/job-worktrees.ts`, `server/workflow-runner.ts`, `test/workflow-runner.test.ts`, `test/job-worktrees.test.ts` (create if absent)

**Produces (in `server/job-worktrees.ts`):**

```ts
export async function git(cwd: string, ...args: string[]): Promise<string>  // unchanged signature
export async function gitTimed(cwd: string, timeoutMs: number, args: string[], env?: Record<string, string>): Promise<string>
export async function snapshotCommit(cwd: string, message: string): Promise<string>  // temp index, add -A from repo top, write-tree, commit-tree -p HEAD with the internal identity; never touches the real index or branch
export async function commitPath(cwd: string, message: string): Promise<boolean>  // add -A + internal-identity commit --no-verify; false when nothing changed
export async function addPathWorktree(from: string, dir: string, branch: string, start: string): Promise<void>  // removes an existing dir/branch of that name first
export async function removePathWorktree(from: string, dir: string, branch: string, keepBranch: boolean): Promise<void>  // tolerates missing dir/branch; runs worktree prune
export async function applyPath(parent: string, snapshot: string, branch: string): Promise<{ applied: boolean; files: number; conflicts: string[] }>  // already-applied counts as applied
```

Runner, per Decisions: `fork(run, token, node, attempt)` from `route` when a node has 2+ pass targets and the outcome is `pass`; tokens routed to their section's join become `waiting`; `join(run, section)` from `advance`. `agentsFor`'s family walk follows every pass target (stack of `[nodeId, families]`, visited key `${id}:${[...families].sort().join(',')}`); joins get no agent (`agentsFor`, `changeSize` and `run-view` skip them). Path jobs are created with the run's `cwd` as their project (check `createJob`'s options and `JobRecord` for `baseRepo`/`worktree` fields and use them) so chat home and project memory still see the user's project. Part 2 guard additions from Decisions.

- [ ] **Step 1: Failing tests.** Test repos and `dir` are created under `homedir()` for these tests. Keep the echo resolver; path steps write files through acceptance checks, which run in the token's workspace (`checks: [{ command: '/bin/sh', args: ['-c', 'echo a > a.txt'] }]`). Fixture: `plan → verify → split(task) ⇉ [a(task), b(task)] → join → review(task)`.
  1. With a `sleep 0.5` resolver on `a` and `b`: two `working` tokens with different workspaces under `<dir>/workflow-runs/<runId>/`, two running jobs with those `cwd`s.
  2. Run `done`: `a.txt` and `b.txt` in the user's repo as uncommitted files; `git log --oneline | wc -l` unchanged; `git diff --cached` empty; no `flow-` branch; `git worktree list` shows only the repo.
  3. Both paths settle together → exactly one `join` attempt.
  4. Review Focus 5: the repo has a modified tracked file and an untracked file before the run → after `done` both are byte-identical to before, and the paths saw them (a check in `a` does `test -f <untracked name>`).
  5. Conflict: `a` and `b` write different lines to the same `same.txt`; graph adds `join --fail--> fix(implement, codex-family agent not used for review) --pass--> review`. The join attempt result is `fail` with summary starting `Paths could not be joined: same.txt` and evidence containing `Conflicts in <b's path id>: same.txt`; `run.keptBranches` has b's branch and it exists; the run reaches `fix` then `done`.
  6. Same conflict with no fail edge → run `blocked`, error starts `Paths could not be joined: same.txt`.
  7. Stop while both paths work → `stopped`, no running jobs, both worktrees still exist; `retry` → `done` with both files present.
  8. Restart with `a` waiting at the join and `b` sleeping: reload runner over the same dir, `recover()` → `done`, one join attempt.
  9. Restart between applies: make `applyPath` for the second path throw once (inject by pointing the second path's branch at a missing ref before the join, then restore it), assert `blocked`; restore and `retry` → `done`, each file applied once (content has one line).
  10. Family rule: path 1 `a` = implement (claude), path 2 `r` = review (codex) passing, after the join `review2` (title `Review 2`) = review (claude) → `start` rejects with `Review 2 must use a different model family from implementation`.
  11. `job-worktrees.test.ts`: `snapshotCommit` leaves `git status --porcelain` and `git rev-parse HEAD` unchanged and returns a commit whose tree contains the untracked file; `commitPath` on a clean worktree → `false`; `addPathWorktree` twice with the same name succeeds; `removePathWorktree(…, false)` leaves no worktree and no branch; `applyPath` twice with the same branch → second call `{ applied: true }` with nothing changed.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(runner): parallel paths run in their own worktrees and join back into the workspace`.

---

### Task 4: Everything that reads a run follows tokens

**Files:** `server/run-view.ts`, `client/flow-drawer.ts`, `client/flow-graph.ts`, `client/studio-graph.ts`, `client/studio.tsx`, `server/routes/studio.ts` (run summary), `server/chat-reports.ts`; tests `test/run-view.test.ts`, `test/flow-drawer.test.ts`, `test/flow-graph.test.ts`, `test/chat-reports.test.ts`, and the Studio graph test file (`grep -ln nodeRunStates test/`).

**Produces:** `RunView` gains `tokens: { nodeId: string; pathId: string; state: TokenState; from: number[] }[]`, `sections: { fork: string; join: string; paths: { pathId: string; branch: string; firstNodeId: string }[]; joined: string[] }[]` (open sections) and `keptBranches: string[]`; `RunAttemptView` gains `pathId` and `from`. Join nodes have `engine: ''`.

Rules:
- `unstartedStatus`: a node with a `ready` or `settled` token → `Up next` (`Paused here` when paused); a pass target of a `working` token's node → `Up next`; `currentNodeId` is no longer read.
- A join with `waiting` tokens and no running attempt → `pending`, `Waiting for <k> of <n> paths`, n = that section's `paths.length`. Settled join attempt: `pass` → `Joined <n> paths`; `fail` → `Paths could not be joined`.
- `takenPairs`: when `next.from` is non-empty the pair is taken iff `next.from.includes(previous.number)`, else today's consecutive rule. An edge into a join is `done` when a `waiting` token's `from` holds an attempt of that edge's source with that outcome.
- `layoutRun`: a join's column = max(column of every step with an edge into it) + 1 (second pass after BFS, shifting the join's successors right by the same amount).
- `flow-graph.ts`: join steps draw the existing join glyph (`step.engine === ''`).
- `client/studio-graph.ts` `nodeRunStates` and `client/studio.tsx` running markers: every node with a `working` token is running. Studio's run summary route includes the working node ids.
- `server/chat-reports.ts` `workflowReport`: each attempt line is prefixed with its path id when it is not `main` (`a3-1 · Build API · pass · …`).

- [ ] **Step 1: Failing tests** with a fixture run mid-fork (`a` working in `a3-1`, `b` waiting at `join` from `a3-2`): `stepsFor` → `a` `active`, `join` `Waiting for 1 of 2 paths`, `review` `Waiting`; `edgesFor` → `split→a` `flowing`, `split→b` `done`, `b→join` `done`, `a→join` `idle`; `layoutRun` puts `join` right of both `a` and `b` when path 1 is two steps long; `runView` includes `tokens`, `sections`, `keptBranches`; `nodeRunStates` marks `a` running; `workflowReport` line for `b` starts `a3-2 · `.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typechecks green; full `bun test` once; restore the skill link.**
- [ ] **Step 5: Commit** `feat(flow): the drawer and reports show parallel paths and joins`.

---

### Task 5: Instructions, spec and decision record (may run beside Task 2)

**Files:** `server/chat-profile.ts`, `server/terminals.ts`, `docs/decisions/workflow-studio.md`, `docs/superpowers/specs/2026-09-28-real-session-flows-design.md`, `test/chat-profile.test.ts`, `test/terminals.test.ts`

- Flows section of `CHAT_RULES` and the terminal instructions (one paragraph, after the Part 2 drafting paragraph): `To run steps side by side, give one step several pass edges and close all of them at one step of kind "join" (no agent, checks or skills on a join). Each path works in its own git worktree made from a snapshot of the workspace; give the splitting step "setup" commands if paths need dependencies installed (for example bun install). The join brings every path's changes back into the workspace without committing; a conflict takes the join's fail edge, so give the join a fail edge to an implement fix step followed by a review. Keep fail edges inside their own path.`
- `docs/decisions/workflow-studio.md`, "Execution and policy boundaries": replace `Each node has at most one edge per outcome; this is explicit conditional routing, not parallel fan-out.` with `Each node has at most one fail and one blocked edge. Several pass edges fork parallel paths that must meet at exactly one join step. Each path runs in its own worktree outside the repository, made from a snapshot commit that is on no branch; the join applies each path's diff back to the workspace in path order and never commits on the user's branch. A conflict takes the join's fail edge.`
- Spec "Parallel paths (part 3)": replace the `prepareWorktree()` / `flow/<run-label>-<path-id>` sentence and the cherry-pick sentences with the Decisions above (snapshot, path worktrees under the config dir, `flow-<runId8>-<pathId>` branches, apply with check, conflict → fail edge or blocked with the file list).
- [ ] **Step 1:** assert the phrases `kind "join"`, `its own git worktree`, `"setup" commands`, `Keep fail edges inside their own path` in both instruction tests; see them fail.
- [ ] **Step 2:** add the text; tests green; full `bun test` once; restore the skill link.
- [ ] **Step 3: Commit** `docs(flows): session AIs can split a flow into parallel paths`.

---

### Task 6: Browser check

With the fake engine (`MC_FAKE_ENGINES=1 MC_FAKE_ENGINE_CMD=scripts/fake-pass-engine.sh MC_FAKE_STEP_SECONDS=4`) on a throwaway server on port 7795 (probe first), in a scratch git repo under the home directory with one uncommitted change: start a drafted flow with a two-path fork through `POST /api/studio/runs` with a Bearer token, approve it in the drawer, and confirm: both path steps show `Working` at the same time; the join shows `Waiting for 1 of 2 paths` when one finishes first; the run finishes `Done`; the scratch repo has no new commits and its uncommitted change is intact. Stop the server by PID, restore the skill link, delete the scratch repo.
