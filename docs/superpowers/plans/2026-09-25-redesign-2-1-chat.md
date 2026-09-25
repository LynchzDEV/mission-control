# Redesign 2.1 — Lane 1: chat reading experience

Repo: mission-control (Bun + Elysia server, vanilla TS client transpiled on demand, tests with `bun test`). Base branch: `main`.
Design source: `docs/design/redesign-2-1/DECISION.md` §1 (row/pill/fade styling reused here) and the user's feedback list.

## Decisions
- Streaming: chat jobs on claude/glm run with `--include-partial-messages`. Worker jobs and codex are unchanged.
- Claude CLI partial format (captured 2026-09-25, see `test/fixtures/claude-partial.jsonl` created in Task 1): lines `{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"|"text"}}}`, `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}`, `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}}}`, `{"type":"stream_event","event":{"type":"content_block_stop"}}`, and the complete `{"type":"assistant",…}` line arriving after each finished block. Thinking text is always empty — never render thinking text; render only that thinking is happening.
- Thread parsing: only `parseThread` (the `limits.full` path) reads `stream_event` lines. Text deltas accumulate in a pending buffer; a complete `assistant` line clears the buffer (its own text event replaces the partial). An open thinking block (start seen, stop not seen) sets a pending-thinking flag. At the end of the log: pending thinking → push `{ kind: 'thinking', title: 'THINKING', detail: '', partial: true }`; pending text → push `{ kind: 'text', title: 'TEXT', detail: <buffer>, partial: true }`.
- `ActivityEvent` gains optional `partial?: true`. `ThreadMessage` text/thinking variants gain optional `partial?: true`, copied in `eventToMessage`. The empty-thinking filter in `assistantEvents` stays.
- Client polling: `RUNNING_POLL_MS` = 700 while the chat is running; idle stays 5000.
- Live timer: a 1-second interval updates only the `.activity-line` text of running turns (no repaint). Running label: `Thinking · 4s` while the turn has no text yet; `Writing · 12s` once text exists. Finished label unchanged (`Worked 39s · used 4 tools` / `Answered`).
- Live step line: a running turn shows one grey line under the activity line with its latest tool step (`Reading client/chat.ts`), fading out/in on change exactly like `docs/design/redesign-2-1/agents-e.html` (`.ag-tick` 12px muted, opacity 0 over 300ms, swap, fade in). Step text: `Reading <detail>` for Read, `Editing <detail>` for Edit/MultiEdit/Write, `Running <detail>` for Bash, `Searching <detail>` for Grep/Glob, otherwise `<title> <detail>`.
- Finished turns with tools: the activity line becomes a `<details class="turn-steps">` whose summary is the worked line and whose body lists each step text in order (12px muted, one per line). Collapsed by default.
- Text reveal: when a reply's text grows, re-render only its `.md` node and give newly added top-level blocks the class `md-in` (fade + 4px rise over 220ms). Do not rebuild the whole reply row for text growth.
- Scroll: after the user sends, always scroll `.stage` to the bottom with `behavior: 'smooth'`. On repaint, follow to bottom smoothly only when the user was within 80px of the bottom.
- Markdown: replace the hand parser with `marked` (GFM: links, tables, strikethrough, task lists, hr, nested lists, code) sanitized by `dompurify`. Links get `target="_blank" rel="noopener noreferrer"`. Keep the existing class names on output (`md-para`, `md-list`, `md-code`, `md-heading md-h1..3`, `md-quote`) by post-processing the sanitized DOM; add `md-table` on tables and `md-link` on links.
- Agent report row (`[agent <label> · <engine>] <outcome>` + body, built in `server/chat-reports.ts:61`): render as a compact system row, not a raw `<details>` summary: 24px engine logo tile (as in agents E) · `<label>` · outcome pill (`Done` green `#3f7352`/`#dcece1`, `Failed` red `#a13f58`/`#f5dde3`, any other outcome text muted) · a `Show report` text button that toggles the body rendered through the markdown renderer. Parse with `/^\[agent (.+) · (\S+)\] (.+)$/` on the first line; a non-matching first line falls back to today's `<details>` rendering.
- Backdrop hover: halve the hover boost in `client/backdrop.ts` — color mix `dot.near * 0.7` → `dot.near * 0.35`, radius `dot.near * 1.8` → `dot.near * 0.9`. Text halo in `public/quiet.css`: `.stage :is(p, li, h1, h2, h3, strong, em, small, time, summary, td, th) { text-shadow: 0 0 2px #fff, 0 0 6px var(--paper); }` (not on `code`/`pre`).

