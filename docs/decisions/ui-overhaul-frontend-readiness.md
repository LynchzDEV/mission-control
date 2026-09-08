# Approved frontend implementation handoff

2026-09-08. Implemented directly in the existing dirty main checkout using terminal-components.html and DECISION.md as the visual source. Existing unrelated edits and behavioral repairs were retained.

## Preview

Open `/ui-preview/terminals.html` on the existing server. The generated real templates now include the dark masthead, three provider summaries, grey ASCII wave above the workspace, scoped work flow, selectable live mini conversation, xterm surfaces, contextual directories, and bottom session strip. Secondary routes remain in cached embedded views so navigation preserves terminal DOM and sockets. No sample sessions are created. Settings preview writes are disabled and visibly labelled.

`bun scripts/render-ui-preview.ts` builds all 22 browser entrypoints and renders 11 templates. All referenced preview and vendor assets exist locally. No server restart was performed.

## Functional changes

- Provider normalization accepts optional five-hour/weekly percentages and reset fields. Claude blockPercent is only a labelled ccusage estimate fallback. Missing values remain unavailable; GLM monthly usage is never weekly. Usage retains reported cost, tokens and monthly detail.
- Flow selection uses actual thread members and activity job ownership. Same-label older threads no longer inherit the latest thread's plan/activity. Unscoped manual-only plans remain selectable. Scoped work matches terminal ownership first, then legacy directory association.
- Mini conversations use createMiniFeed; opening one delegates to the existing agent drawer. Full agent controls remain accessible through Agent chat.
- Existing terminal instances remain owned by session. Layout controls retain split/focus/resizing and now switch an existing split's orientation. Stable session tab nodes preserve double-click rename targets.
- Existing cached New job, reply DOM preservation, and member-targeted reviewed/land repairs are retained. Model pickers resynchronize after form reset. Acknowledged worktrees remain accessible for separate landing.

## Verification

Final suite pass: **695 pass, 0 fail**, 1,915 assertions, 43 files, 28.23 seconds. Ran once after focused iteration. Excluded `test/terminals.test.ts` and `test/terminals-routes.test.ts` (49 tests total): these suites spawn real PTYs, forbidden by this job's instructions. This is not an unrestricted full-suite pass.

Latest focused run before the final pass: 16 pass, 0 fail, covering quota normalization, flow ownership/selection/scope, inert terminal lifecycle and rename target stability, failed work requests/drafts, and cached composer reopening. Other touched behavior tests also passed in the final safe suite. Browser bundles build successfully; preview asset validation reports no missing files.

## Parent verification and limitations

Parent owns exact browser comparison, viewport geometry, live socket/persistence checks, and supported quota collector extensions. Browser screenshots and real PTY behavior were not exercised by this worker. Weekly and Codex percentages remain unavailable until supplied by the backend. Terminal model selection is preserved at creation; terminal headers only show metadata actually present in list records. Manual plans are displayed as manual steps, not as an automatic scheduler.

## Files changed by this pass

`client/agents.ts`, `client/awareness.ts` (new), `client/lanes.ts`, `client/model-picker.ts`, `client/provider-usage.ts` (new), `client/terminal.ts`, `client/work.ts`, `client/workspace.ts`; `server/views/layout.tsx`, `server/views/terminals.tsx`; `design/theme-tokens.css`, `public/theme-tokens.css`, `public/theme.css`; `scripts/render-ui-preview.ts`; `test/awareness.test.ts` (new), `test/provider-usage.test.ts` (new), `test/terminal-client.test.ts`, `test/work-client.test.ts`, `test/work.test.ts`; generated `public/ui-preview/` assets and this record. Earlier dirty-tree changes outside this list belong to the prior implementation or other workers.
