# Quiet chat preview

One small direction based on the user's chat screenshots and latest neumorphic component reference: a full-screen pale surface, rounded controls, generous spacing, and a bottom composer. The purple surround and outer frame are removed. Buttons, chat rows, and the welcome mark are softly raised; inputs and pressed buttons are recessed. Lavender accents replace the previous gray/green details. Hard outlines are removed from resting surfaces. Input focus uses a subtle background change without borders or outlines; buttons retain a keyboard focus indicator. The outer canvas stays flat. Helvetica Neue reuses the existing UI font. Local colors deliberately replace the app's dark palette, as requested.

This design now includes an opt-in **real Claude Code terminal**. Terminal creation and keystrokes use the existing Mission Control HTTP/WebSocket endpoints, local-access guard, cwd validation, engine environment, and configured default workflow. The loopback workspace signs in automatically without asking for a password. Opening the terminal starts a real local process; commands typed there can perform real work. The live view keeps Agents and Flow available in the shared header. Their live contents come from the existing Mission Control jobs and flow endpoints; sample activity is hidden.

Chat, replies, agents, flow steps, Studio, and Access outside the live terminal remain sample UI. They do not operate on the real session. This is the first working slice, not a complete replacement of the live app. No existing server routes or terminal behavior were changed.

## View

Open http://127.0.0.1:51947/ while the local workspace server is running. No password is required on this address.

From the repository root:

`npm exec --yes --package=vite@8.3.0 -- vite docs/design/quiet-chat --host 127.0.0.1 --port 51947 --strictPort`

This uses the MIT-licensed Vite 8.3.0 server for HTML/CSS live reload and its HTTP/WebSocket proxy to the existing app on 127.0.0.1:7777. Vite is run from the npm cache; no application dependency is added. Install the repository dependencies with `bun install` first. The visualizer skill's usual alternative layouts and current-state comparison are omitted to follow the user's request to start small with this specific direction.

## Build the working terminal view

From the repository root, with the existing Mission Control server running on port 7777:

`VITE_WORKSPACE_DIR="$PWD" npm exec --yes --package=vite@8.3.0 -- vite build docs/design/quiet-chat --base=/quiet-chat/ --outDir ../../public/quiet-chat`

The generated assets are ignored by Git and served by the existing app. The preferred working address is http://127.0.0.1:51947/. Old links under port 7777 redirect to the local workspace when they need a session, retaining the terminal ID. The password form has been removed. The live module is lazy-loaded, uses the already-installed MIT-licensed xterm.js 6 and FitAddon, and follows its [official addon integration](https://xtermjs.org/docs/guides/using-addons/). Existing `client/shared.ts` supplies HTTP handling.

`vite.config.js` uses Vite's [native middleware and proxy capabilities](https://vite.dev/guide/api-plugin.html#configureserver); Mission Control itself serves loopback requests without a session since the local-access guard replaced the password. The listener binds only 127.0.0.1:51947 and checks the actual socket peer, exact Host, Origin, and Fetch Metadata; unrelated sites, embedded pages, rebinding hosts, and foreign WebSocket origins are rejected. Terminal API/socket paths and exact jobs, flow, models, roles, and workflow-list endpoints are proxied. Those list/metadata endpoints accept GET only; write requests return 405. This avoids restarting the app and losing its in-memory terminal registry.

This local development entry requires the existing configured Mission Control instance. It does not change global authentication policy or remove stored credentials from that instance.

The working-directory default is baked from `VITE_WORKSPACE_DIR` at build time and remains editable. The compact shared header stays visible in the live view, and Reconnect appears only after disconnection. One terminal ID is remembered locally; returning to the design or reloading reconnects without creating a second process. Failed starts, expired local access, disconnects, and ended sessions have visible states. Close the session with `/exit` inside Claude Code. Closing the browser only detaches it.

## Try

