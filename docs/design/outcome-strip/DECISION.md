# Decision: outcome strip placement

**Chosen:** Variant B — a status line along the bottom edge of the session: under the terminal in the live view, just above the composer in chat.

**Why:** Only placement with room for a long run of squares plus the "passed / failed" totals, and it sits where the eye already is while an AI works. The pill (A) has no room for totals and already overlaps terminal text; sidebar rows (C) are too small to hover and vanish when the sidebar is collapsed.

**Real files to touch:**
- `client/terminals.ts` / `client/terminal-panes.ts` — the terminal host (`.term-host`), which gets the line below the xterm; the xterm area shrinks to make room instead of being overlapped
- `client/chat.ts` + `server/views/shell.ts` — the `.composer-area`, which gets the line above `#composer`
- `public/quiet.css` — strip, square and tooltip styles

**Implementation notes (settled in the mockup):**
- Line: `This session` label left, squares, `N passed · N failed` totals right; flat card `1px solid var(--line)`, `var(--r-md)`, background `color-mix(in srgb, #fff 45%, var(--paper))`, 8px 12px padding
- Squares 10px, 3px gap, 2px radius; passed `#6f9c7e`, failed `#b0556a` (the sidebar dot colours)
- Main-agent actions are solid; spawned sub-agents and cockpit jobs are hollow (22% tint + 1.5px inset ring in the same colour)
- Oldest left, newest right; when the line is full the oldest squares drop off, totals always count the whole session
- Tooltip is the existing popover look (`var(--paper)`, `var(--r-md)`, popover shadow): tool + target in mono, result line in the outcome-pill colours (`#3f7352` / `#a13f58`), optional detail (exit code, first error line), footer with engine logo, who did it and relative time; spawned jobs/agents read "Started by the main agent"
- No emoji anywhere; squares are CSS

**Rejected:** A — in the session pill (no totals, crowds the pill, overlaps terminal text); C — under each sidebar title (6px squares too small to hover, hidden when the sidebar is collapsed; may return later as a cross-session overview on the same data).

**Mockups:** `docs/design/outcome-strip/index.html` (regenerate variants with `python3 gen_variants.py`; `src-*.html` are the untouched snapshots of the real app).
