# Decision: morph everywhere

**Chosen:** apply the morph to every place in `index.html`: the 14 card demos and the 25 "same pattern" rows in the Everywhere else table. The 8 "already smooth" places stay as they are.

**Why:** the user approved the sidebar dot → ✕ → Remove morph and asked for the same concept "everywhere that has a transition", then approved this full list ("all good. matter fact apply all").

**Motion language (settled in the mockup):**
- 240 ms, `cubic-bezier(.2, .8, .2, 1)`; instant under `prefers-reduced-motion` (the global rule at `public/quiet.css:363` already covers CSS; script animations check the media query).
- Reshape = one element animates its old → new width, height, corner radius, background and text colour, while its content cross-fades (fade + 2 px lift).
- While an element morphs it gets `overflow: hidden; white-space: nowrap` (the `.morphing` class), so growing text is revealed instead of wrapping. This was the Copy → ✓ Copied flash the user caught.
- Appear / disappear = grow from 0.92 scale with a 2 px blur clearing; leave = shrink to 0.94 and fade.
- Lists: a removed row folds its height to 0 while fading, so rows below glide; a moving selection is one highlight that glides.
- Numbers roll (drop in from above); new strip squares pop (0 → 1.35 → 1).
- Destructive actions use the click-twice morph (`confirmButton` / `.confirm-morph`), never a modal: Stop agent, Rotate token, Remove connection, sidebar Remove.

**Real files to touch:** listed per row in the table (`inventory.js`), chiefly `client/terminals.ts`, `client/access.ts`, `client/shell-activity.ts`, `client/chat.ts`, `client/shell-composer.ts`, `client/outcome-strip.ts`, `client/sidebar.ts`, `client/shell.ts`, `client/studio.tsx`, `public/quiet.css`, and a shared helper in `client/morph.ts`.

**Check found during inventory:** the desktop Agents panel opens with `.show()` (non-modal), which may skip the dialog fade. Verify it while implementing.