## Preserve
- `engineArgs('claude','p')` returns exactly `['-p','p','--output-format','stream-json','--verbose']` (test/chat-profile.test.ts:81); partial flag is added in `realEngineResolver` only when `purpose === 'chat'` and engine is not codex.
- Chat edit gating `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` when `edit === false` (jobs-engine-iface.ts).
- `parseActivity` (ticker) output is unchanged — it never reads stream_event lines.
- `parseJobProgress` turn counting unchanged.
- Queue rows, chat errors, team card, edit cards, `openChat`, `quiet:new-chat` behaviour in `client/chat.ts`.
- `turnsFrom` existing fields and tests in `test/chat-view.test.ts`.

## Tasks (one commit each, in order)

### Task 1 — stream partial text through the thread
Files: `server/jobs-engine-iface.ts`, `server/activity.ts`, `server/threads.ts`, `test/fixtures/claude-partial.jsonl`, `test/activity.test.ts`, `test/chat-profile.test.ts`.
- In `realEngineResolver`, after the `--disallowedTools` push, add: `if (purpose === 'chat' && name !== 'codex') args.push('--include-partial-messages')`.
- In `server/activity.ts`: add `partial?: true` to `ActivityEvent`; in `parseStream`, when `limits.full` and `type === 'stream_event'`, update the pending buffers per Decisions and `continue`; when `limits.full` and an `assistant` line is seen, clear the text buffer and thinking flag before pushing its events; after the loop append the pending events.
- In `server/threads.ts`: copy `partial` onto text/thinking messages in `eventToMessage`.
- Fixture: write these lines to `test/fixtures/claude-partial.jsonl` (one JSON per line): a `stream_event` `content_block_start` thinking; a `thinking_delta` with `"thinking":""`; a `content_block_stop`; an `assistant` message with `[{"type":"thinking","thinking":""}]`; a `content_block_start` text; `text_delta` `"Hey"`; `text_delta` `", how's everything"`.
- Tests (test/activity.test.ts): `parseThread keeps a partial text tail` → last event `{ kind: 'text', detail: "Hey, how's everything", partial: true }`; `parseThread drops the partial once the assistant line lands` → append `{"type":"assistant","message":{"content":[{"type":"text","text":"Hey, how's everything going today?"}]}}` and expect exactly one text event with detail `"Hey, how's everything going today?"` and no `partial`; `parseThread marks an open thinking block` → log with only the thinking start + delta yields last event `{ kind: 'thinking', detail: '', partial: true }`; `parseActivity ignores stream_event lines` → the fixture yields `[]`.
- Test (test/chat-profile.test.ts): a chat resolve for claude includes `--include-partial-messages`; a non-chat resolve does not.
- Commit: `feat(chat): stream partial replies into the chat thread`

### Task 2 — turn model: thinking, writing, steps
Files: `client/chat-view.ts`, `test/chat-view.test.ts`.
- `Turn` gains `thinking: boolean` (true when the turn is running and its last message is a partial thinking) and `steps: string[]` (step text per Decisions, one per tool message).
- Export `stepText(title: string, detail: string): string` and `runningLabel(turn: Turn, now: number): string` (`Thinking · Ns` / `Writing · Ns`, using the existing `duration`). `workedLine` uses `runningLabel` for running turns.
- Tests: `stepText('Read','client/chat.ts')` → `'Reading client/chat.ts'`; `stepText('Bash','bun test')` → `'Running bun test'`; `stepText('Grep','scrollTop')` → `'Searching scrollTop'`; `stepText('WebFetch','x.com')` → `'WebFetch x.com'`; `runningLabel` for a running turn with `text: ''` started 4000ms before now → `'Thinking · 4s'`; with `text: 'Hi'` → `'Writing · 4s'`; `turnsFrom` sets `steps` to `['Reading a.ts','Editing a.ts']` for Read a.ts then Edit a.ts.
- Commit: `feat(chat): turns know when they are thinking or writing and list their steps`