- New chat → Claude Code opens the real terminal launcher with automatic local access. It selects an engine, model, workflow, and directory. Resume and Running options are omitted at the user’s request; reload and direct session links still reconnect. There is no separate Terminal tab or welcome-screen launch button.
- In Claude Code, Agents shows linked running/queued jobs, provider, and latest reported activity. Above 600px it occupies a second workspace column and reduces the chat/terminal width, with no outer frame, backdrop, or focus trap. On mobile it becomes a right-hand modal drawer, preserving the full chat width underneath and using the existing dimmed backdrop. An open panel switches modes when the viewport crosses the breakpoint. Its header button toggles it; the close button or Escape within the panel dismisses it. Flow expands above the terminal without opening a modal or drawing an outer frame. The terminal resizes to the remaining space.
- Live activity refreshes every three seconds while either panel is open and the document is visible. Existing `client/awareness.ts` and `client/work.ts` helpers supply session scoping, grouping, and flow steps. Explicit terminal IDs take precedence; legacy jobs without an ID use the existing working-directory fallback. Failed reads clear stale content and show a retry message.
- Opening Claude Code alone does not create a Mission Control job or flow. Empty states are expected until linked work is reported. Native Claude subagents that are not registered as Mission Control jobs are not listed. The live drawer shows activity summaries; full agent transcripts and replies are not connected here.
- New chat → Chat returns to the quiet sample conversation screen. The native popover dismisses on outside click or Escape and returns keyboard focus to its trigger.
- Search or the history icon shows three sample conversations. Search filters the list.
- Continue “Simplify the terminal page” to inspect its conversation, agent drawer, and inline flow. Flow expands below the toolbar without blocking chat.
- The plus button opens minimal project/engine settings.
- Typing and sending only demonstrates the conversation layout with a canned reply.
- Agent replies only display locally. Escape or the close control dismisses dialogs; Flow has its own collapse button.
- Studio keeps the live app’s description-first start and graph/editor arrangement, restyled with the same surfaces. Default/template/scratch starts, step editing, adding/removing steps, and a sample AI change work locally. Its graph is a static linear demonstration; dragging, branching, execution, and persistence are not connected.
- Back to chat preserves the conversation and unsent message. Switching back to Studio preserves the current editor state until another template is opened or the page reloads.
- Manage AIs proposes one place for connections, role/model defaults, automatic review, and built-in GLM configuration. The live Settings page still owns some of these controls: it cannot be removed until those are migrated in production.
- Access is a separate lock control for network/API access. Its address is an example; no token is read and token actions are disabled.
- Buttons, view changes, Flow expansion, and dialog opening/closing use short native CSS transitions. Reduced-motion preferences disable animation.

The separate Main page, permanent sidebar, suggestion cards, quota bars, and terminal toolbars are absent from this proposal. Existing production behavior remains unchanged. The raw Claude Code terminal and its Mission Control agent/flow summaries are connected. The redesigned chat transcript, full agent conversations/replies, and Studio still need wiring in a production implementation; this preview does not delete their capabilities.

## Source files inspected

- `server/views/terminals.tsx`: current terminal page, session creation, agent sidebar, and flow region.
- `server/views/layout.tsx`: current Main navigation and shared drawer.
- `client/terminal.ts`: terminal/transcript modes and session lifecycle.
- `client/transcript-view.ts`: conversation and composer behavior.
- `client/thread-drawer.ts`: agent conversation and replies.
- `client/awareness.ts`: terminal-scoped active agents and flow steps.
- `client/flow.ts`: flow visualization.
- `client/studio.tsx`, `client/studio-ui.tsx`, and `public/studio.css`: description-first start, editor, and inspector layout.
- `client/studio-settings.tsx`: AI connection management.
- `server/views/settings.tsx`: role defaults, automatic review, built-in credentials, and Access controls.
- `public/theme-tokens.css`: existing font and theme tokens.

## Reuse research

