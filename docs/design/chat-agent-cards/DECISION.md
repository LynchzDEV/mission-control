# Decision: spawned agents inside the system chat
**Chosen:** Variant B — one team card per assistant reply, listing every agent that reply spawned as rows.
**Why:** User picked B ("go with b") after comparing it with per-agent cards (A) and a tray above the composer (C).
**Real files to touch:** `docs/design/quiet-chat/index.html`, `style.css`, `preview.js` (design); later `client/transcript-view.ts`, `client/markdown.ts`, `client/thread-drawer.ts`, `server/threads.ts`, `/api/jobs` (production).
**Implementation notes:**
- Chat rows: assistant = 34px raised avatar (spark icon, accent) + "Mission Control · time" meta line + markdown body; user = right bubble. No project title above the conversation; the project lives in the composer chip.
- Markdown covers exactly what `client/markdown.ts` emits: paragraphs, headings, ordered/unordered lists (accent markers), blockquote (muted, thin lavender rule), fenced code (inset panel), inline code (accent text on `#e2e6f0` pill), strong/em. Text colour is the design's `#505e75`; nothing darker.
- Team card sits inside the reply body, under the text. Header: title, "N agents · folder-icon project", "Open in Agents". Rows: provider logo disc, step name, "Engine · model — reason", latest activity line with pulse, state. Progress bar while running; when the review passes the chat lands the work itself and the card shows "Landed" (no Review / Land buttons).
- Provider identity = logo (LobeHub icons, MIT: Claude, Codex, Z.ai for GLM) + faint engine-colour wash (Claude `#d4a091`, GLM `#91b0dc`, Codex `#bfd38b`). No left colour stripe, no legend, no emoji.
**Rejected:** A — one card per agent gets noisy when a reply spawns many; C — tray splits status away from the message that caused it.

# Decision: chat settings in the message box
**Chosen:** B, collapsible (`new-chat.html#b`). The message box shows only a folder chip for the project. Clicking it slides out, to its right and inside the message box, an AI chip (provider logo + model) and a pencil chip (direct editing on/off), and opens the project menu. The AI chip opens a model menu grouped by engine (logo headings, model rows, check on current, "Custom model…"). Clicking the folder chip again folds everything back.
**Why:** User: "i like b, but make it collapsable" then "its good now. mark this as picked".
**Implementation notes:** no + button and no history icon in the message box; History lives only in the toolbar. Settings apply to the current chat; a new chat resets to auto-detected project + Chat role AI. Model list comes from `/api/models`, custom IDs allowed.
**Rejected:** A — one chip, one long menu with all settings; C — inline tray of pills inside the message box.

# Decision: terminal launcher
**Chosen:** Split "New chat" button; its arrow opens a one-item menu, Terminal, which opens a flat launcher (`new-chat.html#terminal`).
**Why:** User: "ok good now. marked as done after change the purple button/x button to Neumorphism".
**Implementation notes:** Neumorphism only on the dialog card's single soft shadow, the raised close (X), and the raised full-width "Open terminal" pill (accent text). Fields (Workflow, Engine, Model, Working directory) are flat tinted boxes: `#e2e6f0`, 10px radius, no shadow, faint `#d3d9e6` border on hover, `#c9c0e3` on focus; labels 12px muted. No Recent directories list (lives elsewhere).
**Rejected:** fully neumorphic launcher (every field inset, every control raised); solid lavender primary button.
