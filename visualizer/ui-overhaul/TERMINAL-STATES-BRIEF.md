# Terminal states — new-terminal flow placement study

`terminal-states.html` (hash-routed: `#now` `#a` `#b` `#c` `#empty`, default `#a`).
Visual language is `terminal-components.html`, style block copied verbatim — only the state being designed is new.

## What was designed

The four states the approved study never drew: the new-terminal flow revealed, in three placements, plus the empty deck for each. Every variant absorbs the whole flow in one element — engine as three coloured choices (Claude coral, Codex lime, GLM ice) instead of a native select, optional model field (placeholder "engine default"), directory field plus a recent-directories list showing each directory's live sessions (this retires the separate Directories overlay), a Resume tab listing Claude history with title, relative time and directory, a primary "Open terminal", and a dismiss.

## The three variants

- **A · Sheet in the deck** — opens full deck width at the top of the deck and pushes the panes down; New/Resume tabs, fields left, recent directories right.
- **B · Dock popover** — a 420px popover anchored above "+ New terminal" in the session strip; the deck never moves, and Resume is the same popover on its second tab.
- **C · Empty pane as composer** — the composer *is* a pane: same emblem, a title field where the h2 sits, engine chips + model + directory as the context line, recent-directories/resume list in the transcript area, "Open terminal" on the input line.

## What stays fixed across all three

- Masthead, usage summaries, workspace heading, flow row, agent window, deck, session strip and footnote are the approved study unchanged.
- Pane header change, badged NEW on the live panes: the "…" utilities menu is retired; Find and Reconnect become two quiet 18px icons beside the existing focus icon, revealed on hover (one is drawn hovered); the caption under the title is a session caption, not the absolute path.
- Lime = selected/Codex, coral = Claude, ice = GLM and sub-agent activity.
- Nothing is functional: only the New/Resume tab and the engine chips switch, cosmetically.

## Known gaps

- **B occludes the right pane.** The popover sits over the second terminal, so that pane's new header treatment is hidden behind it. That is variant B's real tradeoff, not a drawing error.
- **C costs a pane slot.** With the composer in the deck only one live session stays visible; the other steps back to the strip.
- **Empty row scrolls.** Three 480px crops need 1488px; the page content column is 1356px at 1440, so the row scrolls inside itself rather than overflowing the page.
- The ASCII canvas is shifted 46px to compensate for the state switcher bar, so its relationship to the masthead matches the study exactly.

## Open questions

1. Which placement — A, B or C? A is the most legible but moves the deck every time; B never moves anything but covers a session; C is the most native but spends a pane.
2. Should Resume stay a tab inside the same element, or is it a separate entry point? Resume is Claude-only in the real code (`resumeSession` hardcodes `engine = 'claude'`).
3. Does the recent-directories list fully replace `#directory-nav`, or does the aside stay for browsing?
4. Empty deck: does A keep a welcome line under an open sheet, or does the sheet alone carry it (as C does)?
5. Session captions: what text replaces the path when a session has no title yet?

Real files: `server/views/terminals.tsx` · `client/terminal.ts` · `client/terminal-view.ts`
