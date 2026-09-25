# Mission Control

**Your terminals, coding agents, and work in one browser tab.**

Mission Control is a self-hosted workspace for Claude Code, GLM through an Anthropic-compatible endpoint, and OpenAI Codex CLI. Open sessions as readable transcripts or raw shells, follow the agents working on the selected session, check provider usage in the header, and review completed work without losing your terminal context.

![Mission Control: split terminals, agent activity, and provider usage](docs/images/workspace.gif)

*Recorded from the app with sample sessions, agent output, and usage values: a new session from the ⌘K composer, the transcript filling in, an agent conversation, a second pane, the raw shell, and the workspace folded down to the terminals. [View the still image](docs/images/workspace.png).*

## Why

When work spans several coding agents, terminal output, usage limits, and review results are easy to lose track of. Mission Control keeps them together:

- **Stay in your terminal.** Visit Main, Review, or Settings and return to the same sessions and scrollback.
- **Read the session, not the escape codes.** Claude Code and Codex sessions render as a transcript: prompts, thinking, tool calls with their results, and Markdown answers. The raw shell is one keystroke away.
- **See the current work.** A branched flow above the panes and agent cards in the sidebar show the work linked to the selected terminal, and both fold out of the way.
- **Find the results.** Search conversations and plans, inspect changes, and acknowledge reviews in one work navigator.

## Features

### Terminal workspace

The terminal takes the screen. Each pane has a one-line header (session, engine, connection state, directory) with quiet tools for find, reconnect, hide, and end, and the deck fills whatever height and width the window has.

Sessions open from a dock popover (⌘K or **New terminal**): pick Claude Code, GLM, or Codex with a chip, choose a model, and pick a recent directory or type one. The **Resume** tab lists earlier Claude Code sessions for a directory and reopens one in place. Arrange up to four panes side by side or stacked, drag the divider or double-click it to recentre, rename a session with F2, and switch sessions with ⌘1–9. Navigation preserves the live terminal connections, and narrow screens show the selected pane while keeping the saved split.

**Transcript and shell.** A Claude Code or Codex session renders as a transcript read from the session's own log: the prompt, collapsible thinking, tool rows that expand to their result, and Markdown answers with code blocks, lists, and headings. A working line shows the current tool and elapsed time, and the session strip labels each session Idle, Ready, Working, or Waiting for you. A composer under the transcript sends the next direction. ⌘J switches the same pane to the raw shell, an xterm.js terminal in JetBrains Mono with find (⌘F) and full scrollback; the choice is remembered per session.

### Flow and agents

Above the panes, a collapsible flow shows the plan attached to the selected terminal's work: steps light up as engine jobs run and settle when they finish, and a follow-up reply reactivates the step it belongs to. The agent sidebar on the right holds one card per running conversation with its latest tool and activity; it opens itself when agents are working on the selected terminal and folds when none are, and a manual close stays closed. Expanding a card opens the full conversation in a fullscreen modal where you can reply, and reviews stay with the conversation they review. Confirmations use in-app dialogs, never browser prompts.

### Provider usage

The header shows every provider's usage in the same position: a five-hour window with weekly usage underneath for Claude and GLM, and the weekly window alone for Codex, which has no five-hour limit. Reset times appear on hover, and a value observed more than a few minutes ago carries its age.

| Provider | Usage source |
|---|---|
| Claude Code | The `ccstatusline` cache when it is under twelve hours old, otherwise a labeled `ccusage` estimate refreshed at most every fifteen minutes |
| GLM | Five-hour and monthly usage from the z.ai monitor API; weekly usage is unavailable |
| Codex | Weekly window reported by the Codex CLI account API |

Missing or unsupported windows draw an empty track instead of a number. Claude cost and token estimates remain separate from reported quota limits.

### Work, dispatch, and review

Search and filter conversations and plans in Main. Dispatch background `claude -p` or `codex exec` jobs, optionally in isolated worktrees; follow streamed output, reply with follow-up work, or stop a running job. Review completed changes, mark them reviewed, and land finished worktrees through the existing landing action.

### Settings

Settings shares the terminal identity: engine chips assign the plan, execute, and review roles, a switch controls automatic review, and connection pills show Claude, Codex, GLM, and cockpit-token state with a test button beside each. Saved defaults refresh in the workspace while preserving forms you have already started editing.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.2.

