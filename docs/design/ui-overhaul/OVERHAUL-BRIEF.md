# Mission Control — complete workspace redesign

## The actual brief

The user explicitly corrected the direction: “i want overhaul UXUI -> new entire things except backend working the same.” A port of the existing layout, a reskin, and a stripped-down terminal mockup are all rejected. This brief supersedes BRIEF.md and MOTION-BRIEF.md for the next design. Keep backend capabilities; redesign the navigation, hierarchy, placement and interactions freely.

Keep the things the user liked: flowing ASCII atmosphere, dimensional Anime.js motion, geek character and clean legibility. Restore essential information and the interactive agent working chat. The central spiky ASCII core and engine hub wiring were rejected. Off-centre placement was not the problem. The black/grey/orange identity was boring. No full design is approved yet; deliver an interactive standalone design decision artifact, not production changes.

## One workspace, organised around work

Use a new composition rather than modifying motion.html. Default to an active task with two peer agent conversations as the main content. A raw terminal is a tool you can open, not the entire application’s main layout. Avoid the old five-page navigation, a giant terminal with a narrow Agents sidebar, or a stack of conventional dashboard cards.

- **Top:** a compact brand/project context row and utility access (search, engine settings). Below, the selected task’s name, real status and a concise editable ordered plan. The plan is manually tracked, not an automatic scheduler. One dimensional activity artwork occupies some of the open space beside the task heading; it is not a flow graph.
- **Main:** two substantial agent conversation surfaces, independent reply fields, opening requests, streamed sample updates, tool details and current activity. Both are working conversations, not a main view plus passive sidebar. Focusing an agent expands its conversation and reduces the peer to an accessible compact strip; returning restores the split. Job log, full thread, stop and review actions belong to that conversation.
- **Bottom:** a persistent horizontal task switcher with task status, New work, and access to all/archived work. Switching tasks preserves chat drafts and per-task context. New work expands a launcher from this area with prompt, label, repository path, engine/model and optional isolated worktree. It adds a sample task and agent conversation in place.
- **Terminal dock:** opens within this workspace from a clear Terminal action. Contains raw terminal-style sample output/input, session switcher, new, rename, close, find and supported historical resume. It must be usable alongside the agent conversations and collapse cleanly. No fake browser/OS traffic lights.
- **Review:** opens alongside the relevant thread. Show actual-shaped diff summary, activity, full conversation, copy review command, mark reviewed and separate worktree landing action. Review queue is reachable from the workspace; all-clear state is explicit. Do not fabricate a structured diff viewer the backend cannot supply.
- **Engine/settings panel:** engine availability and supported usage information, Plan/Execute/Review defaults with engine/model, auto-review, masked connection settings and access settings remain reachable. They are global tools, not permanent main-page clutter. No new backend entities or APIs.

This is the full product interaction concept. Do not add links to the old five-page snapshots as substitute implementations. Do not put a new paint layer on existing HTML. Reuse small sound behaviours, native controls and the ASCII algorithm where useful.

## Visual identity and craft

Proposed base: deep petrol `#071B20`, panel `#102A30`, selected dark `#183940`, ivory `#F0EEE2`, secondary `#AAC0BE`, rules `#315158`, citron `#E3F56B`, coral `#FF957D`, blue `#9FCBEF`. Use a light ivory surface for the focused agent conversation with dark petrol ink, and a dark peer conversation. Change focus coherently rather than randomly colouring panels. Dark terminal dock, strong but limited citron selection/action, labelled engine accents. Keep dark and light surface contrast tokens separate.

Use Avenir Next for interface/body, DIN Alternate for compact display/task headings, and Menlo for code, with sensible system fallbacks. These fonts exist on this user’s Mac; reference them, do not redistribute system font files. Headings carry personality; do not fill the screen with slogans or oversized task descriptions. Body 14px, metadata 12px. All colours/type use named tokens. Primary conversation is an uninterrupted reading surface, not nested message cards or rounded bubbles. Use deliberate asymmetry and depth; restrained borders, no one-radius-everywhere kit.

