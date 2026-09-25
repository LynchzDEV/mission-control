# Mission Control 2.0 — Phase 4: Studio in the quiet design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Studio feature the current app has (`docs/new-design-port-status.md` §8) works inside the quiet shell as the Studio screen, styled from the design's Studio sections, with nothing left of the old Studio page.

**Architecture:** Studio stays one React island (`client/studio.tsx`, already the stack; every feature's logic lives there and in `client/studio-settings.tsx`, `client/studio-graph.ts`) but renders into a `#studio` screen section inside the quiet shell (`server/views/shell.ts`), re-skinned to the design's markup and classes (`docs/design/quiet-chat/index.html` Studio sections, CSS already in `public/quiet.css:165-232`). The canvas keeps `@xyflow/react` with quiet node styling. The `Studio` pill in the toolbar switches screens; `/studio` redirects into the shell. The server gains what the design needs and the API lacks: removing a connection, and the z.ai settings reachable from Manage AIs.

**Tech Stack:** Bun + Elysia, React 19 + `@xyflow/react` (installed), client islands, `bun:test`.

**Spec:** `docs/new-design-port-status.md` §7 (Settings removals, Chat home) and §8 (feature checklist + the "Chat decides" decision); design markup `docs/design/quiet-chat/index.html` `#studio`; visual rules in `docs/decisions/system-chat.md` §Around the chat (no emoji, flat inputs).

## Global Constraints

- Trunk-based on `main`, no branches or worktrees; commit per task; never push; never touch port 7777 (verify on the 7781 throwaway).
- No code comments except one line for a trap; no emoji; flat inputs (`#e2e6f0`, no inset/neumorphic fields); Neumorphism only on cards, dialogs, buttons; SVG icons from the shell's sprite (add symbols there when Studio needs one; `client/studio-ui.tsx` `Icon` may stay for the canvas).
- Work defaults (roles) and Automatic review are gone from every screen (§7). A step's "Who should do it?" default reads **Chat decides** (an unpinned step: `agent.engine` undefined); the runner keeps resolving unpinned steps through the stored roles config — that is a server default, not a UI concept. Ruling: wiring "Chat decides" to the chat's AI chip at run start is Phase 5 (recorded there).
- Every AI picker lists every provider from `GET /api/providers` (built-ins + connections), never a hardcoded list.
- Existing tests keep passing; new server behaviour gets route tests in the style of `test/studio-routes.test.ts`; pure client logic gets tests in the style of `test/studio-graph.test.ts`.

## Review Focus

1. Leaving Studio with unsaved changes (switching to chat, New chat, closing the tab) must warn, not silently drop the draft — T2 keeps the island mounted across screens and T5 adds the guard.
2. A workflow run started from Studio while a chat is open must not steal the chat screen; Runs shows it and the chat is untouched (T4).
3. Removing a connection that a saved workflow pins must not break the editor: the step shows "Unavailable · <id>" and can be re-pinned (T1 + T3).
4. Saving the z.ai token from Manage AIs must never echo the token back into the DOM or a log (T5 uses `POST /api/secrets` and the public view only).
5. ReactFlow's default styles must not leak into the shell (scoped import, quiet overrides) and the shell's dotted backdrop must stay behind the canvas (T3).

---

### Task 1: Server: remove a connection, serve Studio from the shell `[agent]`

**Files:**
- Modify: `server/agent-connections.ts` (`createConnectionStore().remove`), `server/routes/studio.ts` (`DELETE /api/studio/connections/:id`), `server/index.ts` (`/studio` redirects to `/?screen=studio`; drop `StudioPage`), `server/views/studio.ts` (delete), `test/agent-connections.test.ts`, `test/studio-routes.test.ts`, `test/http.test.ts` (or wherever `/studio` is asserted — grep first)

**Interfaces:**
- `remove(id: string): Promise<void>` — deletes `connections/<id>.json`; unknown id → resolves (idempotent); built-in ids → throws `Cannot remove a built-in connection`.
- `DELETE /api/studio/connections/:id` → `{ ok: true }`; 400 with `{ error }` for a built-in; invalidates `modelsCache`.
- `GET /studio` → 302 to `/?screen=studio` (local guard unchanged); `GET /studio?embed=1` behaves the same (embedding is gone with the old layout).

- [ ] **Step 1: Failing tests** — in `test/agent-connections.test.ts`: `remove` deletes the file and `list()` no longer returns it; removing twice is fine; removing `claude` throws. In `test/studio-routes.test.ts`: `DELETE /api/studio/connections/qwen` after a save returns 200 and the list is empty; `DELETE .../claude` → 400. In the http test for `/studio`: expect 302 with `location: /?screen=studio`.
- [ ] **Step 2: Run them red.**
- [ ] **Step 3: Implement** — `remove` uses `rm(join(root, `${identifier.parse(id)}.json`), { force: true })` after the built-in check; route: `.delete('/api/studio/connections/:id', async ({ params }) => { await connections.remove(params.id); modelsCache.invalidate(); return { ok: true } })` (the group's `onError` already maps thrown errors to 400). In `server/index.ts` replace the `/studio` entry of `TAB_PAGES` with a plain route `.get('/studio', ({ set, request }) => { if (!localRequestAllowed(request)) { set.status = 403; return 'local access only' } set.status = 302; set.headers['location'] = '/?screen=studio'; return '' })`; delete `server/views/studio.ts` and its import; keep `public/studio.css` and `client/studio.tsx` for now (T5 removes the old CSS after the re-skin lands).
- [ ] **Step 4: Full `bun test` green.**
- [ ] **Step 5: Commit** — `git add server/agent-connections.ts server/routes/studio.ts server/index.ts test/agent-connections.test.ts test/studio-routes.test.ts <http test>` and `git rm server/views/studio.ts`; message `feat(studio): remove a connection; /studio opens the Studio screen in the shell`.

---

### Task 2: Studio screen in the shell, Home and Templates `[here]`

**Files:**
- Modify: `server/views/shell.ts` (`#studio` section skeleton + `<div id="studio-root">`; `Studio` pill becomes `<button id="open-studio" class="pill" aria-pressed="false">Studio</button>`; script `/js/studio.js` + stylesheet `/js/studio.css` links), `client/shell.ts` (`screens` gains `'studio'`; `?screen=studio` on load; the pill toggles between studio and the previous screen, pressed while shown; `quiet:screen` still fires), `client/studio.tsx` (mount into `#studio-root`; Home and Templates re-skinned), `public/quiet.css` (studio additions), `test/shell.test.ts` markers
- Test: `test/shell.test.ts` markers `id="studio"`, `id="studio-root"`, `/js/studio.js`; `test/shell-typecheck.test.ts` unchanged (studio.tsx is type-checked by Bun.build at request time — add `client/studio.tsx` to the transpile list in `test/shell.test.ts` so a load-time break fails a test)

**Screen markup (static skeleton in shell.ts, React fills `#studio-root`):**
```html
<section id="studio" class="studio" aria-label="Workflow Studio" hidden>
  <header class="studio-heading"><div><h1>Studio</h1><p class="muted">Give your AI team a way to work.</p></div><nav id="studio-nav" aria-label="Studio sections"></nav></header>
  <div id="studio-root"></div>
</section>
```
React renders the nav buttons (`Workflows`, `Manage AIs`, `Runs`, `Rules` as `.text-button` with `aria-current="page"` on the active one — the editor screen hides the nav and shows a `Workflows` back text-button instead, as the old app does).

**Home (`.studio-view.describe-home`)**: `h2 How should your team work?` + muted line; `.workflow-prompt` (textarea; footer: provider `<select aria-label="Planning AI">` built from `/api/providers` with a first option `Chat default`; `Build workflow` pill → `POST /api/studio/drafts`; while drafting: the pill becomes `Stop drafting` and a `role=status` line "Your AI is drafting the workflow… This can take a minute." under the box); "Try an example" chips (two `.chip` buttons that fill the textarea); `.starting-options` (Use the default / Browse templates / Start from scratch — `.studio-option` cards); compact template shortcuts (the two non-default templates as small `.studio-option` rows with a mini step strip); `Continue editing <name> · Unsaved changes` text-button when a draft exists; `Your workflows` list (`.saved-workflows` — each saved workflow as a raised row with name, `n steps · date`).
**Templates**: `h2 Choose a starting point.` + `.starting-options` with the default (uses the saved default's revision), Research & verify, Blank.

Acceptance: `bun test` green; on the throwaway, `/studio` lands on the Studio screen with the pill pressed; the pill toggles back to the previous screen; Build workflow with a description starts a draft (a real Claude turn — the status line shows, Stop drafting works); the draft opens the editor (T3 shows it; for T2 a placeholder `Editor lands in Task 3` is acceptable); Use the default / templates / Start from scratch switch to the editor placeholder; no console errors; the dotted backdrop shows through around the cards.

- [ ] Commit: `feat(studio): Studio is a shell screen — home and templates in the quiet design`

---

### Task 3: Editor: canvas, panels, dialogs `[here]`

**Files:** `client/studio.tsx`, `public/quiet.css` (ReactFlow quiet theme + panel rules), `client/studio-ui.tsx` (icons the canvas needs)

- Editor heading per design: name input (flat, 21px), status line `Unsaved changes | Default workflow | Saved` + `· n steps`, actions `History` (text) · `Save` (pill, disabled when clean) · `Run workflow` (pill, disabled without steps; opens the run dialog after saving).
- `.workflow-canvas` holds `.canvas-tools` (`Add step` pill → picker panel; `Ask AI` text-button → assistant panel; the `AI draft · <summary>` notice with dismiss when a draft just landed) and the ReactFlow canvas (import `@xyflow/react/dist/style.css` stays inside the island bundle; override in quiet.css: `.workflow-canvas .react-flow { background: transparent }`, node = `.workflow-node` look (raised card 140px, title strong, `small` = agent label with the provider logo disc), edges lavender `#c9c0e3`, fail/blocked edges `#b0556a`/`#d4a091` with the outcome label, controls as `.round` buttons, background dots off (the shell's backdrop is enough)); `.canvas-note`: `Drag to arrange · connect to set the order` + a `Core rules always apply` text-button opening the rules dialog; empty canvas state (`Your workflow starts here` + `Add first step` / `Build with AI`).
- Right column `aside.step-inspector` shows one panel: **Add a step** (search field, preset rows with icon/title/description, `Custom task`, tip), **Edit step** (Step name; What should happen?; Who should do it? `<select>`: `Chat decides` (engine unset) + every provider from `/api/providers` + `+ Connect another AI` → Manage AIs; `Tools, skills & checks (n)` details with `StepAttachments`; `More options` details: Task purpose, three outcome selects (When it succeeds / If it fails / If it needs help), Model (datalist from the chosen provider's models, `Use this AI's default`), Maximum attempts, Model family; `Preview full instructions` + output; `Remove step`; footer `Add next step` / `Done`), **Build with AI** (intro, `Draft ready` summary, `Before running` setup notes with a Manage AIs link, two suggestion chips, the small prompt box `Update draft` with Stop while drafting, `Changes stay in this draft until you save.`), **History** (`Current draft · Unsaved changes` when dirty; each revision as `.saved-revision` with `Open version`; `Use as default workflow`; `Make a copy`; `Save this workflow to create its first version.` when unsaved).
- Dialogs (`.access-dialog.flat` like the launcher): **Run this workflow** (Run title, Project folder — flat inputs, `What should this run accomplish?` textarea, note, `Start run` pill; on success switch to Runs with the run selected and toast `Workflow started.`), **Core rules** (lock icon, the two paragraphs, `Back to workflow`).
- Keyboard: Escape closes the open panel; Delete does nothing on the canvas (as today).
- Tests: `test/studio-graph.test.ts` keeps passing; add a pure `agentLabel(node, providers)` in `client/studio-graph.ts` returning `Chat decides` / provider name / `Unavailable · <id>` with a test.

Acceptance on the throwaway: open the default workflow → 4 nodes with edges, drag a node (status → Unsaved changes), Add step → picker → `Run tests` appears wired after the selected node, edit its name/instructions, pin GLM, set `If it fails` → back to Plan, Save → status Saved and History lists the version, Make a copy → new id, Run workflow → dialog → Start run with the throwaway repo folder → Runs screen shows it running; Core rules dialog opens/closes; no console errors.

- [ ] Commit: `feat(studio): editor with the quiet canvas, step panels, history, run and rules dialogs`

---

### Task 4: Runs and Rules `[here]`

**Files:** `client/studio.tsx`, `public/quiet.css`

- **Runs** (`.secondary-studio`): `Recent runs` + `Refresh` text-button; each run as a `.history-item` details (`label`, status `.status[data-state]`, `workflowName · date`); opening one loads `GET /api/studio/runs/:id` and shows: status, `Stop run` (running) / `Retry current step` (failed/blocked), request, folder, error (`role=alert`), attempts list (step title, outcome, AI · model, summary, evidence bullets, each check as details with output, `Open job log` link, `Instructions used` details), `Versions used` details. Poll every 1.5 s while running and the screen is visible. Empty state: `Your workflow runs will appear here.`
- **Rules**: `.rules-card` with `policy.coreRules` (pre, wrapped), `Edit the core prompt` details: `Start from an earlier version` select (policy revisions), `Prompt template` textarea (flat, monospace), hint `Keep one each of {{core_rules}}, {{workflow}} and {{assignment}}.`, `Save prompt` pill (disabled when unchanged) → toast `Core prompt saved for future runs.`

Acceptance on the throwaway: the run started in T3 appears, its attempts fill in, Stop run stops it (status stopped), Retry re-runs the current step; Rules shows the core rules, editing + Save creates a new revision and the select lists it.

- [ ] Commit: `feat(studio): runs and rules screens in the quiet design`

---

### Task 5: Manage AIs, everywhere-behaviours, old Studio removed `[here]`

**Files:** `client/studio.tsx`, `client/studio-settings.tsx`, `public/quiet.css`, `server/views/shell.ts` (only if a sprite icon is missing), delete `public/studio.css`, `test/shell.test.ts`

- **Manage AIs** (`.connections-view`): left `.connection-list`: built-ins (Claude, Codex, GLM with one-line descriptions), configured connections, `+ Add a connection` (opens the preset chooser: Grok Build, Qwen Code, OpenCode, Custom ACP agent, Custom headless CLI); `.connection-choice` pressed state. Right `.connection-settings`: for Claude/Codex: description + `Check connection` disabled with the reason as title (built-ins have no probe) ; for **GLM**: `Z.ai base URL` + `Z.ai token` (password, placeholder `Configured` when `zaiAuthTokenConfigured`, never prefilled) + `Save` → `POST /api/secrets`, reading back only the public view; for a connection/preset: the full form from `client/studio-settings.tsx` re-skinned (`.field-stack`, flat inputs, `Advanced connection settings` details, `Allow this AI to use tools without asking each time` switch-label), `Save connection` pill, `Check connection` (probe; output in a details), `Remove connection` text-button (danger colour, confirm dialog) → `DELETE /api/studio/connections/:id`. No Work defaults, no Automatic review.
- **Everywhere**: error banner (`.chat-error`-style line at the top of the Studio screen with a dismiss ×), toasts through the shell's `#toast` (dispatch `quiet:toast` with the text; `client/chat.ts` exposes the listener — add it there), unsaved-changes guard: `beforeunload` while dirty or drafting, and `quiet:screen` away from studio while dirty asks `Discard unsaved changes?` via a flat confirm dialog (stay on Studio when declined).
- Delete `public/studio.css`; remove the `styles: ['/studio.css']` reference if any remains; `client/studio-ui.tsx` keeps only icons still used.

Acceptance on the throwaway: add a Qwen preset connection with a fake command, save (appears in the list and in `/api/providers` → the composer's AI menu lists it), Check connection fails cleanly with the error in the banner, Remove → gone everywhere; GLM save with a test base URL round-trips the public view without echoing a token; switching to chat with a dirty draft asks first; toast appears on save.

- [ ] Commit: `feat(studio): manage AIs with presets, z.ai settings and removal; error banner, toasts, unsaved guard; old Studio page removed`

---

### Task 6: Phase check `[here]`

- Full e2e pass of §8's checklist on the throwaway (record each ✓ in the ledger), `bun test`, screenshots of Home / Editor / Runs / Manage AIs saved under `docs/design/quiet-chat/reference/studio-*.png` and committed; `docs/new-design-port-status.md` §8 rows flipped to ✓ with the commit; roadmap row for Phase 4 marked DONE.
- Commit: `docs(design): Studio port status and reference screenshots`

## Deferred (record in the ledger)
- "Chat decides" resolved from the chat's AI chip at run start (needs the chat to pass its engine to `POST /api/studio/runs`) — Phase 5.
- Runs "View in chat" (a run started by the chat links back to it) — with the same wiring.

## Self-review
- §8 coverage: Home (T2), Editor + Step editor (T3), Runs + Rules (T4), Manage AIs + Everywhere (T5), removals (§7) honoured in T2/T5; `/studio` and connection removal (T1).
- Type consistency: `WorkflowNode.agent.engine` undefined = Chat decides everywhere; providers from `/api/providers` shape `{ id, name, builtin, models, family }` (server/providers.ts) used by T2 select, T3 picker/datalist, T5 list.
- Review Focus 1–5 pinned to T5, T4, T1+T3, T5, T3.
