# Mission Control — Multi-Engine Claude Code Command Center

Local web UI to control the three-engine setup: Claude Code (Anthropic), GLM lane (z.ai coding plan via Anthropic-compatible endpoint), Codex CLI (ChatGPT Pro plan).

## Stack (fixed — do not substitute)

- Runtime: **Bun** (latest stable), TypeScript executed natively by Bun — NO build step, no bundler
- Backend: **Elysia** + `@elysiajs/static` + `@elysiajs/cookie`; websockets via Elysia's built-in `ws`; SSE via Elysia stream/generator responses
- Terminals: `node-pty` under Bun (N-API). MUST verify it builds/runs under Bun in step 1 of implementation; if broken, fall back to `bun-pty` or spawning `script -q /dev/null <cmd>` piped over stdio — state which path was taken
- Auth/session: signed httpOnly cookie (HMAC via Bun.CryptoHasher or `@elysiajs/jwt`), password hashed with `Bun.password` (argon2id built-in — replaces bcryptjs)
- Frontend: server-rendered via Elysia `@elysiajs/html` (typed JSX views in `server/views/*.tsx`, one per tab + login) — no static index.html, no client framework, no client router. Client code is TypeScript too: islands live in `client/` as `.ts` (`terminal.ts` xterm.js+ws, `logs.ts` SSE tail, `sprites.ts` textmode.js sketches, `forms.ts` fetch POSTs); an Elysia route `GET /js/:name.js` transpiles the matching `client/*.ts` via Bun.build (in-memory, cached, no dist/ on disk). Repo contains zero .js files. `xterm.js` + fit addon + `textmode.js` served from `node_modules`. No Tailwind, no bundler.
- No database. JSON files under `~/.config/mission-control/` (create with mode 0700, files 0600)
- Server binds `127.0.0.1:7777` by default; `config.json` key `bind` may widen it (for Tailscale)
- Tests: `bun test` (replaces node --test everywhere below)

## Directory layout

```
mission-control/
  server/
    index.ts          # Elysia bootstrap, cookie auth guard, static, route mounting
    auth.ts           # setup + login + session guard
    secrets.ts        # read/write ~/.config/mission-control/secrets.json (0600)
    engines.ts        # engine definitions + env builders + status checks
    quota.ts          # quota fetchers: claude (ccusage), glm (z.ai monitor API), codex (login status)
    jobs.ts           # headless job dispatch: spawn, log capture, list, stream (SSE)
    terminals.ts      # node-pty sessions + ws bridge for xterm.js
  server/views/       # JSX: layout.tsx, login.tsx, lanes.tsx, dispatch.tsx, terminals.tsx, review.tsx, settings.tsx
  client/             # browser islands, TypeScript: terminal.ts, logs.ts, sprites.ts, forms.ts
  public/
    theme.css
    vendor/           # copied xterm + textmode assets (postinstall script)
  package.json
  README.md
  docs/SPEC.md
```

## Auth

- First visit with no password hash stored → setup page: choose password (min 10 chars) → Bun.password (argon2id) hash into `~/.config/mission-control/auth.json`.
- Login → signed httpOnly session cookie (`sameSite: lax`; HMAC secret generated once, persisted in auth.json). All `/api/*` and `/ws/*` require session; unauth → 401 → frontend shows login.
- Rate-limit login: 5 fails → 60s lockout (in-memory).

## Secrets (UI-entered, server-stored)

Settings page fields, all stored in `~/.config/mission-control/secrets.json`:
- `zaiAuthToken` — z.ai API key (write-only in UI: show `set/unset`, never echo value back to browser)
- `zaiBaseUrl` — default `https://api.z.ai/api/anthropic`
- API responses must NEVER include token values — only boolean `configured` flags.
- "Test" button per engine: GLM → hit quota endpoint with token; Claude → run `claude --version` and check `~/.claude` auth presence; Codex → `codex login status` (parse exit code/stdout).

## Engines (engines.ts)

```js
const ENGINES = {
  claude: { cmd: 'claude', env: {} },                       // inherits user's normal auth
  glm:    { cmd: 'claude', env: {
              ANTHROPIC_BASE_URL: secrets.zaiBaseUrl,
              ANTHROPIC_AUTH_TOKEN: secrets.zaiAuthToken,
              ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
              ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash',
              ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash' } },
  codex:  { cmd: 'codex', env: {} },                        // ChatGPT OAuth already on machine
}
```
Env for spawned processes = `process.env` + engine env overlay. Secrets must never be passed as CLI args (ps leakage) — env only.

## Quota (quota.ts) — GET /api/quota

- `claude`: run `npx ccusage@latest blocks --json` (fallback `ccusage daily --json`); parse today's tokens + active block. If ccusage missing/errors → `{available:false}`.
- `glm`: GET `{zaiBase domain}/api/monitor/usage/quota/limit` and `/model-usage` with header `Authorization: <token>`, `Accept-Language: en-US,en`. Time window params `startTime/endTime` format `yyyy-MM-dd HH:mm:ss` (yesterday same hour → now). Surface `TOKENS_LIMIT` percentage as the 5-hour quota bar. (Endpoint shapes verified from z.ai glm-plan-usage plugin.)
- `codex`: `codex login status` → `{authed:boolean}` only.
- Also compute GLM peak flag: peak = Mon–Fri 14:00–18:00 UTC+8. Return `{peak:boolean, minutesToChange:n}`.
- `external`: GET /api/sessions/external — `ps -axo pid,etime,command` scan for running `claude`/`codex` processes NOT owned by this server (exclude own job/terminal pids); return `[{pid, engine, etime, cwdHint}]` (cwd via `lsof -p <pid> -a -d cwd -Fn`, best-effort). Lanes cards show these as "external sessions" so terminal-started work is visible too.
- Cache quota responses 60s server-side.

