# Decision: transcript / TALK UX (agents panel + drawer)

**Chosen:** Variant A — TUI TRANSCRIPT drawer + minimal inline card view (`a.html` shell, `a-inner.html` drawer, `real/base.html` cards)

**Why:** user picked A; Claude-Code gutter grammar reads fastest; mini view must show request/response exchange inline; both levels required.

**Locked — card mini view (RUNNING + RECENT, always visible):**
- last ~6 rows, one line each, 10.5px, left hairline, ellipsis overflow
- row grammar: `›` request (prompt or reply, fg + green glyph) · `⏺` tool (`<b>Title</b> detail`) · `⎿` tool result (red when error) · `✻` thinking (italic dim) · `●` live/current tool (green, glyph pulses) · `… waiting for response` (dim italic, while running) · `✓` assistant response (fg, green glyph)
- reply turns show inline (`›` reply then `✓` answer) as they arrive; rows append live (2–3s poll), never re-render whole list
- footer link `▸ OPEN FULL TRANSCRIPT · n more` (or `· n tools · n thoughts`) → opens drawer; TALK ▾ button also opens it

**Locked — drawer (full transcript):**
- fixed right, 58% width, full height, dim overlay .55 behind, ESC / overlay click closes, page beneath stays live
- header: label (pixel font) · engine chip · elapsed · status (green) | right: `n TOOLS · n THOUGHTS · ESC CLOSE`
- transcript rows: 22px gutter grid; `›` user; `✻` thinking collapsed to 2.6em + `…`, click expands; `⏺ Title(detail)` + `⎿ result` collapsed to 3.2em, click expands, red on error; `⏺` assistant text full; `✓` final response separated by hairline
- reply footer: hint line `↵ SEND · ⇧↵ NEWLINE · continues the same session (resume)`, textarea + pixel-font SEND (green border); disabled + note when engine cannot resume
- live: rows append in stream order every 2s while running, `…working` cursor row at bottom, running tool row pulses until result

**Mounts:** /terminals AGENTS cards (mini + drawer), /dispatch job rows (mini + drawer), /lanes ACTIVITY column (drawer content read-only inline, no reply box)

**Real files to touch:** client/agents.ts, client/thread-view.ts (shared renderer), client/dispatch.ts, client/flow.ts, server/views/terminals.tsx + lanes.tsx + dispatch.tsx, public/theme.css

**Rejected:** B timeline rail (thinking cards balloon), C transcript+state (rail adds chrome; may revisit the FILES TOUCHED idea later as a header stat)
