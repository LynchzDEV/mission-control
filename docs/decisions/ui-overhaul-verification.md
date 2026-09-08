# Terminal component fidelity — 2026-09-08

## Commit verification — 2026-09-08

The final pre-commit full suite passed: 798 tests, 0 failures across 49 files. All 23 client entrypoints built successfully for the browser. The staged changes passed whitespace checks; the source/document scan found no credential-shaped values. Usage reporting, application implementation, and design references/documentation are recorded as separate local commits on main. Generated `public/ui-preview/` output is ignored and can be rebuilt with `scripts/render-ui-preview.ts`; unrelated `AGENTS.md` remains untracked. No push or service restart was performed.

## Responsive workspace correction — 2026-09-08

The user's responsive-layout instruction supersedes the fixed position and 407px/832px deck measurements below. The workspace now fills the remaining body height, with fluid outer spacing and agent-column proportions. Terminal rows share available space and retain a text-relative minimum for usable output; short screens scroll rather than crushing the terminal. The existing narrow-screen behavior preserves the saved split while displaying the selected pane.

The xterm host has size containment so canvas measurements cannot grow the workspace on every fit. Its upper spacing is a margin because FitAddon measures the parent's height without subtracting parent padding. Split tracks use fractional weights and individual row minimums: the reproduced 25% stacked-pane failure left only 17px for the output host before correction. Wide agent rails also contain their intrinsic size, so a long list scrolls inside the assigned area.

Browser verification passed at widths 320–3440px and heights 390–1600px: one to four panes, 25%/75% stacked splits, focus/restore, keyboard resizing, eight agents, 32-step flows, no active agents, centered empty state, New/Cancel, Resume/Close, and mobile directories. A separate 32-agent check confirmed the wide workspace still fits the viewport and the last card can be reached by scrolling its rail. No horizontal page overflow or JavaScript errors; rendered xterm rows/columns remain within their hosts. At width 1512px, increasing window height from 949px to 1400px expands the terminal deck from 474.5px to 903.4px. These checks use isolated API/WebSocket fixtures and do not attach or resize real terminal sessions.

`bun test test/terminal-client.test.ts test/terminal-layout.test.ts test/resize.test.ts`: 49 passed, 0 failed. Read-only review found no remaining concrete issue. Runnable browser check: `/tmp/mc-responsive-verify.mjs`; main run log: `/tmp/mc-responsive-verify.log`. Captures include `/tmp/mc-responsive-1512x1400.png`, `/tmp/mc-responsive-agents-3440.png`, `/tmp/mc-responsive-empty-1512.png`, and `/tmp/mc-responsive-32-agents.png`. No restart, commit or push.

## Header audit correction — 2026-09-08

The previous comparison omitted the masthead and did not establish whole-screen 1:1 fidelity. The user correctly identified the usage block's misplaced position. Both usage and global actions had automatic left margins, sharing the empty space: at 1512px the gap after usage was 245.02px instead of the reference's 30px. Desktop actions now have zero left margin; mobile actions retain automatic alignment when usage occupies its own row. Masthead line height, padding and brand wrapping now follow the reference breakpoints.

Browser checks passed at 320, 414, 768, 1000, 1001, 1100, 1264, 1512 and 2560px, including zero/unavailable quotas and navigating to Settings. No page overflow or JavaScript errors. CSS review found no concrete regression. Header evidence: `/tmp/mc-header-check.mjs`, `/tmp/mc-header-final.log`, `/tmp/mc-header-before.png`, `/tmp/mc-header-after.png`, `/tmp/mc-header-reference.png`.

Remaining differences are explicit: the application retains New job and Review, while the design contains Settings and a preview-only Previous sketch link. At 1512px that leaves the corrected usage block 23.48px left of the reference. The wide application also retains the user's requested full-width masthead instead of the mockup's 1512px cap. These differences mean the whole header is not an exact 1:1 copy.

The approved source is `visualizer/ui-overhaul/terminal-components.html`. The current terminal implementation replaces the control, pane-header, session-tab, flow and agent-card composition. `client/terminal-view.ts` upgrades the running server's markup and loads `public/terminal-design.css`; these frontend changes do not require a server restart. Earlier visual-completion claims below were rejected by the user and are superseded by this section.

At a 1512px browser viewport, the reference and implementation have matching measurements:

