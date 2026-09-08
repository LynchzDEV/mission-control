Superseded by [ui-overhaul-implementation.md](ui-overhaul-implementation.md) after user design approval on 2026-09-08. Retained as history.

# Mission Control application overhaul

The user explicitly requested a complete working application redesign on 2026-09-08, superseding the earlier sample-only exploration stage. Preserve backend behavior. No palette or exploration was previously approved; the user now delegates creative decisions. This document is an implementation brief, not a claim of user visual approval.

## Product and visual direction

Active terminal work is home (80% of use). Several real terminals can stay visible, split horizontally or vertically, resize, focus, and restore. Changing projects or opening secondary views must preserve terminal connections, output, working input, and scroll position. Agent activity/chat opens on demand and starts closed. Overview shows actual jobs and manual plans; Usage is globally reachable; Settings is secondary. Every existing working capability remains reachable.

Build one coherent custom interface. Pale mineral canvas (#e9eff2), light porcelain (#f8fafb), deep ink terminal surfaces (#101e2b), blue primary action (#2855d9), slate text (#1a2b3c), and restrained sea-glass motion (#579caa) form the base. Add named state/contrast tokens where needed. Use Helvetica Neue/system sans for interface and Menlo/SF Mono for terminal output. Remove the pixel-font/heavy uppercase treatment from ordinary controls. Titles use confident medium weights; small controls remain readable, generally 13–14px. Corners differ by purpose: compact controls 6px, floating sheets 16px, terminal panels around 10px. Fine borders and directional depth replace repeated shadowed cards.

The memorable element is a flowing ASCII horizon, adapted from the genuinely liked motion-before.html mathematics. Give it real visible space along the workspace horizon and in the zero-session state. Opaque terminal reading surfaces retain contrast. Do not draw fake network edges, a central spiky core, decorative gauges, fake traffic lights, slogans, or invented statistics. Movement is calm and visibly alive, with a pause control and reduced-motion/hidden-document handling. Spatial focus/restore and work switching may use existing Anime.js or native animation; text must settle flat and readable.

Composition: compact global masthead with Mission Control identity, global usage, and attention count; a narrow navigation spine with accessible labels; an expansive central workspace. A contextual directory/session navigator groups existing terminals by cwd, with exact directory paths available. The active directory name provides typographic hierarchy above the terminal deck. Secondary views feel like pulling back from or opening alongside this same workspace, not a marketing site. On small screens use compact navigation, one usable pane at a time, and explicit peer switching. No horizontal page overflow at 320px.

References consulted: https://linear.app (product clarity), https://www.raycast.com (focused command surfaces), https://zed.dev (editor readability), and https://dribbble.com/tags/ai-ui (visual ambition). These are inspiration, not instructions to clone. The prior twenty explorations should not be copied or rebuilt.

## Ownership and constraints

Implementation owns server/views/*.tsx, client/*.ts, public/theme.css, public/theme-tokens.css, design/theme-tokens.css, small new public/client UI assets, related test/*.test.ts, and one scripts/render-ui-preview.ts if needed for safe verification. server/index.ts may change only frontend route defaults and client bundle invalidation needed by this change. No changes to backend job/PTY/provider/auth/data semantics, secrets, config values, unrelated files, AGENTS.md, or existing visualizer/. Parent owns this brief and verification evidence. No file deletions, new dependencies, branches, worktrees, commits, pushes, service restarts, killing processes, real job executions for testing, or external messages.

The tree is shared; do not revert others' changes. Start with git status. Existing untracked AGENTS.md and visualizer/ belong to prior work. Work directly on current main as requested, without creating a branch. Keep implementation integrated and concise; avoid a parallel new framework or design-system scaffold.

## Build order and acceptance

1. Read current view/island contracts; write focused behavior checks for terminal layout state before changing it. Update design and public token sources together (postinstall copies design to public). Create coherent shell/theme, terminal workspace, and ambient motion. / and successful login/setup should open terminals. All routes retain direct links.
2. Replace the singleton terminal renderer with the minimum per-session xterm/socket ownership needed for persistent splits. Preserve search, links, copy/paste, Mac/Shift+Enter shortcuts, file/drop upload, rename, resume, kill confirmations, model selection, and resize. Keep mc:terminal-scope with {id,cwd}. Respect existing sessions; no automatic new PTY creation at page load. Test missing/ended sessions, zero sessions, failed create/attach, switching/focus state, saved layout referring to missing sessions, and narrow widths. Use bounded visible splits and explicit feedback at limits.
3. Preserve the terminal DOM/connections while navigating secondary views. Existing app is separate self-installing islands, so do not naively execute them twice or remove active xterm nodes. A small persistent workspace shell with same-origin embedded secondary views is acceptable if needed; embedded content must omit duplicate chrome, have accessible titles, propagate actions into the workspace, and preserve route/deep-link behavior. Prefer a simpler sound solution if available.
4. Redesign Overview (existing /lanes), Dispatch, Review, agent activity/chat, Usage, Settings, login/setup. Retain working actions and data hooks or update their callers together. Usage remains provider-specific: Claude token/cost/reset, GLM quota, Codex availability/auth. Never invent combined cost or comparable percentages. Flow plans remain manual, jobs and PTYs distinct, reviewed acknowledgment and landing distinct. Existing unsupported Settings actions must remain clearly unavailable, never simulate success. Forms need visible pending/success/failure feedback, labels, and protected secret inputs.
5. Provide runnable checks and a safe way for parent to render the actual new views before restarting the live backend. The current Bun server does not hot-reload server imports. If necessary write scripts/render-ui-preview.ts that renders the new views to public/ui-preview/ using safe real model/role/config view shapes; static pages must call the existing same-origin real APIs, contain no secrets, and use the real implementation (not a separate mock). Isolate the path mapping so generated preview URLs navigate correctly. Parent owns Arc/browser and live mutations. Do not start another server or touch Arc yourself.
6. Run focused tests during work; run full bun test once at the end. Build every changed client entrypoint using Bun.build, because there is no configured typecheck command. Update brittle legacy appearance tests only for intentional changes; preserve behavior/security assertions. Report files, checks, functionality, and any activation limitation honestly. Leave all changes uncommitted for parent review.

## Source traps already mapped

- server/index.ts appShellPage() currently renders LanesPage(); client/forms.ts login/setup redirects to /lanes.
- server/views/layout.tsx owns chrome and drawer. client/nav.ts owns number-key full navigation. Preserve editable-target guards and provide active aria state.
- client/terminal.ts currently has singleton xterm/socket/attachedId. Attach disposes the old view. Terminals are server-lifetime PTYs; restarting loses them. Do not restart the current service.
- client/agents.ts defaults mc.agents.open to true; change fresh-default to closed. Thread drawer is separate. Avoid restoring an obsolete open default from the old design without clear migration.
- dispatch.ts expects jobs-body and review-body to be table sections (insertRow/insertCell). Update renderer if changing their structure.
- flow.ts/plan-view.ts expect existing plan/activity IDs. Read before restyling or recomposing.
- settings forms use data-post/data-fields/data-status/data-reveal contracts and live model-picker behavior. Never print secret values.
- Bun JS cache only checks entrypoint mtime; shared-import edits need correct dependency invalidation or corresponding entry rebuild, without introducing a large watcher.
- No structured diff-hunk/file-tree API and no universal Codex history resume. No backend project entity: group by cwd/label only.

Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
While iterating run only the tests for files you touch; run the full suite ONCE at the end.
