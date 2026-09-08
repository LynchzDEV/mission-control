# Twenty terminal workspaces

Delivery: 20 / 20 complete and marked ready in `../../catalog.js`.

Entry: http://127.0.0.1:47831/explorations/index.html

The catalog is JSON text with a `.js` extension because the existing static server does not serve `.json`. The gallery fetches and parses it as JSON. It shows one live iframe, pending states, keyboard previous/next navigation, actual screenshot thumbnails when available, and an explicit Refresh control. Refresh preserves the active live preview. Favourites and comparison were omitted to keep the gallery compact.

| ID | Direction | Composition and typography | Observable motion |
| --- | --- | --- | --- |
| 01 | Broadcast | Condensed orange identity; unequal black program/preview monitors | ASCII tuning scan and stepped session selection |
| 02 | Phosphor | Monospace stacked ledger; command rail; frameless green output | Concentric contour scanner |
| 03 | Orbit | Pearl main/peer deck; angled surfaces; Avenir identity | Depth-buffered rotating ASCII sphere and inclined orbit; selected plane straightens |
| 04 | Graphite | Grey drafting grid; central measurement gutter; hairline fields | Travelling point-cloud strata |
| 05 | Cobalt | Ultramarine edge console; white 60:40 terminals; yellow chat action | Diagonal ASCII field; session channel slides |
| 06 | Carbon | Frameless offset night sessions; thin silver controls at bottom | Broad oscillating silver ribbon |
| 07 | Letterpress | Baskerville folio identity; two generous ruled columns | ASCII type-impression feed |
| 08 | Radar | Dominant marine terminal; compact expanding peer | Rotating radial sweep; peer rises and expands on selection |
| 09 | Field Notes | Notebook margin controls; unequal working sheets; Courier identity | Coordinate field; sheets straighten and lift on selection |
| 10 | Monochrome | Edge-to-edge inverse terminals; black-and-white bold navigation | Ordered ASCII dithering |
| 11 | Ceramic | Jade interference oval; asymmetric tactile white instruments; Optima | Interference pattern; selected instrument lifts with perspective |
| 12 | Departures | Horizontal terminal tracks; compact metadata at left | Mechanical rotate-X reveal; segmented ASCII field |
| 13 | Glacier | Tall ice columns; vertical identity and terrain margin | Depth-ordered projected terrain with travelling folds |
| 14 | Redshift | Tomato workspace; offset light/dark planes; underlined controls | Projected rotating Möbius strip; selected plane straightens |
| 15 | Proof | Unequal editorial columns; burgundy rules; Georgia identity | Animated ASCII registration cross and circle |
| 16 | Workbench | Olive modular trays; narrow action rail; amber marks | Instrument matrix; selected tray lifts out of perspective |
| 17 | Tidal | Petrol reading planes beneath a wide fluid field; Optima | Depth-ordered projected ASCII water surface with layered waves |
| 18 | Dot Matrix | Continuous paper tracks with perforated edges; restrained local pixel identity | Moving dot-print band |
| 19 | Prism | Jewel/ice session planes with perspective and layered depth | Rotating nested projected cube edges; focus makes the chosen plane orthographic |
| 20 | Play | Unequal mint/butter sessions; mechanical session shelf; compact bold type | Projected glyph lanes with independent phases; selected shelf depresses |

All directions share behavior only: terminal commands, session selection, draft/transcript retention, focus/restore and alternate split, on-demand session chat with drafts and empty-send feedback, toggleable no-agent state, manual plan steps, heterogeneous provider usage, and in-memory role/type/motion settings. Commands and messages append literal text. Nothing executes or persists.

Ambient rendering is cancelled while paused, hidden, or in reduced-motion mode. Six explicit projected fields are present in 03, 13, 14, 17, 19, and 20. Other spatial interaction transitions are supplementary.

## Verification

Worker ran JavaScript syntax checks during implementation and one full standalone collection pass:

```
node visualizer/ui-overhaul/explorations/verify.cjs --static
```

Result: PASS — 20 ready pages, 20 distinct stylesheets, two terminals per page, JavaScript syntax, asset references (including the existing local pixel font), and 48 local static HTTP routes. No browser was used for these checks. No production suite was run.

Parent can run:

```
node visualizer/ui-overhaul/explorations/verify.cjs --cdp
```

This attaches to an already open owned Arc explorations tab with `connectOverCDP` and `noDefaults: true`. It exercises every page's commands, drafts, focus/split, chat, no-agent state, panels, pause and reduced motion, and viewport widths 1512/1000/768/375/320. It also exercises gallery navigation and iframe typing isolation. It captures screenshots to `screenshots/<id>.png`. It captures dimensions before per-page CDP emulation and restores/awaits dimensions and URL in `finally`, detaches the CDP session, and never closes Arc.

The parent owns actual browser operation and screenshots. Parent feedback reports desktop renders for all twenty and a responsive scan across all twenty; it identified one narrow-width overflow in Monochrome, corrected with responsive typography and wrapping. Earlier parent feedback led to Phosphor's command rail, removal of decorative captions/slogans, richer spatial fields, and gallery/runtime state fixes. The worker has not operated the browser or claimed final visual approval. Parent subsequently reported a full passing `verify.cjs --cdp` run for all twenty pages and the gallery: focus/split/drafts/commands, chat, panels, paused frames, reduced-motion state, and all five viewport sizes; all twenty screenshots were refreshed. The parent is separately checking actual canvas motion and gallery empty-state behavior.

This collection is sample-only. No backend integration, real execution, preference persistence, new dependencies, production edits, commits, branches, service restarts, or job dispatch were performed. Parent-owned `FEEDBACK.md` and screenshots were preserved.

## Final targeted changes after the parent browser pass

- `03-orbit.css`, `06-carbon.css`, `10-monochrome.css`, `14-redshift.css`, `15-proof.css`, `17-tidal.css`, `19-prism.css`: shortened art/header regions to improve core-toolbar visibility inside the 852px gallery iframe. No new layout shell or interaction changes.
- `verify.cjs`: foreground the owned tab before page checks; use 100ms polling; compare actual canvas pixels while running, paused, resumed, and reduced; wait for native dimensions after clearing emulation before considering a fallback override.
- Removed the one-off `build.py` generator. Static HTML/CSS pages are the delivered source.
- Targeted final checks: seven changed stylesheets have balanced blocks and return HTTP 200; updated verification script passes `node --check`. The full static suite was run once. These last spacing adjustments and stronger verification assertions were not independently browser-run by the worker.