| Component | Reference | Implementation |
|---|---:|---:|
| Workspace heading top | 217px | 217px |
| Agent band top / card height | 259px / 130.59px | 259px / 130.59px |
| Terminal deck top / height | 413.59px / 407px | 413.59px / 407px |
| Pane heading top / content width | 436.59px / 678px | 436.59px / 678px |
| Pane metadata top / height | 512.78px / 27px | 512.78px / 27px |
| Session strip top / height | 835.59px / 49px | 835.59px / 49px |

The user's later full-width and all-active-agent requirements remain: two cards fit beside the flow at ordinary desktop widths; wide screens use both side rails. Eight active conversations were exercised, with a ninth belonging to another terminal excluded. Smaller screens wrap the cards and retain scrolling for long flows. Native xterm content is the explicitly accepted visual exception. Captions and connection state use reported session data; an unavailable model is not invented.

Manual plans retain their step titles, array order and states in a stable first/interior/last composition. This is a phase overview, not a scheduler dependency graph. Automatic flows use Direction, one branch per distinct scoped conversation, and Your review; replies and automatic reviews stay within their conversation. Human review state comes from actual reviewable artifacts and acknowledgments. Finishing work no longer rearranges the branches.

Verification:

- Full suite: 797 passed, 0 failed across 49 files. After the final four-pane arrangement correction, 77 focused tests passed, including its additional regression.
- Isolated headless browser: 320, 414, 800, 1000, 1264, 1512, 2560 and 3840px; no page overflow or JavaScript errors.
- Exercised one/two/eight agents, collapse preservation, ownership filtering, queued/completed automatic work, unchanged branch identity, 32-step scrolling, feed failure/recovery, repeated empty polling, focus/restore, two/four-pane arrangement, resizing, repeated persisted renames including changing back, directories, New terminal/Cancel and opening the agent drawer.
- Start-session center differs from the deck center by 0px horizontally and 0.008px vertically.
- Live read-only API check returned zero terminal sessions and 392 jobs. Interactive terminal verification therefore used isolated API/terminal-stream fixtures; no user terminal connection was attached, resized or created.
- Existing review findings concerning stale empty-flow observers, accessible status, stale rename metadata and hidden tool errors were corrected and covered by checks.

Local evidence: `/tmp/mc-fidelity-check.mjs`, `/tmp/mc-fidelity-extra-check.mjs`, `/tmp/mc-fidelity-check.log`, `/tmp/mc-fidelity-extra-check.log`, `/tmp/mc-fidelity-1512.png`, `/tmp/mc-fidelity-eight-agents.png`, `/tmp/mc-fidelity-reference-match.png`, `/tmp/mc-reference-current.png`. Screenshots with terminal output use verification data. No restart, commit or push was performed.

---

# Verification corrections before activation

## Final verification — 2026-09-08

All findings recorded below are resolved. The earlier sections retain the observed failures and acceptance criteria; they no longer describe outstanding work. This result supersedes the intermediate worker readiness/completion reports.

- `bun test`: **769 passed, 0 failed**, across 48 files in 30.61 seconds. Existing terminal tests use isolated fake engines/local shell fixtures. No live AI turn or user terminal was created by verification.
- `bun scripts/render-ui-preview.ts`: all 22 browser bundles and actual preview templates rebuilt successfully. `git diff --check` passed.
- Browser checks passed across 1512/1000/768/700/414/375/320px: rendered layout, terminal controls and connection state, persistent terminal DOM/sockets through navigation, draft preservation, create/reply workflows, deep links, directory toggling, flow stages/grouping/archive filtering, mini-feed lifecycle, error/empty recovery, usage availability and correct member review targets. Job creation was also verified through the real API and disk persistence in an isolated test backend.
- Final raw-output regression reproduced before the patch: an open stream stayed on the previous job after a reply. The stream now switches to the latest job, closes the previous source, ignores late events and stays closed when the user closes it. Its unit regression and browser scenario passed; focused TypeScript review found no remaining issue.
- Actual desktop/mobile captures were compared with the approved uniform-usage design. Terminal panels fit above the session controls, mobile footer stays below output, and the complete agent window fits at 320px.
- The live supported Codex collector returned weekly usage of 13% with no five-hour window. Missing five-hour and unsupported GLM weekly windows remain unavailable. Fresh Claude cache limits remain visible when separate cost collection fails.

Implementation is ready in the shared checkout and generated preview. Activation is pending approval: the running server still has the earlier views/backend loaded, and its two live terminal sessions would close on restart. No restart, commit, branch or push was performed.

## Resolved findings and original acceptance criteria

