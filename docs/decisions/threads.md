# Conversational job threads

A dispatched job used to be a one-shot: prompt in, log out. A thread makes it a conversation — the
job's messages render as a chat, and a reply spawns a *new* job that resumes the engine session the
first job created. Continuation is the engine's own session resume, not a Mission Control invention.

## Verified engine facts

Everything below was captured from the installed binaries on 2026-08-29 in a scratch git repo, not
from documentation.

### claude (`claude` 2.1.251)

```
claude -p "reply with the word alpha and nothing else" --output-format stream-json --verbose
```

produced 34 JSONL lines. **Every** line carries `session_id` — the `system`/`hook_started` lines, the
`system`/`init` line, `assistant`, `rate_limit_event`, and the final `result` line:

| line | shape |
| --- | --- |
| 0 | `{"type":"system","subtype":"hook_started","session_id":"ffef321c-34a3-4c15-a97a-84c221b610ff",…}` |
| 30 | `{"type":"system","subtype":"init","session_id":"ffef321c-…",…}` |
| 33 | `{"type":"result","subtype":"success","session_id":"ffef321c-…","result":"alpha",…}` |

So a session id is available from the *first* line of output — no need to wait for `result`.

Resume, run in the same cwd:

```
claude -p --resume ffef321c-34a3-4c15-a97a-84c221b610ff "what word did you say? repeat it." --output-format stream-json --verbose
```

answered `alpha`. Context is kept. The resumed run reported the **same** `session_id`, so a thread
has one stable id across every turn rather than a new id per reply.

### codex (`codex-cli` 0.150.1)

`codex exec --help` lists a `resume` subcommand ("Resume a previous session by id or pick the most
recent with `--last`"), so codex threads are *not* single-turn. Its id lives on the first event:

```
{"type":"thread.started","thread_id":"01a04b70-93e7-7b21-ac23-4b270688e0f0"}
```

`codex exec resume --json <thread_id> "<prompt>"` answered `bravo` to "what word did you say?" — same
thread id, context kept. Two traps: `resume` rejects `--sandbox`, and it requires flags **before**
the positional id and prompt (`codex exec resume --json <id> <prompt>`, not `… <id> <prompt> --json`).

### Consequence

All three engines (claude, glm — glm is claude's binary against another base URL — and codex) are
resumable, so the reply box is enabled for all of them today. The disabled "single-turn engine" state
is still implemented and reachable: `resumeArgs()` returns `null` for an engine it has no verified
resume invocation for, and the reply route answers 400 rather than guessing a flag.

## Thinking blocks are emitted but empty

Extended thinking is on for this account, and `--verbose` does put `thinking` blocks on the wire:

```
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"CAQS0wQKEAgRGAI4AUIIdGhpbmtpbmcS…"}]}}
```

The block's `thinking` field measured **0 characters**; the 804-character `signature` carries the
encrypted payload. So the reasoning text itself is not available to a headless run — only the fact
that thinking happened, which is not worth a row.

A second observation: thinking blocks are not emitted on every turn. The prompt that produced the
block above explicitly asked the model to think step by step; the live acceptance run
("run echo, then read README.md") produced **zero** thinking blocks across its whole log.

The parser therefore implements `thinking` fully — it becomes a `thinking` row, dim italic, collapsed
to its first line with an expander — but drops a block whose text is empty, exactly as it already
drops an empty `text` block. On the installed claude that means no thinking rows render. Nothing is
faked to fill the gap; if a future version (or a different provider behind the same CLI, e.g. glm)
sends real thinking text, the rows appear with no code change. `test/threads.test.ts` covers both:
a block with text renders in stream position, a signature-only block renders nothing.

## Codex stream shapes

`server/activity.ts` previously only understood a legacy codex envelope (`{"msg":{"type":"agent_message"…}}`).
The installed codex emits neither that envelope nor those type names — it emits
`{"type":"item.completed","item":{"type":"agent_message","text":"…"}}` — so codex activity parsed to
nothing at all. The current shapes are now parsed alongside the legacy ones. Only the two shapes
actually observed (`agent_message`, `error`) are handled; anything else is still skipped rather than
guessed at, per the standing rule in `activity-parsing.md`.

## Record shape

`JobRecord` gains four fields:

- `prompt` — the text the job was launched with. Required, because it *is* the user turn of the
  conversation and lives nowhere else; it was previously handed to the resolver and dropped.
- `sessionId` — the engine session to resume, or `null` until the stream reveals one.
- `parentJobId` — the job this one replied to; `null` for an original dispatch.
- `threadRoot` — the id of the thread's first job; equals the job's own id for an original.

Records written before this change normalise to `prompt: ''`, `sessionId: null`,
`parentJobId: null`, `threadRoot: <own id>`, so an old `jobs.jsonl` renders as a set of one-message
threads instead of failing to load.

### Why persist `prompt`

It is already in the job log (the engine echoes it) and the file is behind the session guard with the
same permissions as the log, so persisting it adds no new exposure. Reconstructing it from the log
instead would make the user turn depend on engine-specific echo formatting.

## Capturing the session id

The activity tail buffer is a *tail* — it drops the head of a long log, and the session id is at the
head. So the session id is scanned from a separate small head buffer: the pump appends output to it
until an id is found (then it is persisted immediately and the buffer dropped) or the buffer passes
`SESSION_SCAN_MAX_CHARS`, at which point the scan gives up rather than growing without bound. The
scan skips any line that does not contain `"session_id"` or `"thread_id"` before attempting a parse,
so it costs a substring test per line on a log that has already yielded its id.

`parseSessionId` keeps the **last** id it sees rather than the first. For both engines observed the id
is constant, but if a future version ever forked mid-run, the id to resume is the newest one.

## Thread assembly

`GET /api/jobs/:id/thread` resolves `:id` to its `threadRoot`, takes every job sharing that root,
orders them by `startedAt`, and for each emits the user turn (`prompt`) followed by that job's parsed
log. Ordering by `threadRoot` + `startedAt` rather than walking `parentJobId` links is deliberate: it
is total (a reply whose parent is missing still renders), and if two replies are ever sent against the
same parent they interleave chronologically, which is what a chat panel wants — a link walk would have
to pick a branch.

## Live rendering

The panel polls `/thread` every 2 s while any job in the chain is running, and stops polling once the
thread settles. Rows are reconciled by a key of `<jobId>#<nth message of that job>` — stable because a
log only grows at the end — so a poll appends rather than rebuilding, keeping scroll position and open
expanders. A tool row with no result yet, in a running thread, gets `pending` (pulsing glyph); a
`…working` cursor sits at the bottom until the thread settles.

One wrinkle the AGENTS panel forces: when a job finishes it moves from the RUNNING list to the RECENT
list, and its card — with any open thread — is destroyed and rebuilt as a different element. An open
thread is therefore remembered by job id and reopened on the row that replaces it, so a conversation
being read does not vanish at the moment the job ends.

`parseThread` is `parseActivity` with the text caps lifted: assistant text and the final result render
in full, with newlines preserved rather than collapsed. Tool detail stays capped at one 60-char line,
because a tool call renders as a single compact row in the panel by design, not as prose. The ticker
path keeps the 80/60 truncation — the two modes share one parser and differ only in those limits.
