# Verification corrections and quota integration

Implementation is current in the shared main tree. The approved visualizer was read and preserved. Compared the parent captures `/tmp/mc-app-rich-desktop.png` and `/tmp/mc-app-rich-mobile.png` with `/tmp/mc-uniform-usage.png`. No browser automation, screenshots, app restart, real AI turn, dispatch, branch, commit, push, or credential edits were performed.

## Delivered

- Reply submission snapshots its text, preserves newer input and storage independently, and tracks pending replies by thread through switching away/back. Successful job creation resets only an unchanged form and removes only unchanged saved storage.
- Terminal refresh generations reject stale responses before session/DOM/socket mutations. Connection feedback follows the selected session, including selection changes and late socket events.
- Awareness retains flow/agent selections on unchanged terminal scope. Existing mini feeds refresh on metadata updates, resume on another turn in the same thread, serialize their fetches, and retry failures.
- Settings saves signal the persistent workspace and cached frames. Model pickers read the existing roles/models endpoints, refresh choices and future reset defaults, and preserve current fields when the form contains a draft. Live terminals remain mounted.
- Awareness children can shrink at mobile widths; only the ordered flow scrolls. Flexible sequential connectors reach the next node, and active nodes have one centered dot. The mini window uses multiline excerpts, one conversation action, real running-state activity bars, and explicit empty/error states. Static terminal mock selectors no longer match xterm internals. Primary navigation is Main, Terminals, Usage.
- Codex uses the supported app-server initialization handshake followed by account/rateLimits/read. The collector filters matching IDs, handles split stdout chunks and unrelated notifications, rejects unrelated limit buckets, validates percentages and Unix reset times, bounds the read to four seconds, discards stderr, and closes/kills only its spawned child. Login status remains independent of source failure.
- Claude optionally enriches the existing ccusage accounting with the already-existing ccstatusline cache, accepting mtime age <=180 seconds and rejecting future mtimes. Cache source/observation time is displayed in the usage tooltip. Cache-only success leaves unavailable accounting null. Missing/stale/unreadable cache preserves the labelled estimate. GLM monthly accounting and the existing 60-second route cache remain intact.

## Exact checks

- `bun test test/work-client.test.ts test/terminal-client.test.ts test/awareness.test.ts test/provider-usage.test.ts test/quota.test.ts`: initial focused run exposed the old expectation of raw Codex CLI errors; updated that expectation to the sanitized response.
- `bun test test/quota-sources.test.ts test/quota.test.ts test/work-client.test.ts test/terminal-client.test.ts`: exercised the new transport and deferred handlers; corrected the connection test fixture to open its second session first.
- `bun test test/work-client.test.ts test/terminal-client.test.ts`: deferred reply fixture required the DOM double's existing-feed remove operation; corrected the fixture. Final work-only run: 6 passed.
- `bun test test/awareness-client.test.ts test/settings-refresh.test.ts test/thread-view.test.ts test/views.test.ts test/model-picker.test.ts`: 87 passed.
- `bun test test/awareness-client.test.ts test/settings-refresh.test.ts test/thread-view.test.ts test/quota-sources.test.ts test/quota.test.ts test/model-picker.test.ts test/work-client.test.ts test/terminal-client.test.ts`: 126 passed. Log: `/tmp/mc-focused-checks.log`.
- Full suite, once: `bun test --preload /tmp/mc-safe-home-preload.ts`: 760 passed, 1 failed, 761 tests across 48 files. Log: `/tmp/mc-full-suite.log`. The temporary preload mocks `node:os.homedir()` into a disposable directory because the existing test preload's runtime HOME assignment does not isolate Bun's homedir calls. Existing terminal tests use MC_FAKE_ENGINES, temporary config directories, their own registries, and local shell fixtures.
- The sole full-suite failure was test/terminals.test.ts's cwd equality: the temporary home used `/var/...`, while terminal creation canonicalized it to `/private/var/...`. Canonicalized only the temporary preload with realpathSync, then ran `bun test --preload /tmp/mc-safe-home-preload.ts test/terminals.test.ts --test-name-pattern 'spawns, echoes'`: 1 passed, 18 skipped. No product/test-file change was needed for that failure; the full suite was not repeated.
- Final additional calendar validation and cache-only accounting checks: `bun test test/quota-sources.test.ts test/thread-view.test.ts`: 60 passed. Log: `/tmp/mc-final-focused.log`.
- `bun scripts/render-ui-preview.ts`: actual view templates and all 22 browser bundles rebuilt successfully to public/ui-preview. Preview is current at `/ui-preview/terminals.html` on the existing server.
- `git diff --check`: passed.

## Files changed by this worker

- Frontend: client/awareness.ts, client/forms.ts, client/model-picker.ts, client/provider-usage.ts, client/terminal.ts, client/thread-view.ts, client/work.ts, client/workspace.ts.
- Views/styles: server/views/layout.tsx, server/views/terminals.tsx, public/theme.css.
- Quota: server/quota.ts, new server/codex-limits.ts.
- Tests: test/awareness-client.test.ts, test/settings-refresh.test.ts, test/quota-sources.test.ts, test/quota.test.ts, test/thread-view.test.ts, test/work-client.test.ts, test/terminal-client.test.ts.
- This decision record and generated public/ui-preview artifacts. scripts/render-ui-preview.ts was executed unchanged. Other pre-existing dirty files remain outside this worker's edits.

## Parent validation remaining

Parent owns the browser rerun and visual acceptance, including the 320px awareness bounds, ordered connectors, terminal output band, saved-settings workflow, and strict same-thread awareness lifecycle. The live quota collector was not invoked by this worker; all new quota tests inject transport, files, and time. Parent's verified Codex source previously had only a weekly window: missing 5h remains unavailable. GLM has no verified weekly window and remains unavailable there. Claude cache availability depends on the existing producer's freshness; otherwise ccusage remains an estimate without a fabricated weekly value.
