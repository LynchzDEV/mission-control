# Card Queue 1c — Queue Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People see and drive the queue in the cockpit: a Queue screen (List and Git tree), the queue nested under its source plugin in the sidebar, an Add item dialog, and "Waiting on you" alerts for items that need a person.

**Architecture:** Server adds a `queue` attention kind wired to the engine's `needsYou`, and a read-only `GET /api/queue/tree` that reads git for started items. Client adds a `queue` screen (`client/queue.ts` + `client/queue-tree.ts`) fed by `/api/queue/stream`, and the sidebar renders each source plugin's items under its row. Visual language is copied 1:1 from the approved mockup.

**Tech Stack:** Bun, TypeScript, Elysia, vanilla DOM client modules built on request by `server/index.ts`, JSDOM for DOM tests, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-05-card-queue-design.md` (UI section) + approved mockup decision `/Users/lynchz/Desktop/kingpinggroup/visualizer/queue/DECISION.md`. Depends on plan 1a (`server/queue-*.ts`, `/api/queue*`).

**Visual source of truth:** `/Users/lynchz/Desktop/kingpinggroup/visualizer/queue/` — `d.html` (sidebar), `queue.html` (List, Row open, Empty, Add item states), `queue-tree.html` (Git tree), `q.css` (every `q-*` class), `build.py` (the markup generators: `queue_rows`, `row`, `summary`, `tree_view`, `sidebar_d`, `add_dialog` — read the function that produced a state before building it). Render a mockup page and the real screen side by side before claiming a task done.

## Global Constraints

- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- Commits on `main`, one per task, conventional format. No `Co-Authored-By`. Never `git merge`. Do not push. Stage only the task's files; never `skills/mc-dispatch/SKILL.md`.
- Never kill or restart the cockpit on :7777; never `pkill`.
- Colors and type only from `public/quiet.css` tokens (`--paper`, `--card`, `--field`, `--line`, `--text`, `--text-strong`, `--muted`, `--accent`, `--purple-bg/ink`, `--green-bg/ink`, `--red-bg/ink`, `--danger`, `--raised`, `--inset`); both themes must read correctly. No emoji; icons are inline SVG `<use href="#…">` symbols already in `server/views/shell.ts`, or new `<symbol>`s added there.
- Copy from the user's side: "Queue", "Check replies", "Add item", "Requeue", "Remove", "Open run", "Not started". No ClickUp-specific words in host code (the source badge shows the plugin's name and icon).
- Every new client module is added to `tsconfig.shell.json` `include`; `bunx tsc -p tsconfig.shell.json --noEmit` stays clean.
- Board-card "Add to queue" and the flow picker on cards are out of scope (isolated plugin screens have no host bridge for it yet); items are added from the Queue screen's Add item dialog or `mctl queue add`.

## Review Focus

1. An empty queue must show a designed empty state that says how to add the first item, never a blank canvas — Task 3 test "empty queue shows how to add an item".
2. A queue item whose source plugin was uninstalled must still render (generic badge, no icon) — Task 3 test "an item from an unknown source still renders".
3. `GET /api/queue/tree` when an item's worktree folder was deleted by hand must not 500 — Task 2 test "a missing worktree becomes an empty lane".
4. Drag reordering must only move queued items and only among queued positions — Task 3 test "only queued rows are draggable".
5. A queue attention alert must clear once its item is requeued, building or removed — Task 1 test "queue alerts clear when the item moves on".

---

### Task 1: `queue` attention kind

**Files:**
- Modify: `server/attention.ts`, `server/index.ts`, `client/attention-core.ts`, `client/attention.ts`
- Test: `test/attention.test.ts`, `test/attention-dom.test.ts`, `test/attention-core.test.ts` (extend each)

**Interfaces:**
- Produces: `AttentionKind` gains `'queue'`; `attentionKey.queue(itemId: string) => \`queue:${itemId}\``; `prune` keeps `queue` items like `needs`; client renders a queue item with an "Open queue" pill whose click dispatches `new CustomEvent('quiet:show', { detail: 'queue' })`.

- [ ] **Step 1: Failing tests**
  - `test/attention.test.ts`: "prune keeps queue items without a job" — raise `{ key: attentionKey.queue('i1'), kind: 'queue', title: 'Login copy', detail: 'Built and ready for review', command: null, chatId: null, jobId: null, requestId: null }`, `prune(() => false)`, still listed. "an unknown kind on disk is dropped" stays as is.
  - `test/attention-core.test.ts`: the system notification for a queue item has `actions: []` and body = detail.
  - `test/attention-dom.test.ts`: a queue item renders an "Open queue" button; clicking it dispatches `quiet:show` with detail `queue` (listen on `window`).
  - New `test/queue-attention.test.ts` for the index wiring helper below: "queue alerts clear when the item moves on" — with a real `createQueueStore` + `createAttentionStore` in temp dirs, `raiseQueueAlert(attention, item, 'Built and ready for review')` raises; `watchQueueAlerts(store, attention)`; then `store.update(item.id, { state: 'building' })` → alert gone; raise again on a `failed` item, `store.remove(id)` → gone; an item that stays `ready` keeps its alert.
