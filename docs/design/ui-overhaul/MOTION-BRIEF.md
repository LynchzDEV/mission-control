# Mission Control — live motion study

## Latest correction — preserve the working app

The user clarified that the core's appearance is wrong, and that engines wired as a hub do not represent a workflow. The off-centre workspace placement is acceptable and is not a bug to fix. Remove the decorative core/engine network. Keep the liked flowing ASCII field. Any workflow representation belongs to a selected task and follows its ordered plan steps, with assignees attached to steps, never a permanent engine-to-engine topology. No new standalone signature graphic in this pass.

### Colour direction — latest user feedback

The user finds the current black/grey/orange identity boring. Replace that proposed palette with a more distinct study palette: deep petrol background `#071B20`, panel `#102A30`, elevated/selected surface `#183940`, warm ivory foreground `#F0EEE2`, secondary `#AAC0BE`, lines `#315158`, citron primary accent `#E3F56B`, coral `#FF957D`, cool blue `#9FCBEF`. These are proposed design values, not claims about the existing brand. Use citron for primary selection/action, distinct labelled agent colours, mint/coral code additions/removals, and the dimensional animation. Tint the ASCII field to match petrol/ivory. Retain legible opaque text surfaces; no rainbow cards or glowing gradients.

### Additional requirements: working chat and dimensional motion

- The user explicitly requires the interactive agent working chat. Preserve the visible mini conversation (opening request, agent updates, current tool, waiting/working state), expansion to the full transcript, tool-result disclosure and reply interaction. Source: `client/thread-view.ts` and `client/thread-drawer.ts`. A generic static task summary plus hidden Talk button is insufficient.
- Keep the selected agent's working conversation visible in the Agents pane with a compact reply field; expand into a full thread when requested. Sample reply progression must update the same agent in both views, retain per-agent drafts, preserve expanded tool results and reader scroll, and provide clear waiting, reply-unavailable and empty-input feedback. Replies and progress are simulated; never call the real jobs API.
- The user also likes Anime.js's dimensional dot/line animations. Use one small, crafted 3D geometric activity piece beside the selected working agent's chat header, plus smooth thread expansion/new-row motion. It is an activity ornament, not workflow topology, and must not replace useful information. Prefer a layered dot-grid form with depth, restrained white/orange, no glowing orb or new central engine hub.
- Reuse the installed Anime.js 4.5.0, keep its licence notice if copying its browser bundle into this standalone preview. Pause/reduced-motion/hidden state must govern the dimensional animation as well as the ASCII field. Completed or stopped agents show a settled shape. Simulated message completion must still finish with visual motion paused. No continuous animation of paragraph text.

The user rejected the sparse study as oversimplified: necessary information disappeared. They liked the ASCII flow idea but said its current expression feels weird. This correction supersedes earlier instructions to start with only two short messages and minimal agent details. The flowing ASCII atmosphere remains a liked reference; the separate engine diagram is not approved.

- Clean means stronger hierarchy, not fewer capabilities. Preserve the real Terminals operating surface: app navigation; session engine and name; create, resume, rename, close and search; engine/model/repository inputs; actual terminal-style output and input.
- Preserve agent context: job name, engine, state, current activity, elapsed time, turns and latest tool. Keep running/recent grouping, scope, collapse, conversation, log and stop actions accounted for. Put detailed output behind its existing disclosure instead of deleting it.
- Source inventory: `server/views/layout.tsx`, `server/views/terminals.tsx`, `client/terminal.ts`, `client/agents.ts`. Existing equivalents were found for all the controls above; do not invent a replacement workflow or turn the terminal into a generic chat product.
- Retain the joined panes and restrained palette. Recover usable workspace area from excessive outer padding and empty presentation space. Judge the next composition with realistic occupied, empty and recent-work states.
- The ASCII must belong to the workspace. Do not dedicate a separate strip to an ornamental engine map. A restrained bracketed plan list in selected-agent detail can express the real ordered workflow; the background itself remains atmospheric.
- Continue as a standalone preview with sample data. No production changes or full-design approval are implied.

The user approved Dragonfly's ASCII atmosphere on 2026-09-07 after rejecting the earlier static proposals and two sets of similar desktop-tool references. This is approval of a direction, not approval of the full UI overhaul. They like reference 01 Ghostty's pane organization and reference 03 Raycast's low information density. They explicitly want to judge animation live in their Arc browser. The old BRIEF.md's ban on ASCII backgrounds is superseded by this brief.

## Scope

One refined Terminals screen at /motion.html on the existing preview server. The next decision is whether the composition and motion feel right before extending the treatment to other pages. All content is sample data; actions are cosmetic and held only in memory. Do not implement the entire application in this study.

## Visual direction

- Near-black workspace, cool white text, one sparingly used orange accent, restrained fine borders, system grotesk navigation and Menlo terminal content. No pixel display font, giant headings, cards full of explanatory text, KPI strip, marketing hero, mascots, glows or rainbow gradients.
- Compact top bar: Mission Control, Terminals, and a quiet Sample preview disclosure. Session tabs beneath. One large terminal pane on the left; a narrow right column divided into Agents and a quiet selected-agent detail. Main composition reads as joined panes, not detached dashboard cards. At desktop leave enough breathing room around and within the workspace for the background to be visible.
- A single original rolling ASCII contour surface supplies the atmosphere: a broad oblique wave or ribbon across the lower/right canvas, large black gaps, shaded character density, slowly evolving crests. Use punctuation glyphs, not binary rain or a canned spinning donut. No Dragonfly logo, insect, imagery, or copied source. Keep primary text on sufficiently opaque surfaces; background motion must remain clearly perceptible in empty margins.
- Body text 14px or greater, metadata 12px or greater. Main foreground roughly #ededed, secondary #a0a0a0, background #000000, panel #101012, rules #2b2b2e. Proposed study accent #f26a3d; these are new study tokens, not claims about the current brand palette.
- Short 160–240ms pane/tab/detail transitions with subtle opacity/translation; no floating cards, repeated entrance sequences or continuous motion in the controls. Hover can gently influence the ASCII field, but never move text or hijack scrolling/cursor.