Native HTML [dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) supplies modal focus behavior and Escape dismissal. Native details supplies expandable history and agent entries. CSS transitions and [reduced-motion media queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion) cover the requested motion without an animation dependency. The [live-server candidate](https://github.com/tapio/live-server) would add a redundant tool; Vite already supplies live reload. Development used the adjacent Studio prototype’s Vite install; the commands above also work without that untracked prototype. A UI framework or graph dependency adds no value to these static sample states. Custom code is limited to the reference layout and local state changes.

Inset neumorphism now imports [Neumo UI](https://github.com/jsanchez91/neumo-ui), as requested. `vendor/neumo-ui.css` is the unchanged 5,094-byte compiled stylesheet from version 1.0.0, commit `9525c8b3739becd298547fda2499506cfca363d2`. The original MIT license is retained in `vendor/neumo-ui-LICENSE`. The inspected upstream commit is dated 2025-09-12; this is a small experimental candidate, not a claim of active maintenance.

The composer uses its `.nui-neuromorphic-inset` class directly; other controls reuse its derived outer-shadow and inset-shadow variables. The import lives in the `neumo` cascade layer so our layout and focus styles take precedence. Explicit light colors avoid depending on its automatic `light-dark()` theme support. The global reset, body font, and dialog centering were checked and adapted. No upstream JavaScript, build scripts, native-control overrides, CDN runtime requests, or framework migration are involved. Text colors retain contrast against the pale lilac surface. The outer canvas remains flat.

## Verification

`node docs/design/quiet-chat/check.mjs`

The runnable check covers welcome, history filtering, conversation, agent replies, non-modal Flow, text escaping, dialog dismissal/focus return, Studio editing and draft retention, Access, reduced motion, and fullscreen/overflow/composer geometry at 1512, 1024, 768, 390, and 320 pixels. It also rejects unexpected API requests and browser errors. Generated screenshots are local-only in the ignored `screenshots/` directory; desktop welcome, Studio home/editor, inline Flow, and mobile Studio/Flow were visually reviewed. These checks cover only this static preview.


`node docs/design/quiet-chat/check-live.mjs`

This browser check uses fixture HTTP/WebSocket transport to verify password-free launch, invalid-directory recovery, terminal creation/input/output, fitting, session reuse on return/reload, and mobile geometry without starting a CLI. It also verifies live agent/flow empty states, active work, exclusion of another terminal’s jobs, failure recovery, hidden sample content, non-modal Flow, and terminal input after opening the panels. Separately, a real Claude Code session was launched through the built page on the existing server and visually checked at its prompt. No task was submitted to Claude. The live screenshot is `screenshots/live-claude.png`.

The compact layout keeps the header on one row down to 320px. Studio, Agents, Flow, and Access use matching raised controls; icon-only controls have accessible labels. Welcome typography, the composer, workflow starter cards, and terminal framing were reduced. Browser checks cover dropdown dismissal/focus, both choices, and reconnecting the existing Claude session without spawning another.


`bun test docs/design/quiet-chat/local-access.test.ts`

Covers trusted local requests, genuine top-level navigation, remote peers, rebinding hosts, foreign origins, embedded pages, and cross-site API requests. A fresh browser with no supplied credentials was also verified against the real existing Claude session through the old link and local redirect; no replacement process or prompt was created. Actual rejected HTTP requests returned 403 without setting a session cookie.

The Agents/Flow disappearance was caused by live-mode CSS hiding their controls and the entire flow region. Those exclusions were removed, and the live activity renderer now replaces sample content in that mode. A fresh browser reattached to the existing real Claude session without supplied credentials: both activity endpoints returned 200, Agents showed no linked active jobs, Flow showed no linked work, and the terminal remained connected. No new terminal or Claude task was started. Actual screenshots: `screenshots/live-agents-real.png` and `screenshots/live-activity-real.png`; the `*-fixture.png` screenshots use test data.

`bun test test/awareness.test.ts docs/design/quiet-chat/local-access.test.ts`

The shared scoping/flow rules and local request gate passed nine tests with 53 assertions. The local proxy also rejected an actual POST to `/api/jobs` with 405.

The side-panel regression checks verify that chat remains editable, Agents stays outside the modal layer on desktop and its bounds do not overlap the chat/terminal. Mobile uses a modal drawer while preserving full chat width; resizing an open panel switches modes. Terminal fixture input is sent while Agents remains open. Flow’s outer box shadow is checked to be absent. The existing terminal ResizeObserver handles the column transition without replacing the process.

The original launcher comparison found missing engine/model selection, workflow selection, recent directories, and Claude history/resume, plus an unintended restriction to one remembered terminal. Engine/model, workflow, and recent-directory selection are now restored using existing APIs and native selects/datalists. Resume and Running were removed at the user’s request. The planning role supplies defaults, model suggestions come from `/api/models`, and custom model IDs remain editable. Recent directories combine local history with running-session directories; browser storage remains separate across ports. Fixture checks cover creating another terminal with a chosen model and workflow revision, metadata failure/retry, and reload without duplication. No CLI is spawned by these tests.