- [ ] **Step 2: Run, see failures** — `bun test test/attention.test.ts test/attention-core.test.ts test/attention-dom.test.ts test/queue-attention.test.ts`
- [ ] **Step 3: Implement**
  - `server/attention.ts`: add `'queue'` to `AttentionKind` and `KINDS`; `attentionKey.queue = (itemId: string) => \`queue:${itemId}\``; prune keeps `item.kind === 'needs' || item.kind === 'queue' || …`.
  - New `server/queue-attention.ts`:
    ```ts
    import { attentionKey, type AttentionStore } from './attention'
    import type { QueueItem, QueueStore } from './queue-store'

    const NEEDS_PERSON = new Set<QueueItem['state']>(['ready', 'failed', 'waiting-info'])

    export function raiseQueueAlert(attention: AttentionStore, item: QueueItem, reason: string): Promise<void> {
      return attention.raise({ key: attentionKey.queue(item.id), kind: 'queue', title: item.title, detail: reason, command: null, chatId: null, jobId: null, requestId: null })
    }

    export function watchQueueAlerts(store: QueueStore, attention: AttentionStore): () => void {
      return store.subscribe(() => {
        void attention.resolveWhere(alert => {
          if (alert.kind !== 'queue') return false
          const item = store.get(alert.key.slice('queue:'.length))
          return item === undefined || !NEEDS_PERSON.has(item.state)
        })
      })
    }
    ```
  - `server/index.ts`: replace the 1a `needsYou: (item, reason) => console.warn(...)` (and its `ponytail:` comment) with `needsYou: (item, reason) => { void raiseQueueAlert(attention, item, reason).catch(error => console.error('Queue alert failed', error)) }` and call `watchQueueAlerts(queueStore, attention)` right after creating the engine.
  - `client/attention-core.ts`: `ACTIONS.queue = []`.
  - `client/attention.ts`: `ICONS.queue = 'flow-icon'` (check the symbol exists in `server/views/shell.ts`; use `auto-icon` if not); in `actions(item)` add a branch before the final `else`: `else if (item.kind === 'queue') row.append(node('span', 'sp'), button('Open queue', 'open-queue', 'pill', item.key))`; in the click handler where `action === 'open'` is handled, add `if (action === 'open-queue') { dispatchEvent(new CustomEvent('quiet:show', { detail: 'queue' })); return }` (find the handler with `grep -n "action === 'open'" client/attention.ts`).
- [ ] **Step 4: Run, see passes**, plus `bunx tsc -p tsconfig.shell.json --noEmit`.
- [ ] **Step 5: Commit** — `feat(queue): items that need a person show in Waiting on you`

---

### Task 2: `GET /api/queue/tree`

**Files:**
- Create: `server/queue-tree.ts`
- Modify: `server/routes/queue.ts` (add the route; `queueRoutes` gains an optional third argument `tree: () => Promise<QueueTree>`), `server/index.ts` (pass `() => queueTree(queueStore.list())`)
- Test: `test/queue-tree.test.ts`, `test/queue-routes.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export type TreeCommit = { sha: string; subject: string }
  export type TreeLane = { itemId: string; branch: string; worktree: string; forkSha: string | null; commits: TreeCommit[] }
  export type TreeRepo = { repo: string; base: { branch: string; commits: TreeCommit[] }; lanes: TreeLane[] }
  export type QueueTree = { repos: TreeRepo[] }
  export async function queueTree(items: QueueItem[], git?: (cwd: string, ...args: string[]) => Promise<string>): Promise<QueueTree>
  export const BASE_COMMITS = 8
  ```
- Behavior: group items that have a `worktree` by `repo`. Per repo: `branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')`; base commits `git(repo, 'log', '-n', String(BASE_COMMITS), '--format=%h%x09%s', branch)`. Per item: lane branch `git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')`; `forkSha = git(worktree, 'merge-base', '--', branch, 'HEAD')` shortened to 7 chars; commits `git(worktree, 'log', '--format=%h%x09%s', \`${branch}..HEAD\`)`. Any git failure for one lane yields `{ …, branch: basename(worktree), forkSha: null, commits: [] }`; a failure for the repo yields `base: { branch: '', commits: [] }`. Items without a worktree are not lanes (the client lists them as "Not started"). Parse lines on the first tab.
- Route: `GET /api/queue/tree` → `QueueTree`.