The first production frontend pass renders and core browser actions pass. Finish these concrete corrections, then connect quotas using ui-overhaul-quota.md. The approved design remains terminal-components.html; no new design direction.

## Functional review findings

1. client/work.ts reply submission keeps the input editable, then unconditionally clears it and its saved draft on success. The TypeScript reviewer executed the actual handler with a deferred inert response and demonstrated loss of newer unsent edits. Snapshot the submitted value, clear only unchanged input/storage, and retain pending state per thread across switching away/back. Job creation has the same form.reset/draft-removal race: preserve later edits or disable the submitted form while pending, with proper restoration on failure. Add deferred-response checks for both.
2. client/terminal.ts refresh calls can overlap (interval versus mutation). An older response can remove/dispose a newly created terminal. Ignore stale response generations before changing sessions/DOM/sockets. Add an out-of-order response check.
3. client/awareness.ts resets selected flow/agent on every mc:terminal-scope event, but terminal refresh emits the unchanged scope every 10 seconds. Reset only for a changed id/cwd. Existing mini feed stops polling at completion or failed fetch; when replying through the drawer creates another job in the same thread, its unchanged ID prevents feed restart. Refresh/restart the existing feed on relevant metadata updates and recover failed fetches. Preserve selection across same-scope refreshes, and test completed-to-running same-thread updates.
4. Cockpit review also found client/workspace.ts cached views and terminal forms never refresh their server-rendered engine/model defaults after Settings saves. Subsequent jobs/terminals may use old settings until a full reload. Reuse the existing settings save/role/model paths to update cached form choices/defaults after successful saves, without destroying live terminals or changing an in-progress user draft. Add a focused saved-settings refresh check; do not save the user's real settings during tests.

Parent browser reproduced findings 1 and 3 after review: /tmp/mission-control-overhaul-check.mjs --workflows fails because a successful reply clears text typed during its deferred response; /tmp/mc-awareness-check.mjs reports feedResumed:false and selectionRetained:false. The latter supports --strict-lifecycle for the post-fix check. These are observed failures, not hypothetical.

## Existing automatic flow compatibility

Additional source comparison found data being dropped by the new rendering. Preserve this existing functionality before calling the overhaul complete:

- server/flow.ts still emits spec, impl, codex, verify, merged stage tuples (state plus detail) by session label. Original client/flow.ts parseStages + setSession used these whenever no manual plan existed. buildWork currently discards them and awareness substitutes job labels. Carry the existing stage snapshot through and display it in the approved flow nodes when no manual plan is present. Reuse STAGES and existing stage labels/spec helpers from plan-view.ts; preserve queued/error/active/done/future status and detail. Do not alter backend role derivation or invent a new flow schema.
- Separate implementation/review threads may share a flow label. Preserve the backend label-level flow identity/snapshot in the awareness selector while retaining separate conversation choices. Do not duplicate the newest thread's currentActivity onto unrelated older threads. Keep actual terminal/cwd scoping.
- Fetch flow includeArchived=1 for metadata, propagate archived state to all matching jobs/threads, and exclude archived flow groups from the normal awareness selector. The current flow endpoint excludes archived labels but the all-jobs response reintroduces those jobs as unarchived. Work view retains Archive/Restore access.
- Preserve manual plan.next in the awareness area when provided.

Add focused coverage for automatic stages without a manual plan, two threads sharing a flow label, archived jobs excluded from awareness, and manual-plan precedence. Parent will render and exercise those cases with fixtures. This restores real data the previous UI already supported; it is not a new design/feature.

## Follow-up evidence after the first corrections

The updated parent browser checks now pass reply/create pending-edit preservation, selected conversation retention and completed-feed resume. `node /tmp/mc-awareness-check.mjs --strict-lifecycle --automatic-flow` passes the lifecycle checks but times out waiting for existing automatic stage text; this confirms the stage loss above.

Two additional concrete issues remain in the current intermediate snapshot:

