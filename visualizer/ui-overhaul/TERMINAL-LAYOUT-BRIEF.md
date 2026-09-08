# Terminal layout — first shared design sketch

Status: design exploration only. No layout or palette has final approval.

Latest feedback: the user likes the layout idea and where everything sits, but rejected the visual treatment as generic and said the liked ASCII banner was lost. Keep the composition; continue exploring appearance. The current live iteration exposes the original wave equations in a visible top band, removes the enclosing frame and lavender header blocks, and uses smaller terminal headers with a blue active cue. The previous surface treatment is preserved in `terminal-layout-before-surface.html`. These visual changes are proposals, not a signed-off design.

Verification: exercised split/focus/restore, pointer and keyboard resizing, preservation of commands and chat drafts, sends and empty states, no-agent sessions, supplementary sheets, reduced motion, and widths 320/375/414/768/1000 in actual Arc. Confirmed rendered canvas frames advance, pause, and resume with Arc foregrounded. Corrected keyboard focus after session selection and minimum stacked pane size. Standalone preview only; no production files or backend behavior changed.

## Agreed direction

The user spends about 80% of their time in Terminals, then Main for flow and usage across models, then Settings. They work in multiple terminals and want both split and focused views. Keep the liked flowing ASCII atmosphere. Preserve interactive agent working chat. They want an entirely new interface and colour identity, not the old page with new styling. Backend behavior remains the eventual implementation constraint. This stage is one static, interactive design sketch to discuss together.

## Scope

Create `visualizer/ui-overhaul/terminal-layout.html`, one standalone HTML file with inline CSS/JS and sample data. Optional local Anime.js asset plus its license under `vendor/`. Add one concise browser check at `evidence/terminal-layout-verify.cjs`. Do not modify old previews, production code, server, dependency files, or other briefs. No commit, branch, service restart, backend calls, or persistence.

## Composition to test

- Actual Arc viewport is 1512×909. Compose for it first. A slim outer header and a large workspace float over the existing ASCII wave; leave enough background visible around the edges and below the workspace. Avoid a large brand hero or marketing text.
- Terminal workspace occupies the centre. Default two equally useful side-by-side terminals, plus a 290–310px agent conversation attached to the right. Chat can close, returning that width to terminals. This is a first composition, not a commitment to permanent three-column UI.
- Each terminal has one compact header: session name, engine/model, activity, focus action. Put path in a quiet line within terminal content. Active pane has an unmistakable pale periwinkle header/accent; inactive pane stays quiet. Clicking into another pane changes the active cue and its associated agent chat.
- Session switcher sits BELOW the terminals, distinct from the old top tab arrangement. Show three existing sample sessions and a New terminal action. Replacing a pane's session must not erase its transcript or draft. Closing a split keeps its session in the switcher.
- Outer header keeps Main and Usage within reach, with Settings at the edge. Main/Usage reveals a compact supplementary sheet while the terminal context remains apparent. Show a manual task plan with sensible task steps, and per-engine usage. No wiring of engines into a workflow. Do not imply automatic plan execution.
- Keep text economical but useful: real-looking terminal output, command input, agent progress with an expandable tool result, a working chat composer. No mock OS traffic lights, fake IDE window, lorem ipsum, promotional claims, or explanatory feature-tour copy. One small Sample preview label is sufficient.

## Working design interactions

- Two panes can be split side-by-side or stacked; draggable divider and keyboard-adjustable separator.
- Focus any pane and return to the exact previous layout and divider ratio. Closing a split never terminates the sample session. Motion should make this spatially understandable, with a subtle perspective settle rather than a spinning decorative object.
- Selecting a terminal follows its agent conversation and preserves drafts. Chat open/close visibly adjusts the workspace. Send appends a simulated conversation response; empty send gives explicit inline feedback. No real execution. Terminal command input is separately labelled and simulated.
- Session switching and creating one new named sample terminal work locally. Include an empty terminal and a session with no associated agent so the design can be inspected in those states.
- Main/Usage sheet and Settings preview open and close, support Escape, and return focus. Keep Settings small: show existing Plan/Execute/Review engine/model selection concepts plus a local motion control, with an explicit sample-only note. Do not build the rest of the app.
- Background pause/resume and OS reduced-motion preference cover all animations. Under reduced motion draw a still frame. Keep the original wave's shape from `motion-before.html`; no ASCII core, hub, or engine connections.

## Visual proposal, deliberately provisional

New identity for this sketch: midnight plum/ink, a pale periwinkle active terminal header, sky-blue interaction accent, restrained apricot attention. Use named CSS tokens: background #0b0b13, surface #171621, raised #21202d, text #eeeaf6, muted #aaa5bc, line #373243, periwinkle #bcb4ed, sky #9ecff5, apricot #efb494, mint #acd5c0. Text on the periwinkle header uses background colour. This replaces the rejected black/grey/orange palette in this preview only. All text must remain readable; terminal text 13–14px with room to breathe.

Use Avenir Next for interface text, Menlo for actual terminal/code. Avoid shouty uppercase micro-labels and decorative numbered sections. Surfaces distinguish actual terminal panes and chat, not a dashboard of unrelated cards. Preserve the wave's neutral grey glyphs on the new background; keep glyphs behind solid reading surfaces. No gradients or glow needed. Fonts use local fallbacks, no downloads.

At small widths stack panes and move chat below or open it as a dismissible sheet. No page-level horizontal overflow at 320/375/414/768/1000px. Keep controls operable and text legible. Buttons have accessible names and visible focus.

## Evidence and source boundaries

Existing terminal create/resume/find/session management: `client/terminal.ts`, `server/views/terminals.tsx`, `server/routes/terminals.ts`. Existing structured agent conversation, tools, waiting state and replies: `client/thread-view.ts`, `client/thread-drawer.ts`. Main/plan data: `server/routes/flow.ts`. Usage contracts: `server/routes/quota.ts`. Reuse those concepts; the new composition is intentionally different.

Usage is heterogeneous: Claude provides cost/tokens/reset, GLM quota percentage, Codex availability. Do not invent a cross-provider percentage or a complete total dollar amount. Show unavailable totals honestly alongside labelled sample per-provider values.

The preview server is already running at 127.0.0.1:47831; `/fingerprint.js` is a TEXT response, not a JavaScript dependency. Actual Arc is connected via CDP at 127.0.0.1:9222. Installed Playwright is `/Users/lynchz/.npm/_npx/9833c18b2d85bc59/node_modules/playwright`. Use `connectOverCDP` with `noDefaults:true`; never launch/close the user's browser or inspect unrelated tabs. Only use the new preview page for verification. The parent handles opening Arc and visual review, so do not compete for browser focus.

Verify syntax plus the meaningful interactions and empty states using one runnable browser check. No production full suite is relevant to standalone HTML. Stop once this one design sketch is ready for the user's critique. Do not expand into a full frontend build.
