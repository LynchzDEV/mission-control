# Mission Control

**One chat that runs your coding agents.**

Mission Control is a local workspace for AI coding agents: Claude Code, GLM (through any Anthropic-compatible endpoint), OpenAI Codex, and any ACP, OpenCode or headless-CLI agent you connect. You describe the work in a chat. The chat answers directly, or spins up agents in isolated git worktrees, has a *different* AI family review every change, and lands it on your branch. Live terminals, a workflow Studio and your whole history sit in the same window.

It runs on your machine, binds to `127.0.0.1`, and keeps its state in plain JSON files. No database, no cloud service, no build step.

![Mission Control: one sentence in the chat, a team of AI agents does the work, and a different AI reviews it before it lands](docs/images/demo.gif)

## Quickstart

Requires [Bun](https://bun.sh) 1.2 or newer.

```sh
git clone https://github.com/LynchzDEV/mission-control.git
cd mission-control
bun install
bun start
```

Open [http://127.0.0.1:7777](http://127.0.0.1:7777), then connect the AIs you use:

| AI | Setup |
|---|---|
| Claude Code | Works as soon as `claude` is installed and signed in |
| GLM | Studio → Manage AIs → GLM: paste your z.ai base URL and token |
| Codex | Run `codex login` once in any terminal |
| Others | Studio → Manage AIs → Add an AI (ACP agent, OpenCode, or a headless CLI) |

## A tour

### Chat

Type what you want. The folder chip picks the project, or leave it on **Auto** and the chat works it out. The AI chip picks who answers, and the pencil chip lets the chat edit files directly.

- **Replies stream in** as they are written. While the AI works you see a live `Thinking · 4s` / `Writing · 12s` line and a single fading line with the step it is on (`Reading client/chat.ts`, `Running bun test`). When it finishes, the steps fold under `Worked 39s · used 4 tools`.
- **Full markdown**: links, tables, code blocks, lists. Model output is sanitized before it reaches the page.
- **Agents**: when the work is bigger than a reply, the chat spawns agents. The reply grows a team card with one row per agent (AI, model, why it was picked, and its state: Running, In review, Landed, Needs you). Agents report back into the chat on their own; their reports show as a compact row with a **Show report** toggle.
- **Queue**: you can keep writing while the chat replies; messages wait under the conversation and send when it is done.
- **Safety net**: every code change is reviewed by a different AI family before it lands, a failed step is retried up to three times on different AIs, and the chat never pushes or deploys.

### Agents and Flow

The **Agents** button (top right) opens a drawer that follows the chat you are in. Each agent is one row with its AI, running time and status, plus one grey line showing what it is doing right now. Click an agent to open its live log, send it a message, or stop it.

The **Flow** button shows the same work as a graph: nodes for each step and agent, lines that draw in, a flowing dash toward the step that is running, and a pulse on the active node.

### Sidebar and terminals

The sidebar on the left lists your chats and live terminals, grouped by Today, Yesterday and Earlier. A dot shows what needs attention: purple while working, green for a live terminal or landed work, red when something needs you. It starts collapsed as a slim icon strip; the toggle slides it open.

**New terminal** opens Claude Code, GLM, Codex or any connected agent in a real terminal, in any folder under your home. Terminals live in the sidebar next to your chats:

- double-click a name to rename it, hover for the × to end it
- drag a terminal onto the screen to open it beside or below the current one
- each terminal has a small bar in its corner with its name, a Live indicator and Find (⌘F)
- links are clickable, and dropping files types their paths at the prompt

### Studio

**Studio** (top right) is where you shape how your AI team works:

- **Workflows**: describe one and an AI drafts it, or start from the default (plan → verify → execute → cross-family review), a template, or scratch. Steps sit on a canvas with success, failure and needs-help branches. Each step shows what it does and which AI does it (**Chat decides**, or a pinned AI and model), and can carry skills, tools and acceptance checks. While a workflow runs, the canvas shows which steps passed, which one is running, and where it failed.
- **Manage AIs**: every connected AI with its usage, the role it plays, its models and its settings.
- **Runs**: every run with its attempts, evidence and checks.
- **Rules**: the core rules every step follows.

### Plugins

**Marketplace** (sidebar footer) adds plugins from git. Add a marketplace link (for example `https://github.com/LynchzDEV/mc-marketplace`), pick a plugin and install it; it then shows under **Plugins** at the top of the sidebar. The first plugin, **ClickUp board**, shows a ClickUp board and starts a chat or terminal on any task, with a dossier of the task (description, subtasks, comments, linked tasks, fields) attached for the AI to read first.

- **Isolated** plugins run under the macOS sandbox: they reach only the hosts they declared, read only their own bundle and data folder, never see your other secrets, and draw their screen in a locked frame. Isolated plugins that use the network need Bun 1.2.23 or newer (`bun upgrade`).
- **Trusted** plugins load straight into Mission Control and get full access, so installing one asks you to confirm you trust it.
- A plugin can open the launcher for a chat or terminal, never start one on its own. Its task context is saved in the session folder under `.mission-control/` (kept out of git through `.git/info/exclude`).

Write your own: start from [mc-plugin-template](https://github.com/LynchzDEV/mc-plugin-template) and the [mc-plugin-sdk](https://github.com/LynchzDEV/mc-plugin-sdk) guide. Design: `docs/superpowers/specs/2026-10-04-plugins-marketplace-design.md`.

### History

**All history** (bottom of the sidebar) and search open one searchable list: chats, live terminals, earlier Claude Code sessions (resume one in a terminal), and Claude or Codex sessions you started outside Mission Control. Only real sessions are listed: Mission Control's own agents, background helpers, MCP servers and non-interactive runs are left out.

### Usage

The top bar shows each provider's usage in the same place:

| Provider | What you see | Source |
|---|---|---|
| Claude Code | 5-hour window, weekly underneath | `ccstatusline` cache when under 12 hours old, otherwise a labelled `ccusage` estimate |
| GLM | 5-hour window | z.ai monitor API |
| Codex | Weekly window | Codex CLI account API |

Reset times appear on hover.

## Configuration

Mission Control needs no config file. These environment variables change its behaviour:

| Variable | Default | What it does |
|---|---|---|
| `MISSION_CONTROL_PORT` | `7777` | Port to listen on (always on `127.0.0.1`) |
| `MISSION_CONTROL_CONFIG_DIR` | `~/.config/mission-control` | Where state, logs and credentials live |
| `MC_LOG` | quiet | `verbose` logs every request, not just changes and errors |
| `MC_FAKE_ENGINES` | off | `1` swaps the AI CLIs for harmless stand-ins, for development and tests |

### Server log

`bun start` prints one line per event, prefixed with the local time:

```
12:04:31  job started  say-hi html · glm/glm-5.3 · 56c345dc
12:04:31  POST /api/jobs 200 17ms
12:05:43  job done  say-hi html · 1m12s · 56c345dc
12:06:02  GET /api/nope 404 1ms
```

By default it logs jobs starting and finishing, requests that change something, and every failed request. The chat and sidebar poll in the background every few seconds, so ordinary reads stay quiet unless you run `MC_LOG=verbose bun start`. Request bodies and query strings are never printed.

## Command line

`mctl` drives a running Mission Control from a shell, for people and for AI agents. Install it once with `bun link` in the repo, then run `mctl` (banner, version and every command) or `mctl <group> --help`, e.g. `mctl job --help`. `mctl --version` prints the version. For the manual page, link it once with `mkdir -p ~/.local/share/man/man1 && ln -sfn "$PWD/man/mctl.1" ~/.local/share/man/man1/mctl.1`, then `man mctl`.

```sh
mctl status                          # up/down, usage per provider, role -> engine
mctl jobs --limit 10                 # newest jobs
mctl job new "Fix the flaky test" --cwd ~/code/app --follow
mctl attention                       # what is waiting on you
mctl runs                            # workflow runs
mctl plugin add https://github.com/LynchzDEV/mc-plugin-clickup --yes
mctl clickup board main              # the board, saved filters applied
mctl clickup filter add main Assignee "is any of" --value Me
mctl clickup start 86d4ccpu2 --board main   # chat with the task dossier attached
mctl queue add clickup-board 86d4ccpu2 --repo ~/code/app   # build it when its turn comes
```

- `--json` prints the server's JSON as one document (NDJSON for `job follow` and `job new --follow`); every command supports it.
- `--url` > `MC_URL` > `http://127.0.0.1:7777`. Local URLs need no token. For other URLs set `MC_TOKEN`; otherwise `apiToken` from `secrets.json` is used when present.
- Exit codes: `0` ok, `1` API error (message on stderr), `2` usage error, `3` Mission Control isn't running.

## The Claude Code skill

`bun install` (and every server start) links `~/.claude/skills/mc-dispatch` to `skills/mc-dispatch` in this repo, so `git pull` keeps the skill current. With it, a Claude Code session can hand work to Mission Control: it plans, dispatches jobs to the right AI, and reviews them, while you watch the jobs in the Agents drawer and the Flow graph. An existing hand-written skill at that path is moved to `~/.claude/skills-backup/` first, never overwritten.

On the same occasions, Mission Control translates Claude's global instructions, skills and agents for Codex, so both AIs follow the same rules. Codex-incompatible pieces are skipped, and any personal Codex files it replaces are kept under `~/.codex/backup/`.

## Security

- **Local only.** The server binds `127.0.0.1`. A Host / Origin / Fetch-Metadata guard stops web pages from other origins from reading or driving it. Anyone who can open a local connection on this machine has full control, including other OS user accounts and the agent jobs Mission Control spawns.
- **Credentials** live in the config directory (`0700` folders, `0600` files) and reach the AIs only through their environment. The API token, for scripts and the skill, can be revealed or rotated from the lock button; it grants nothing extra to local callers.
- **Folders.** Jobs and terminals only run in directories that resolve, after symlinks, under your home folder.
- **Plugins.** Plugin routes are local only and never accept the API token. Isolated plugins are confined by the OS sandbox and a per-plugin network proxy; trusted plugins have full access and install only after you confirm.
- **Model output** shown in the chat is sanitized: no scripts, styles, forms, embedded images or element ids from a reply reach the page.

## How it is built

```
Bun + Elysia, TypeScript end to end
├── one server-rendered page; Studio is a React island (React Flow canvas)
├── client files bundled on demand by Bun.build, no separate build step
├── bun-pty ↔ xterm.js over WebSocket for terminals
├── the AI CLIs' own JSON streams for live chat, activity and transcripts
└── JSON state in the config directory, no database
```

Transcripts come straight from each engine's own session logs (`~/.claude/projects` and `~/.codex/sessions`). The look is one stylesheet, `public/quiet.css`: a soft neumorphic surface with an Apple-style corner scale (`--r-xs` … `--r-lg`, continuous corners). JetBrains Mono ships with the app under the OFL.

## Development

```sh
bun test                    # full suite, offline, no AI CLIs needed
bun test test/chat-view.test.ts
bun run typecheck:studio    # Studio's React code
MISSION_CONTROL_CONFIG_DIR=$(mktemp -d) MISSION_CONTROL_PORT=7790 MC_FAKE_ENGINES=1 bun server/index.ts
```

The last line runs a throwaway copy on another port with an empty config and fake AIs, which leaves your real instance and data alone.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md): the full engineering contract
- [`docs/decisions/`](docs/decisions/): recorded decisions (why bun-pty, how the chat works, the markdown renderer, …)
- [`docs/design/redesign-2-1/`](docs/design/redesign-2-1/): the current design: mockups and [`DECISION.md`](docs/design/redesign-2-1/DECISION.md) for the sidebar, Agents, Flow, Studio, terminal bar and corner scale
- [`docs/design/`](docs/design/): earlier design studies
- [`docs/superpowers/plans/`](docs/superpowers/plans/): implementation plans

## Contributing

Issues and pull requests are welcome. Keep `bun test` green, write TypeScript, add a note in `docs/decisions/` for any new runtime dependency, and use conventional commits (`feat:`, `fix:`, `docs:` …).

## License

[MIT](LICENSE)