## Content and interactions

- Start with two selectable sample sessions named UI overhaul and Model lists. Each has one short request and one short response, a collapsed tool result, and ample empty space. Do not fill the terminal with fabricated long logs.
- Two sample agents with name, concise task and plain status; selecting a row changes the detail below. Details are collapsed/short by default.
- A compact composer accepts a message and shows a clearly simulated response; empty submission has explicit feedback. Never execute anything or call APIs. Preserve typed text across tab switches if possible without complexity.
- New terminal opens a native dialog with name and engine (Claude, GLM, Codex); creation visibly adds a sample session, cancel/Escape restores focus. New session has a useful empty state. Omit controls that do not have an implemented preview effect.
- A visible Pause motion / Resume motion control freezes/resumes the background. Respect prefers-reduced-motion on load and changes, and stop animation work while the page is hidden. Screen reader status feedback, keyboard focus, proper tab semantics and labels. Canvas is decorative and inaccessible to pointer focus.
- Single-column adaptation at 375px without horizontal overflow or overlapping controls. Keep the real desktop pane composition at 1000px and above.

## Implementation and acceptance

One standalone motion.html with inline CSS and JS; reuse the running serve.ts without changing it. No packages needed: Canvas 2D for ASCII and native CSS/Web Animations for transitions. Cap canvas resolution and animation rate around 30fps; elapsed-time animation, cancellation, no runaway duplicate loops. Reduced motion and manual pause must actually stop evolving frames.

Read server/views/terminals.tsx for existing labels and behavior, public/theme-tokens.css for current constraints being deliberately changed only in this preview. Visual references: references/ghostty.png, references/raycast.png, and /tmp/mc-motion-dragonfly-a.png. Reference URLs: https://www.dragonfly.xyz/ and https://animejs.com/ . Parent has already checked them live; no need to browse or copy their code.

Parent verifies actual Arc rendering over time, hover, tab/detail changes, composer empty/normal submissions, new-session dialog and empty state, pause/resume, reduced motion, and responsive layout. No product test suite is required because product code is untouched. Keep any runnable check limited to the delivered study.

## Refinement: the app's heart

The user called the first motion study cool and asked for more geek character and creativity at the heart of the app. Preserve its quiet panes, low text density and flowing ASCII atmosphere. Evolve the same screen, not another page family.

- Make the signature graphic specific to orchestration: a small original ASCII core sends a bright, brief signal along precise routes to the selected engine node, then receives a returning signal. Keep the flowing field as a subtle substrate. The core/nodes must be clearly visible beside or below the workspace at the actual desktop viewport, not hidden behind the opaque terminal. Derive their positions from the workspace bounds; keep the composition coherent at 1000px and mobile. No new metrics dashboard or explanatory panels. If a full network cannot fit at small widths, show a compact core near the existing footer and retain full functional controls.
- Use the three existing engine names Claude, GLM, Codex. These are simulated endpoints, not claims about live backend state. Highlight the endpoint for the selected terminal; selecting an agent or hovering its existing row gives matching visual feedback. Avoid inventing permanently assigned engine roles: the real app has configurable role assignments. Source concepts already exist in client/flow.ts and server/views/terminals.tsx; reuse that vocabulary.
- Replace the generic orange square brand mark with a small original junction glyph (paths meeting at a core), repeated subtly in the command prompt. Refine the frame with a few functional instrument details: deliberate corner joints, an active-tab indicator that moves as one piece, a clear selected-agent connector, a compact enter/send affordance. No random numbers, fake telemetry, decorative labels, tiny illegible text, scanlines, glow, binary rain, or gratuitous panels. Do not turn every control into a heavily outlined box.
- Sending a sample message should visibly activate the chosen route and return to quiet. A short simulated response delay is acceptable only if pending state is visible, bound to its original session, survives switching sessions, and still completes with paused/reduced motion. Keep input safety and draft preservation. Prefer the smallest state handling that satisfies this. If you keep immediate replies, do not imply real timed job progress in the copy.
- Unify the atmosphere, core and packets under the existing single animation driver; cap work and elapsed time, stop during hidden/paused states, and render a useful static composition for reduced motion. Cursor response should be subtle and confined to the graphic. Pausing must stop the actual canvas evolution.
- Save the liked prior version unchanged as motion-before.html and add one quiet Previous study link beside the existing footer label. No screenshot selector or new design dashboard. Keep motion.html the active URL; bump fingerprint.js after each meaningful update. Never include fingerprint.js as a script src: that endpoint is a plain-text version string and the server already injects reload polling.
- Extend the existing evidence/motion-verify.cjs only for meaningful new behavior. Parent tests the rendered geometry, signal changes over time, hover/selection, message/session consistency, and reduced motion in Arc. Do not start a browser yourself.