The memorable motion is an original dimensional dot/line form using the installed Anime.js 4.5.0. Think layered planes folding or travelling through depth, with precise highlights and a coherent silhouette, approximately 160px in the task header’s open space. No spiky ASCII star, stock orb or engine wiring. Working activity animates; stopped/completed work settles. Focus/split changes, launcher expansion and new message arrival use short purposeful transitions. No gratuitous paragraph typewriter or perpetual animation of text. The original flowing ASCII field remains visible around the work surfaces, tinted to the new palette.

## Backend reality — preserve semantics

- Jobs: `POST /api/jobs` requires engine/cwd/prompt/label, optional model/worktree/terminalId. Status is running/done/failed. Stop is kill; no process pause, queued execution, dependency scheduling or job-delete API.
- Threads: `/api/jobs/:id/thread` gives typed prompt/text/tool/result/thinking rows, running/canReply/sessionId. Reply creates a new resumed execution; it is not keystrokes sent to a running worker. Group by threadRoot; auto-review may add a different engine within a thread. Respect reply-unavailable state.
- Work sessions: `/api/flow` groups by label, not repository. Plan is 1–32 ordered title/assignee/status steps; pending/active/done. It is manual tracking without dependency edges or automatic dispatch. Archive/unarchive exists. Do not present legacy inferred flow stages as proven workflow or Git state.
- Terminals: separate PTYs, not jobs. Create engine/cwd, optional model/title; rename/kill; WebSocket input/output; search is frontend. Historical resume supports Claude/GLM, backed by Claude transcript storage; never promise universal Codex terminal history. File drop resolves/uploads a path then inserts it; this preview can demonstrate with a clearly sample path.
- Review: diffStat/log/thread only, no structured diff-hunk or file-tree endpoint. Mark reviewed is acknowledgement only. Land is separate, for eligible worktrees, and commits/cherry-picks/removes the worktree; it does not push. Keep these distinct in the UI.
- Roles: all Plan/Execute/Review assignments saved together; defaults do not reassign running work. Model choices include engine default/custom. Quota shapes differ: Claude tokens/cost/reset, GLM percentages, Codex availability/auth only. Do not invent uniform usage percentages.
- Settings: masked connection values, probe/save, API access reveal/rotate and bind-address confirmation exist. Demonstrate only sample values; do not request or store real credentials.

Pointers: server/routes/{jobs,terminals,flow,roles,models,quota,meta,secrets}.ts; server/{threads,flow,auto-review}.ts; client/thread-view.ts and thread-drawer.ts for conversation behaviour. Current view files are capability references only, not placement templates.

## Prototype boundaries and acceptance

Create workspace.html, workspace.css, workspace.js and evidence/workspace-verify.cjs under this directory. Reuse/copy installed Anime.js bundle with licence under vendor/. Existing serve.ts remains on 127.0.0.1:47831; no restarts, dependencies, production edits, branches or commits. No API calls, persistence, real jobs or shell commands from the preview. All fixtures visibly disclosed as sample data once in the shell.

Use realistic fixtures tied to the actual contracts. Every shown control must do something observable, including empty/no-results/already-done states. Chat progression is finite and bound to its originating thread; drafts, open tool disclosures and reader scroll survive updates and switching. Stop cancels that thread’s pending simulation. Pause/reduced motion stops decorative animation, not completion of a sample reply. Keyboard controls/IME, semantic dialogs and focus restoration required. Show a useful empty workspace and a disconnected/retry sample state through the quiet sample disclosure menu.

Verify the main journeys in actual Arc: create work → watch activity → reply → switch task/return → expand tool → inspect/review → mark reviewed; open/new/rename/close/resume terminal; settings changes; empty/error states. Render at 1512, 1000, 768, 414, 375 and 320px without page overflow or inaccessible controls. Test real motion over time, paused and reduced, not just screenshots. The parent performs Arc verification and a scoped code review before presenting.

The new prototype must look and behave materially different from motion.html at first glance and across a complete work journey. If it resembles the old top nav + terminal + sidebar arrangement, it fails regardless of polish.