### Task 3 — live timer, step line, smooth text, scroll
Files: `client/chat.ts`, `public/quiet.css`.
- Poll at 700ms while running (Decisions). Add a 1s interval that sets `.activity-line` text for running turns via `runningLabel`.
- Running turn: render `<p class="step-tick">` under the activity line with the latest step; fade swap on change (`.step-tick.out { opacity: 0 }`, `transition: opacity .3s`).
- Finished turn with steps: render the activity line as `<details class="turn-steps"><summary>Worked …</summary><ol>…</ol></details>`.
- Text growth: patch only the `.md` node; add `md-in` to new top-level blocks. CSS: `.md-in { animation: md-in 220ms ease-out both } @keyframes md-in { from { opacity: 0; transform: translateY(4px) } }`.
- Scroll per Decisions (`stage.scrollTo({ top: stage.scrollHeight, behavior: 'smooth' })` after send).
- Commit: `feat(chat): live thinking timer, fading step line and smooth reply reveal`

### Task 4 — full markdown
Files: `package.json`, `client/markdown.ts`, `test/markdown.test.ts`, `public/quiet.css`.
- `bun add marked dompurify` (and `@types/dompurify` only if types are missing).
- `renderMarkdown(source: string): DocumentFragment` keeps its signature and class names (Decisions).
- Tests: `[a](http://x.dev)` → an `a.md-link` with `href="http://x.dev"`, `target="_blank"`, `rel="noopener noreferrer"`; a GFM table → `table.md-table` with 2 `th`; `~~gone~~` → `del`; `<img src=x onerror=alert(1)>` → no `onerror` attribute in output; existing code-block and list tests keep passing.
- CSS: `.md-link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px }`, `.md-table { border-collapse: collapse; font-size: 13px; margin: 0 0 1em }`, `.md-table :is(th,td) { border: 1px solid var(--line); padding: 6px 10px; text-align: left }`.
- Commit: `feat(chat): replies render full markdown with links and tables`

### Task 5 — agent report row
Files: `client/chat.ts`, `client/chat-view.ts`, `test/chat-view.test.ts`, `public/quiet.css`.
- Export `parseAgentReport(prompt: string): { label: string; engine: string; outcome: string; body: string } | null` in `client/chat-view.ts`.
- Tests: `'[agent say-hi html · glm] done\nall good'` → `{ label: 'say-hi html', engine: 'glm', outcome: 'done', body: 'all good' }`; `'hello'` → `null`.
- `agentRow` renders the compact row (Decisions) when parse succeeds.
- Commit: `feat(chat): agent reports show as a compact row with a report toggle`

### Task 6 — calmer hover and readable text
Files: `client/backdrop.ts`, `public/quiet.css`.
- Apply the two constant changes and the text-shadow rule from Decisions.
- Commit: `fix(ui): calmer backdrop hover and a soft halo behind text`

## Tests to run while iterating
`bun test test/activity.test.ts test/threads.test.ts test/chat-profile.test.ts test/chat-view.test.ts test/markdown.test.ts test/shell-typecheck.test.ts`

## Visual check (required before reporting done)
Run a throwaway server: `MISSION_CONTROL_CONFIG_DIR=$(mktemp -d) MISSION_CONTROL_PORT=7791 MC_FAKE_ENGINES=1 bun server/index.ts` (never touch port 7777; stop it by its PID when done). Load a chat whose log contains the fixture from Task 1 plus a finished reply with a markdown link and a table, screenshot it, and report the screenshot paths.

## Constraints
- Do not push. Do not restart or kill the running Mission Control on port 7777.
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- While iterating run only the tests for files you touch; run the full suite ONCE at the end.
- Only edit `public/quiet.css` by adding new rules or changing the rules named in your task; other lanes edit the same file in parallel.