## Jobs (jobs.ts) — headless dispatch

- POST `/api/jobs` `{engine, cwd, prompt, label}` → validate `cwd` exists and is a git repo; spawn:
  - claude/glm: `claude -p <prompt> --output-format stream-json --verbose` in `cwd` with engine env
  - codex: `codex exec --json <prompt>` in `cwd`
- Job record `{id, engine, cwd, label, pid, status: running|done|failed, startedAt, endedAt, exitCode}` in memory + appended to `~/.config/mission-control/jobs.jsonl`; stdout/stderr → `~/.config/mission-control/logs/<id>.log`.
- GET `/api/jobs` list; GET `/api/jobs/:id/log` full log; GET `/api/jobs/:id/stream` SSE tail (fs.watch + offset).
- POST `/api/jobs/:id/kill` → SIGTERM.
- After job completes on a git cwd: run `git -C cwd diff --stat HEAD` capture into job record (`diffStat`) for the review queue.

## Terminals (terminals.ts) — live sessions

- POST `/api/terminals` `{engine, cwd}` → node-pty spawn interactive (`claude` / `claude` w/ glm env / `codex`), cols/rows from client.
- WS `/ws/terminal/:id` bridges pty <-> xterm.js (binary/utf8 passthrough, resize message `{type:'resize',cols,rows}`).
- Terminals persist while server runs (detach/reattach on reconnect); DELETE kills pty.
- Session guard on the WS upgrade (verify the signed cookie before accepting).

## Frontend (server-rendered tabs)

Each tab = an Elysia route rendering a JSX view inside layout.tsx; tab nav = plain links. Tabs: **LANES** (default) | **DISPATCH** | **TERMINALS** | **REVIEW** | **SETTINGS**

- LANES: 3 engine cards — name, live textmode.js mascot sketch (idle anim; "working" anim when engine has running jobs/terminals; "error" glitch on failed check), quota bar, peak badge on GLM card with countdown, test-connection result.
- DISPATCH: form (engine select, cwd picker = text input with recent list, prompt textarea, label) + jobs table (status dot, engine, label, elapsed, tail-log drawer via SSE, kill button, diffStat when done).
- TERMINALS: tab strip of live terminals + "new terminal" (engine + cwd), xterm.js fills pane, fit addon on resize.
- REVIEW: jobs with non-empty diffStat and status done, newest first; each row: cwd, label, diffStat, button "Copy review cmd" → copies `cd <cwd> && claude --continue` to clipboard.
- SETTINGS: password change, z.ai token input, bind address, engine test buttons.

## Theme — geek minimalist retro 8-bit (DO NOT hand-craft art)

- Font: "Press Start 2P" (Google Fonts) for headings/labels, system monospace for body/logs.
- Palette: near-black `#0d0d0f` bg, terminal green `#33ff66` primary, amber `#ffb000` warnings, Claude coral `#d97757` accents, 2px pixel borders, no border-radius, no gradients, no box-shadow blur (hard offset shadows only).
- Live animation/FX engine: `textmode.js` (npm `textmode.js`, MIT, zero deps, WebGL2) — used for animated textmode sketches (engine mascots/status animations, ambient background, working-state effects) and its GPU filter chain (CRT distortion, scanlines, bloom, grain) instead of hand-rolled CSS effects. Design mockups define WHICH sketches/filters run where; implementation embeds them per the mockups.
- Secondary sprite option: claudepix (https://claudepix.vercel.app) — v0.1, self-contained HTML/CSS 20×20 creature animation presets, copy-paste. `public/sprites/README.md` documents pasting presets in if used.
- NEVER hand-draw custom SVG art; animation comes from textmode.js sketches or claudepix presets only.
- Buttons/inputs: chunky 8-bit style — uppercase, letter-spacing, 2px solid borders, active state translates 2px (pressed look). All via CSS, no images.

## Security constraints (hard requirements)

- Bind localhost by default. If `bind` widened, auth still mandatory.
- Secrets never in logs, never in API responses, never as argv, never in client JS.
- `cwd` for jobs/terminals must be under `$HOME` — reject otherwise (path traversal check after realpath).
- No shell string interpolation: always `spawn(cmd, [args], {env})`, never `exec` with concatenated strings.
- Prompt content passed as single argv element to `claude -p` / `codex exec`.

## Acceptance criteria

1. `bun install && bun start` → http://127.0.0.1:7777 → setup password → login works; wrong password 5x locks 60s.
2. Settings: paste z.ai token → GLM card shows real quota percentage; token value never appears in any network response (verify in devtools).
3. Dispatch a job: engine=glm, cwd=any repo, prompt="say hi and exit" → job runs, log streams live, completes, appears in list.
4. Terminal tab: open claude engine terminal → interactive Claude Code TUI renders and accepts keystrokes in browser.
5. Kill button terminates a running job.
6. GLM card shows peak/off-peak correctly for Asia/Bangkok viewer (peak = Mon–Fri 13:00–17:00 Thai).
7. All 5 tabs render in 8-bit theme, light DOM (< 200KB JS excluding xterm), no framework, no build step.
8. Server restart: jobs history persists (jsonl), terminals gone (documented), session survives via cookie if server secret unchanged.

## Tests

- `bun test` suite for: secrets read/write perms, engine env builder (glm overlay correct, no token leak into claude engine), job record lifecycle with a fake `echo` engine, cwd validation (rejects /tmp, ../ traversal), quota parser fixtures (z.ai limit JSON → percentage; ccusage JSON → tokens).
- Fake-engine mode: `MC_FAKE_ENGINES=1` env makes engines.ts substitute `echo`/`cat`-based stubs so tests and UI dev run without real CLIs.
