# Decision: mission-control UI (lanes + settings)

**Chosen:** Variant B — CONTROL RACKS (`b.html`) + symmetric settings (`b-settings.html`)

**Why:** user picked racks layout over instrument strips (A) and timeline cockpit (C); wanted v3's pixel font + banner animations kept, real node-graph session flow, symmetric settings.

**Locked elements:**
- 3 vertical engine racks (CLAUDE coral / GLM cyan / CODEX white), 1px hairlines, no border-radius, hard shadows only
- Banner mascots: v3 `sketchIdle` (Claude, verbatim) + v3 `sketchRain` (GLM, verbatim) + NEW radar-sweep critic (Codex) — textmode.js with bloom/scanlines/filmGrain filter passes
- SESSION FLOW node graph above racks: stage cards (SPEC→IMPLEMENT→CROSS-REVIEW→VERIFY+MERGE→MERGED), JS-drawn SVG arrows from node rects, dashed amber = queued codex loop, opacity encodes state (done .5 / future .25 / active 1 + green bar + pulse)
- Session selection: chips row in flow header AND clicking any station task — both call `setSession()`
- Racks: big pixel-font metric + spring bar → kv stats → "AT THIS STATION" task list (stage segments, worktree path) → full-width action bar
- Settings: same 3-col rack grid, rows aligned across columns (auth/binary/quota-src/role), APP band below; token write-only (SET ●●● + REPLACE)
- Motion: anime.js v4 (`lib/anime.iife.min.js`) — stagger entrances, counter roll-ups, outExpo everywhere, arrows self-draw

**Real files to touch (implementation):** mission-control app repo per docs/SPEC.md — views lanes.tsx/settings.tsx render this design; client islands sprites.ts (mascot sketches), flow graph JS → lanes island.

**Rejected:** A (instrument strips — too flat), C (timeline cockpit — no mascots, user wants them), first B draft (thin funnel band — replaced by node graph), eye + err-noise codex mascots.

**Remaining screens not yet designed:** dispatch, terminals, review, login.
