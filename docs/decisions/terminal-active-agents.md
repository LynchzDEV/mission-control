# All active agents for the current terminal

Replace the single selectable Agent conversation window with simultaneous live windows for all active conversations linked to the selected terminal. The user supplied a 2560px screenshot with large empty left/right margins and explicitly requested all active agents, not one at a time.

## Layout and behavior

- At wide desktop sizes (the supplied 2560×1400 case), use the spare left and right margins for compact agent windows, preserving the dominant central terminal, masthead, flow, and session controls. Use normal CSS layout rather than overlapping terminal output. On ordinary desktop/tablet/mobile sizes, use a compact wrapping grid above the terminal. Keep every active conversation accessible without a single-choice selector or arbitrary card limit; a bounded, visibly scrollable agent area is acceptable for unusually large counts.
- Use the existing .agent-window styling, per-engine accents, activity bars, multiline createMiniFeed, and mc:agent-open drawer action. Each card shows its actual label, engine/running state, current activity, live feed and one Open conversation action. Default open; preserve user collapse and feed/DOM identity across polls. No new dependencies or fake agent data in shipped code.
- Show only non-archived active conversations associated with the current terminal, deduplicated by threadRoot. Explicit terminalId wins: two terminals sharing a cwd must not leak explicitly assigned jobs across terminals. Keep the existing legacy cwd fallback for jobs lacking terminalId. With no current terminal, do not present global jobs as its agents. Completed conversations remain in the existing Agent chat/history UI; they leave the active windows. Scope switches, completion/removal, failure/recovery and same-thread new activity must stop/start the correct feeds without stale content.
- Keep flow selection/stages/grouping and existing terminal actions unchanged. Selecting a different flow must not hide the terminal's other active agents. Preserve the just-fixed centered Start a session state.
- Use stable browser hooks: #active-agent-windows for the collection, #active-agent-status for its count/empty/error text, .agent-window[data-thread] for each card, .agent-feed for its feed host and .agent-open for its Open conversation button. Remove the obsolete single-agent dropdown/IDs and update tests accordingly.

## Ownership and verification

Start at client/awareness.ts, server/views/terminals.tsx, public/theme.css, and the existing test/awareness*.test.ts. Reuse client/thread-view.ts and client/agents.ts behavior. Touch shared code only if required for a demonstrated bug. This is a shared dirty checkout: retain every existing edit, including public/theme.css welcome centering; do not change the approved visualizer.

Focused tests must cover several active threads at once, same-cwd different-terminal exclusion, thread deduplication, completed/archived exclusion, no-current-terminal/empty state, stable cards during polls, scope changes, completion and feed recovery. Parent independently verifies the actual rendered preview at 2560/1512/768/414/320px with multiple active fixture conversations, drawer actions, live updates and preserved terminal DOM/sockets.

While iterating run only the tests for files you touch; run the full suite ONCE at the end. Existing terminal integration tests use isolated fake engines/local shell fixtures and are allowed. No real model turns or live terminal operations for verification. Rebuild the actual template preview with bun scripts/render-ui-preview.ts. Do not restart the server, create branches/worktrees, commit, push, or change credentials/config. Report exact checks and changed files.

Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.

## Verified result — 2026-09-08

Implemented the simultaneous cards with retained per-thread DOM, collapse state and live feeds. Following the user's full-width correction, the masthead and workspace have no width cap. Wide screens use two compact 300px side rails around a flexible terminal; empty agent columns collapse. Smaller screens use a wrapping, scrollable grid. The client also upgrades the running server's earlier single-window markup, so activation needs a page refresh rather than a server restart.

- Full suite: 774 passed, 0 failed, 48 files. The final list-error action correction then passed all 9 focused awareness tests.
- Browser: `/tmp/mc-active-agents-check.mjs --live` passed five simultaneous scoped agents at 2560/1920/1512/1000/768/414/320px, actual drawer actions, adding/completing agents, same-directory terminal exclusion, feed error/recovery, empty states and preserved terminal DOM/socket. The final lifecycle rerun also verified opening a cached conversation while list refresh fails.
- Browser-discovered corrections: minimum terminal content height prevents a five-card grid collapsing output at 1000px; GLM inherits the existing blue token. Desktop screenshot: `/tmp/mc-active-agents-2560.png`.
- Full-width correction: browser geometry passed at 320/414/768/1000/1512/1920/2099/2100/2560/3840px. At 2560px the terminal grows from 1428px to 1820px with active agents, and to 2476px without them; at 3840px it reaches 3100px with agents. Header/workspace fill every tested viewport, with no horizontal overflow or agent overlap. Empty-state centering and Open/Cancel still pass.
- Focused TypeScript review found an enabled conversation button doing nothing during list errors. Its handler regression failed before the one-line correction and passed afterward; cached valid threads remain openable while the list retries.
- Preview rebuilt; `git diff --check` passed. No restart, real model turn for verification, live terminal mutation, commit, branch or push.

The automatic review also inspected earlier overhaul changes outside this feature and flagged cached Main iframe deep links retaining an internally changed selection when reopened. That separate workspace navigation finding is not changed by this agent-window implementation; these cards open the existing conversation drawer directly.
