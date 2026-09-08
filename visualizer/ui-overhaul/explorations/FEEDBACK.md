# Parent review notes

The gallery shell is open in actual Arc. Continue all twenty directions.

CRITICAL: the existing preview server only serves .html/.css/.js/.woff2/.png/.svg. `catalog.json` returns HTTP 404 even though it exists. Use `catalog.js` containing the same JSON array (fetch it as a static asset and parse the body with response.json()), updating gallery and verification references. Do not modify or restart the server. This is why the gallery currently cannot read its catalog. Parent confirmed the 404 directly.

Early shell issue to fix before finishing: catalog initially contains an empty array. Publish all twenty named pending entries so the user can see the full set being explored. Guard previous/next when catalog is empty: modulo zero currently makes selection NaN. Empty and fetch-failed states must show a clear status and a safe retry, not a silent dead control. The gallery can be simple; do not let this delay the designs.

Parent will add screenshots/<id>.png as real pages are rendered. Refresh/reload the grid when those become available, or provide a small explicit Refresh action. Do not display a permanently removed/broken thumbnail after the screenshot exists.

No visual verdict yet: no concept page existed at the first gallery check. The twenty directions must differ in composition and typographic treatment, not only token values. The broader user freedom is intentional; take real creative swings.

Code reviewer independently reproduced the modulo-zero/NaN issue by running the actual gallery with a delayed fetch, and confirmed the late-thumbnail issue. No other high-confidence shared-runtime findings in the early pass.

## Rendered review: 01–04

All four load in real Arc at 1512×909 with two terminal nodes and no page errors or horizontal overflow. Actual screenshots are now screenshots/01.png through 04.png.

- Structural variety is visible: 02 is a frameless stacked terminal ledger with side controls; 04 is a light drafting composition; 01/03 are distinct surfaces. Continue the broader range.
- 02 currently pushes the second command input and the shared Focus/Split/Chat controls below the desktop viewport. A terminal-first desktop option must let the user see/use both terminal inputs and reach core controls without scrolling the whole page. Reduce transcript height/spacing or put the controls in the side rail. Preserve the distinct stacked arrangement.
- 01 and 03 spend a lot of screen area on slogan headings (“ON THE COMMAND LINE.” / “A little space.”). These read as landing-page copy. Keep expressive typography, but use product/session/workspace identity rather than slogans. Prioritise usable terminal area. This applies to upcoming pages too: actual application screens, not terminal-themed landing pages.
- ASCII craft needs more depth. 03's constant-glyph ellipse reads as a flat ring; it should show dimensional orbit/sphere behavior, light/shade or depth through glyph density, with perspective on focus. For appropriate later directions use real projected 3D points or graded ASCII shading, not just sine masks made of one glyph. Keep at least one rich flowing field close in quality to the original motion-before.html wave; Tidal should be the strong atmosphere option.
- Decorative all-caps art captions such as “ORBITAL / STILL IN MOTION” add no useful information. Prefer the art itself; the actual pause control already explains motion.

These are targeted craft corrections, not a request to flatten the twenty designs into one layout. Keep the risky compositions and varied type/material choices.

## Rendered review: 05–12

Actual Arc screenshots 05–12 are captured. All eight have both command inputs within the desktop viewport and no page errors/horizontal overflow. 06's frameless composition, 09's margin controls, 10's inverse split and 12's horizontal session tracks add useful variety. Preserve them.

- Remove nonfunctional ASCII figcaptions throughout the set, as requested in first review; 11's caption is visibly cut off inside the oval. The motion control and accessible figure label are enough.
- Keep 07's editorial type but simplify “The working folio.” / “Terminal room / September edition” into actual workspace identity; decorative copy is a recurring user rejection.
- In shared runtime, focus → Stack split clears focused state but leaves the global Focus button saying “Restore pair”. Recompute that label whenever focused changes.
- Brief requires at least six dimensional/spatial motion treatments. I currently see projected geometry for 03/17/19 only. CSS static perspective alone is not an animation treatment. Ensure three more directions have distinct spatial movement (e.g. 13 folded terrain, 14 twisting ribbon, 20 glyph choreography), with reduced motion respected. Avoid turning all art into the same rotating wire object.

