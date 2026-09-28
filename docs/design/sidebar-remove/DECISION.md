# Decision: sidebar remove — dot → ✕ → Remove morph

**Chosen:** one element per row that morphs: the status dot grows into a ✕ on hover, stretches into a red **Remove** pill on click, and shrinks back to the dot when the pointer leaves, focus moves, Escape is pressed or 4 s pass.

**Why:** the user's own design ("dots hover transfer to x then click transfer to button then focus elsewhere transfer to dots"), asked for as a smooth morph rather than swapped elements; replaces modal delete confirmations.

**Real files to touch:** `client/sidebar.ts`, `client/confirm-button.ts`, `client/terminals.ts`, `server/views/shell.ts` (end-terminal dialog removed), `client/studio-settings.tsx` (Remove connection), `public/quiet.css`.

**Implementation notes:**
- Every row keeps a fixed 22 px status slot at the right edge after the ⌘ badge, so badges line up whether or not a row has a dot.
- Morph: 7 px dot (status colour) → 22 px rounded square with ✕ → 64 px red pill "Remove"; 240 ms `cubic-bezier(.2, .8, .2, 1)`; the ⌘ badge fades while armed and the title's last pixels fade so the pill never crowds it; instant under `prefers-reduced-motion`.
- Remove on a live terminal ends it; on any other row it hides the row (kept per browser, reappears on newer activity) and it stays in All history.
- Text buttons (Studio "Remove connection") use `.confirm-morph`: the two labels share one grid cell and cross-fade while the button fills red, so its width never jumps.

**Rejected:** the first cut hid the whole right column on hover and swapped a separate ✕ in (no morph, badge disappeared on every hover).