```sh
git clone https://github.com/LynchzDEV/mission-control.git
cd mission-control
bun install
bun run start
```

Open [Mission Control](http://127.0.0.1:7777). On your first visit, create a password (argon2id, minimum 10 characters). Then:

| Engine | Setup |
|---|---|
| Claude Code | Works out of the box if `claude` is installed and logged in |
| GLM | Settings → paste your z.ai coding-plan API key (or any Anthropic-compatible endpoint + token) |
| Codex | `codex login` once in any terminal |

```sh
bun test
```

The test suite runs offline without engine CLIs. To regenerate the static development preview on the existing server, run `bun scripts/render-ui-preview.ts` and open `/ui-preview/terminals.html`. Generated preview files are ignored by Git; the preview uses the server's work data, with Settings writes disabled.

## Claude Code skill

Installing Mission Control also installs the `mc-dispatch` orchestration skill into Claude Code. The skill carries an acceptance baseline for every worker: run the specs you touched or that reference your change (never the full suite), no forced waits and no warnings or errors in the output, and nothing on the remote lost or made incompatible, with evidence in the completion note. The orchestrator runs the full suite or `bin/ci` once, at landing. `bun install` (or the first cockpit start) links `~/.claude/skills/mc-dispatch` to `skills/mc-dispatch` in this repo — so the skill is a symlink, and `git pull` updates it with no further action. An existing hand-written copy at that path is never overwritten: it is moved aside to `~/.claude/skills-backup/mc-dispatch.pre-mission-control-<timestamp>` before the link is created — deliberately outside `skills/`, so Claude Code never loads the backup as a second skill.

On `bun install` and every cockpit start, Mission Control translates Claude's global instructions, skills and Markdown agents for Codex, skipping incompatible orchestration assets while keeping clean skills and supporting resources symlinked. Generated instructions and translated skills are real files, displaced personal assets are preserved under `~/.codex/backup/`, and unchanged output keeps its mtime; GLM continues to share `~/.claude`, while isolated worker profiles stay slim.

## Architecture

```
Bun + Elysia (TypeScript end to end)
├── server-rendered JSX views (@kitajs/html) — no client framework
├── client "islands" bundled on demand by Bun.build — no separate build step
├── bun-pty ↔ xterm.js over WebSocket for terminals
├── SSE for live job logs
└── JSON state in ~/.config/mission-control — no database
```

The application is written in TypeScript and CSS; client bundles are cached until their source changes. Transcripts come straight from the engines' own session logs (`~/.claude/projects` JSONL and `~/.codex/sessions` rollouts) and are parsed once per file change. JetBrains Mono ships with the app under the OFL. Standalone design studies and their capture tools live in `docs/design/ui-overhaul/`.

## Security

- Binds `127.0.0.1` only; the port comes from `MISSION_CONTROL_PORT` (default 7777). Requests are served only to local browsers (Host/Origin/Fetch-Metadata guard) or with the API token; health and static assets are public.
- Sessions are HMAC-signed httpOnly cookies; login is rate-limited (5 failures → 60s lockout).
- Credentials are stored in `~/.config/mission-control/` (`0700` dirs, `0600` files). Provider credentials are passed to engines through their environment. Settings can explicitly reveal or rotate the separate cockpit API token after authentication.
- Jobs and terminals only run in directories that resolve (post-symlink) under `$HOME`; traversal attempts are rejected.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — full engineering contract
- [`docs/decisions/`](docs/decisions/) — recorded runtime decisions (e.g. why bun-pty over node-pty under Bun)
- [`docs/design/ui-overhaul/terminal-components.html`](docs/design/ui-overhaul/terminal-components.html) — the approved terminal component study
- [`docs/decisions/ui-overhaul-verification.md`](docs/decisions/ui-overhaul-verification.md) — visual checks, responsive behavior, and known differences from the study
- [`docs/design/`](docs/design/) — design studies: the new quiet design (`quiet-chat`), its chat, launcher and Terminals studies, the earlier overhaul and Studio prototypes
- [`docs/new-design-port-status.md`](docs/new-design-port-status.md) — every current feature tracked against the new design
- [`assets/`](assets/) — shared theme tokens and vendored scripts copied into `public/` on install

## Contributing

Issues and PRs welcome. Before submitting: `bun test` must stay green, TypeScript only, no new runtime dependencies without a note in `docs/decisions/`, and follow the existing conventional-commit style.

## License

[MIT](LICENSE)