## Rendered review: 13–20 and responsive scan

All twenty designs have now been rendered in actual Arc at desktop. Screenshots 01–20 exist (some pre-correction; parent will refresh final set). 13–20 have both inputs inside desktop viewport, no page errors and no horizontal overflow. 17 now has the requested richer flowing ASCII atmosphere; 19 has projected rotating geometry.

Parent tested all twenty at widths 1000, 768, 375 and 320 via actual Arc CDP. Confirmed horizontal overflow ONLY in 10 Monochrome: 118px at375,173px at320. Likely its oversized TERMINALS title; fix with responsive type sizing/wrapping, not overflow:hidden. Other 19 pages had no horizontal overflow or out-of-bounds input/button in this scan.

Please finish feedback fixes and verify.cjs; parent is ready to run the browser checks. Do not operate the browser yourself. Keep verification bounded and use CDP emulation restored in finally. Parent will review code independently and run actual full set.

Final code reviewer found one gallery edge case: populated catalog -> empty [] -> Refresh leaves stale count, dropdown choices and grid tiles because empty branch returns before clearing them. Clear count/options/grid in the empty branch before returning. Reviewer reproduced by executing actual script with mocked fetch. No other high-confidence findings in gallery.js/runtime.js/shared.css.

Browser verification script review: before exercising each page call bringToFront(); prefer waitForFunction polling:100 (real Arc rAF pauses when occluded). Parent will activate Arc app before running. Restore Emulation by clearing override and waiting for original native dimensions before deciding whether an override is necessary; do not leave an override merely because first evaluation was one frame stale. For live motion, assert canvas changes while running, stays identical while paused/reduced, and changes again on resume (frame counter pause alone does not prove animated output).

Gallery iframe is852px tall on actual909px screen. A few lower toolbars require scrolling inside the preview (03/06/10/14/15/17/19, bottom861–898). Full view is available. Prefer compacting their art/header vertical padding slightly if easy; preserve design diversity. All20 have visible inputs inside iframe.

Parent has started verify.cjs --cdp in foreground Arc. Do not launch browser tooling. After final adjustments, please remove the temporary build.py generator if it is only one-off scaffolding; deliver static pages plus shared behavior and runnable verification, not duplicate stale source. Report final changed files after checks so parent can target re-verification without rerunning unchanged cases.

FULL BROWSER PASS: Parent ran verify.cjs --cdp against foreground actual Arc; all20 pages and gallery passed terminal focus/split/draft/command, chat draft/send/empty/no-agent, Main/Usage/Settings, paused frame, reduced-motion state, and all5viewport checks. Screenshots01–20 refreshed by this pass. Initial attempt selected a hidden tab and timed out; foreground target resolved this, so bringToFront remains required in script. Parent is adding actual canvas-motion and gallery-empty-state verification. Finish targeted feedback adjustments only; no new features needed.

## Final parent verification

Completed in actual Arc. All20 pages passed interaction checks and five widths (1512/1000/768/375/320). All20 canvas outputs were compared over time: changed while running, identical while paused, changed after resume, identical under reduced motion, identical while their tab was hidden. Final spacing changes in03/06/10/14/15/17/19 were rechecked at all five widths with852px height; no horizontal overflow. Empty command feedback, focus-to-split label, populated-to-empty catalog, failed catalog load and Refresh recovery were exercised successfully.

All20 final desktop screenshots were recaptured at scroll position0. Gallery loads all20 real thumbnails and one live iframe. Final overview is screenshots/overview.png. Gallery is left open in Arc with All20 visible and Tidal selected. Reviewer found no further high-confidence issues after gallery fixes and new spatial branch review. Production files remain unchanged. This is an exploration collection; no visual direction is approved yet.
