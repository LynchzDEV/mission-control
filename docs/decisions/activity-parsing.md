# Activity parsing

Jobs run `claude -p --output-format stream-json --verbose` (and `codex exec --json`), so a job log is
newline-delimited JSON, one event per line. `server/activity.ts` turns that log into a short feed of
`{ ts?, kind, title, detail }` events so the cockpit can show what the engine is actually doing
instead of inferring a stage box from job status.

## Event shapes assumed

The parser is line-wise and defensive: any line that does not start with `{`, does not parse as JSON,
or does not match a shape below is skipped. A truncated first line (the tail buffer starts mid-line)
is dropped the same way. Nothing throws on a malformed log.

| Line | Produces |
| --- | --- |
| `{"type":"system","subtype":"init",...}` | nothing — session boilerplate |
| `{"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}` | `text` event, detail = first 80 chars |
| `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{…}}]}}` | `tool` event, title = tool name, detail = humanised input |
| `{"type":"user","message":{"content":[{"type":"tool_result",…}]}}` | nothing — a tool result is the echo of a `tool_use` already shown |
| `{"type":"result","subtype":"success","is_error":false,"result":"…"}` | `result` event |
| `{"type":"result","is_error":true,...}` or a `subtype` containing `error` | `error` event |
| codex `{"id":"0","msg":{"type":"agent_message","message":"…"}}` | `text` event |
| codex `{"id":"1","msg":{"type":"exec_command_begin","command":["bash","-lc","…"]}}` | `tool` event titled `Bash` |
| codex `{"msg":{"type":"error","message":"…"}}` | `error` event |

One assistant message can carry several content blocks, so one line can produce several events; they
keep their in-message order. A `ts` field is emitted only when the line actually carries `ts` or
`timestamp` (number, or a string `Date.parse` accepts) — the claude stream does not carry one today,
so most events have no timestamp rather than a fabricated one.

Codex shapes other than the three above are skipped rather than guessed at. When the codex event
schema changes, the log still renders — the feed just goes quiet for that engine, which is a visible
signal rather than a crash.

## Humanised tool detail

One line, at most 60 characters (a longer value is cut and suffixed with `…`), whitespace collapsed:

- `Edit` / `MultiEdit` / `Write` / `Read` → `file_path`; `NotebookEdit` → `notebook_path`
- `Bash` → `description` when present, otherwise the command
- `Grep` / `Glob` → `pattern`; `WebFetch` → `url`; `WebSearch` → `query`; `Task` / `Agent` → `description`
- any other tool → the first non-empty string among the generic keys, then the first string value in
  the input at all, then empty

New tools therefore render something useful without a code change, and a tool with no string input
(`TodoWrite`) shows just its name.

No extra redaction happens here. Job logs are already token-redacted on the way to disk
(`createLogRedactor` in `server/jobs.ts`), and re-redacting a parsed feed would only add a second
place to keep in sync.

## Ordering and cap

`parseActivity(log, max = 50)` returns events oldest-first and keeps the **last** `max` — a live
ticker wants the newest events, and `currentActivity()` reads the last meaningful one. The client
reverses for display (newest at top).

`currentActivity(events)` formats one line: `text` events show their text, everything else shows
`TITLE · detail` (or just the title when there is no detail). Events that would render as an empty
string are skipped, so a trailing content-free block does not blank the ticker.

## Throttle

`createActivityThrottle(intervalMs, now)` is a first-call-wins gate: `ready()` is true immediately,
then false until `intervalMs` has passed. The clock is injected so the 2-second recompute budget is
unit-testable without waiting. `server/jobs.ts` keeps a bounded in-memory tail (16 KB) of each running
job's output and only re-parses it when the gate opens, so a chatty job costs one parse per 2 s
instead of one per write.

The summary lives in memory only — `JobRecord` (and therefore `jobs.jsonl`) is unchanged, because a
line of "what is it doing right now" is not worth persisting and would rewrite the record on every
chunk. It is attached at the API layer: `GET /api/jobs` rows carry `currentActivity`, and
`GET /api/jobs/:id/activity` parses the log file at request time for the full feed.