- Desktop rich screenshot shows the right terminal covering part of New terminal/Resume in the bottom strip. Mobile screenshot shows the motion/footer text over terminal output. Replacing mockup `.terminal` with `.terminal-panel` retained fixed 405px / 450px heights (public/theme.css around lines 868/871), while the actual deck is allocated a smaller flex/grid area and panels use overflow:visible. Remove those static mockup heights and size panels to their real grid cells; allow the mobile workspace to scroll vertically while its footer and session strip remain in normal flow. Verify panel bounds do not extend into the strip/footer, stacked splits both fit, and New terminal is fully visible/clickable. Do not hide the controls to conceal overlap.
- Fresh Claude cache plus unavailable ccusage currently returns available:false with actual cached percentages, and normalizeUsage discards those percentages. Parent ran fetchClaudeQuota with an injected unavailable command runner plus fresh 34/51-percent cache, then normalizeUsage: both shown percentages were null. Keep cost/estimate availability separate from verified cached limit availability so fresh limits remain visible even if cost collection fails. Do not invent zero tokens/costs or claim authentication failed. Add a deterministic check spanning collector + normalizer for this combination.

The completed second cockpit review found two additional bounded navigation defects:

- client/work.ts initial paint() runs with empty items and overwrites the requested ?job= selection before the first fetch. Open work links can show the newest job instead of the requested conversation. Preserve the requested ID until data has loaded; distinguish initial loading from a real empty/filter result. Verify a deep link to an older thread while a newer unrelated thread exists.
- client/terminal.ts uses the mobile Directories toggle through 760px, but CSS hides a closed mobile directory panel only below 601px. At 601–760px a second toggle leaves hidden=false and the directory panel stays open. Use one consistent breakpoint/hidden-state rule; verify open and close at 700px and after resizing to desktop. Do not affect directory selection or other terminal state.

## Browser evidence and visual corrections

Parent ran /tmp/mission-control-overhaul-check.mjs: assets, no outer overflow at 1512/768/414/375/320, split/focus/mobile selection, DOM/socket persistence through navigation, reconnect, double-click rename/save, New job creation via isolated real API and disk persistence, composer reopen/draft retention, reply focus during polling all passed. Rich fixture /tmp/mc-awareness-check.mjs also passed terminal-scoped flow selection, mini feed/drawer, honest missing usage windows, error/recovery, plan-only state, and review targeting the older changed member. These used real templates/client bundles; fixture jobs/terminals avoided touching live sessions. Parent owns browser scripts/captures.

Inspect /tmp/mc-app-rich-desktop.png and /tmp/mc-app-rich-mobile.png against /tmp/mc-uniform-usage.png (approved). Actual captures use a device scale factor; compare CSS geometry, not raw image pixel size. Remaining visual defects:

- At 320px the agent window and flow contents are clipped off the right, even though document overflow reports zero. Make the awareness grid/flex children shrink to available width (min-width:0), keep only the long flow itself scrollable, and ensure the entire agent window fits. The heading's square also wraps above Terminals; keep that heading together.
- The flow currently has tiny disconnected line stubs and a large empty gap between steps. Make sequential plan nodes actually connected with thin flexible lines; data has ordered manual steps, so do not invent parallel dependencies. Active node currently has both a triangle glyph and an extra dot below it: use the approved single centered active dot. Retain appropriate status/assignee color and motion pause/reduced-motion.
- The mini-agent window has two redundant full-conversation affordances and an oversized monospaced one-line feed. Reuse createMiniFeed but style the window at the approved density, allow a useful 2–3-line excerpt, hide its redundant internal open/footer when the outer Open conversation action exists. Add the approved activity bars driven by real running state. Keep full drawer reachable once, and handle empty/error/completed states.
- Copied mockup `.terminal` styles also match xterm's own `.terminal` class, introducing a duplicate tinted rule/black band and padding above its output. Scope/remove static-only mockup selectors so they cannot style xterm internals. Keep approved styling on `.terminal-panel`; retain real xterm sizing, background, input and scroll.
- Restore approved primary navigation order/names Main, Terminals, Usage. Existing New job/Review/Settings remain accessible in the compact secondary controls/work view. No old permanent sidebar in the Terminals view.
- In the rich screenshot, active Terminal layout is selected but global status still says Connected · Review pass. Ensure displayed connection feedback refers to the selected session; do not report another session's status.

Do not restart or activate the app; two live terminal sessions remain. Finish current preview via scripts/render-ui-preview.ts. Parent will rerun changed paths and visually inspect. Preserve all previous useful behavior, no visualizer edits, no commits or branches.

Tests may use isolated inert processes and temporary directories. Existing terminal integration tests are allowed only after confirming they use isolated local shell/echo fixtures and do not launch a real AI model, touch the live terminal manager, or modify user configuration. Do not interpret the prior no-live-PTY constraint as prohibiting safe isolated shell tests. Run focused checks during iteration, then the full safe suite once at completion.

Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