- [ ] **Step 1: Failing tests** — `test/queue-tree.test.ts` builds a real temp repo (`git init -b main`, two commits, `git worktree add .worktree/queue-a -b queue-a`, one commit in the worktree) and asserts: base branch `main` with 2 commits newest first; lane `queue-a` with 1 commit and `forkSha` equal to main's head short sha; "a missing worktree becomes an empty lane" (an item whose `worktree` path does not exist → `commits: []`, `forkSha: null`, no throw); "items without a worktree are not lanes". Use `Bun.spawnSync(['git', …], { cwd })` for setup, with `-c user.email=t@t -c user.name=t` on commits. Route test: `GET /api/queue/tree` returns what the injected `tree()` returns.
- [ ] **Step 2: Run, see failures** — `bun test test/queue-tree.test.ts test/queue-routes.test.ts`
- [ ] **Step 3: Implement** using `git` from `server/job-worktrees.ts` as the default `git` argument.
- [ ] **Step 4: Run, see passes**
- [ ] **Step 5: Commit** — `feat(queue): git tree of queue branches for the Queue screen`

---

### Task 3: Queue screen — List, Add item, actions

**Files:**
- Create: `client/queue.ts`
- Modify: `server/views/shell.ts` (add `<section id="queue" class="studio" aria-label="Queue" hidden></section>` beside `#marketplace`; add `<script src="/js/queue.js" type="module" defer></script>` beside `/js/plugins.js`), `client/shell.ts` (`screens` gains `'queue'`; `layoutOf` maps `queue` to `studio`), `public/quiet.css` (append the `q-*` rules the screen uses, copied from the mockup's `q.css` — only rules for elements this task renders), `tsconfig.shell.json`
- Test: `test/queue-dom.test.ts` (JSDOM, same setup style as `test/attention-dom.test.ts`, with a `FakeSource` for `EventSource` and a stubbed `fetch`)

**Interfaces:**
- Consumes: `/api/queue`, `/api/queue/stream` (`{ items }`), `/api/queue/check`, `/api/queue/:id/move|requeue`, `DELETE /api/queue/:id`, `POST /api/queue`, `/api/plugins` (names + icons for source badges, enabled plugins for the Add item source select), `/api/studio/workflows` (flow names for the select and the row's flow label), `readRecentDirectories` from `client/shell-launch.ts`.
- Produces: `quiet:show` with detail `queue` shows the screen; `quiet:queue-focus` (detail item id) scrolls to and briefly outlines that row; `client/queue.ts` exports `renderQueue(items, context): HTMLElement` (pure DOM builder used by tests) and `parseItemRef(text: string): string` (`https://app.clickup.com/t/86d3j4f8q` → `86d3j4f8q`; `86d3j4f8q` → itself; trims; returns the last non-empty URL path segment for any link).

Screen anatomy (match `queue.html` List state pixel-for-pixel in structure and classes):
- `header.studio-heading`: `h1` "Queue", line "Items from your sources, built one at a time. Nothing reaches the remote until you land it.", right side "Checked N min ago" + "Check replies" button (posts `/api/queue/check`, toasts "Checked N, M resumed").
- Summary bar: count chips per state (only states with items), "One builds at a time" note, layout switch (List · Git tree; Task 4 fills Git tree — in this task the Git tree button exists and shows "Git tree" text placeholder screen only if Task 4 is not done yet: render the switch with List pressed and Git tree `disabled`), "Add item" button.
- Rows (`article.mk-card.q-card` per mockup): drag handle (only `queued` rows are `draggable="true"`; drop onto another queued row posts `/move` with that row's index among all items), state pill, title, meta line (source badge = plugin icon + plugin name + link icon to `item.url`; flow name or "Default flow"; progress text: building → "Building", queued → "Next up" for the first queued else "Nth in line", waiting-info → "Asked N questions · <age>" and the questions listed when the row is opened, ready → "Built · <age>", failed → error text), right action: ready → "Open run" (dispatches `quiet:studio-run` with `{ runId: item.runIds.at(-1) }` then `quiet:show` studio is handled by Studio), failed → "Requeue" + "Open run", queued → "Remove" (text button, danger color), waiting-info → none.
- Empty state (`q-empty` per mockup "Empty"): explains items come from a source plugin and offers "Add item" plus the `mctl queue add` line.
- Add item dialog (`dialog.access-dialog.flat`, per mockup "Add item"): Source select (enabled plugins), "Task link or id" input (parsed with `parseItemRef`), "Build in" folder input with a datalist of recent directories, Flow select (saved flows + "Default flow"), Position (End of queue / Next up), Add button → `POST /api/queue`; errors show inline under the form (the route returns the source's message, e.g. "No method source.item" means the plugin is too old).
- Live: one `EventSource('/api/queue/stream')`; re-render on each message.

- [ ] **Step 1: Failing tests** in `test/queue-dom.test.ts`: renders one row per item in order with the right pill text; "empty queue shows how to add an item"; "an item from an unknown source still renders" (plugin list lacks it → badge shows the source id, no img); "only queued rows are draggable"; requeue/remove/check buttons call the right URLs (stubbed fetch records); `parseItemRef` cases; the Add form posts `{ source, externalId, repo, flowId?, position }` and shows the returned error inline.
- [ ] **Step 2: Run, see failures** — `bun test test/queue-dom.test.ts`
- [ ] **Step 3: Implement** `client/queue.ts`, shell wiring, CSS.
- [ ] **Step 4: Run, see passes**; `bunx tsc -p tsconfig.shell.json --noEmit`; `bun test test/shell.test.ts` (shell markup tests).
- [ ] **Step 5: Visual check** — run `node` with the Playwright copy in `node_modules/playwright` against `http://127.0.0.1:7777/` (the client is built on request, so new client code is live on reload; the server routes from 1a need the cockpit restarted by the user — if `/api/queue` 404s, render the screen in a JSDOM-free static harness: write a scratch HTML that loads `/quiet.css` from the running cockpit and the output of `renderQueue()` with fixture items, screenshot it) and compare with `visualizer/queue/queue.html`. Fix mismatches once.
- [ ] **Step 6: Commit** — `feat(queue): Queue screen with list, add item and actions`

---

### Task 4: Git tree layout

**Files:**
- Create: `client/queue-tree.ts`
- Modify: `client/queue.ts` (enable the Git tree switch; fetch `/api/queue/tree` when shown and on each stream message while shown), `public/quiet.css`, `tsconfig.shell.json`
- Test: `test/queue-tree-layout.test.ts`

**Interfaces:**
- Consumes: `QueueTree` (Task 2 types — import the type from `server/queue-tree.ts`), queue items.
- Produces: `export function treeRows(tree: TreeRepo, items: QueueItem[]): TreeRow[]` (pure: one row per commit, newest first; base commits on lane 0; each started item gets the next lane index; each row carries `{ lane, sha, subject, item?: { id, state, branch, worktree }, forkOf?: number }`), and `renderTree(tree: QueueTree, items: QueueItem[]): HTMLElement` drawing an inline SVG graph like `queue-tree.html`: `main` spine, colored lanes from existing tokens, parked (`waiting-info`) lanes dashed with a pause mark and a "parked" chip, ready lane with a dashed "rebase onto main → fast-forward" label, "Not started" list above for queued items without a worktree. One repo section per `TreeRepo`, headed `branch in repo path · newest on top`.
- [ ] **Step 1: Failing tests** for `treeRows`: lane assignment order, fork row placement, parked flag, items without lanes excluded; `renderTree` renders one section per repo and a "Not started" list when queued items exist.
- [ ] **Step 2: Run, see failures** — `bun test test/queue-tree-layout.test.ts`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, see passes**; tsc shell clean; visual check against `visualizer/queue/queue-tree.html` as in Task 3 Step 5.
- [ ] **Step 5: Commit** — `feat(queue): git tree layout for the Queue screen`

---

### Task 5: Sidebar — queue nested under its source

**Files:**
- Modify: `client/sidebar.ts`, `public/quiet.css`
- Test: `test/sidebar-queue.test.ts` (JSDOM; check `ls test | grep -i sidebar` for an existing sidebar test harness and extend that instead if one exists)

**Interfaces:**
- Consumes: `/api/queue/stream`, the existing `pluginRows`.
- Produces: under each plugin row that has queue items with `source === plugin.id`, an indented child group (per `d.html`): a "Queue N" sub-row (icon + label + count of items not `ready`/`failed`… use total count as in the mockup) that dispatches `quiet:show` `queue`, then one compact row per item (state dot + title + state line) that dispatches `quiet:show` `queue` and `quiet:queue-focus` with the item id. No group when the plugin has no items. Collapsed rail (`sidebar-mini`) gets no queue rows. The sidebar's render-skip key (the `JSON.stringify([...])` at the top of the render, around line 353) must include the queue rows so updates repaint.
- [ ] **Step 1: Failing tests**: group appears only under the owning plugin; counts; click dispatches the two events; no group without items.
- [ ] **Step 2: Run, see failures**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, see passes**; tsc shell clean; visual check against `visualizer/queue/d.html`.
- [ ] **Step 5: Commit** — `feat(queue): queue items nested under their source in the sidebar`

---

## Done means

- `bun test` green; `bunx tsc -p tsconfig.shell.json --noEmit` clean.
- After the user restarts the cockpit: the sidebar shows ClickUp board → Queue N → items; the Queue screen lists items, adds one from a ClickUp task link, switches to Git tree; a ready item rings the bell with "Open queue".
