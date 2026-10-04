# Plugins + Marketplace — implementation plan

Spec: `docs/superpowers/specs/2026-10-04-plugins-marketplace-design.md` (read it first; this plan resolves every open choice in it).
UI source of truth: `../visualizer/marketplace/` (`DECISION.md`, `market.html`, `board.html`, `b.html`, `mk.css`) — copy markup/classes from there.

Each run below is one cockpit run with one deliverable. Repos: host = `mission-control`; plugin repos live next to it under `/Users/lynchz/Desktop/kingpinggroup/` (`mc-plugin-sdk`, `mc-plugin-template`, `mc-plugin-clickup`, `mc-marketplace`).

## Global decisions (apply to every run)

- Runtime: Bun. Tests: `bun test`, files `test/<name>.test.ts`, `bun:test` API, route tests build `new Elysia().use(routes(...))`, set `process.env.MISSION_CONTROL_CONFIG_DIR` to a `mkdtemp` dir, and call `app.handle(new Request('http://127.0.0.1:7777/...', { headers: { host: '127.0.0.1:7777' } }))` (pattern: `test/chat-routes.test.ts`).
- Host code goes in a new folder `server/plugins/` (one concern per file) plus `server/routes/plugins.ts`. Client code goes in `client/plugins/` plus small hooks in existing files.
- Config dir helpers: export `readJsonFile` and `writeJsonFile` from `server/secrets.ts` (currently private, lines ~78–94) and reuse them; every file written under the config dir is mode 0600, every folder 0700.
- Plugin id regex: `/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/`. Supported plugin API versions: `export const SUPPORTED_PLUGIN_APIS = [1]`.
- Network permission entry regex (plain hostname): `/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/`.
- `context.markdown` max bytes: `524288`. Plugin RPC timeout: `30000` ms. Isolated idle stop: `600000` ms. Crash stop: 3 crashes within `300000` ms. Context sweep age: 30 days.
- Comments: max 1 line, only for a trap no refactor can express. Decision records / measurements / rationale → commit body or docs/decisions/*.md — NEVER comment blocks.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- No polling, no setInterval refresh loops anywhere (concern 6). Timers are allowed only for the idle-stop and RPC timeout, reset on each call.
- While iterating run only the tests for files you touch; run the full suite ONCE at the end.

## Shared contract (host ⇄ SDK ⇄ plugins)

Manifest `mc-plugin.json` fields exactly as spec §4.1. TypeScript shape (both host and SDK define this same type):

```ts
type SettingField = { key: string; label: string; type: 'text' | 'secret'; help?: string }
type PluginManifest = {
  id: string; name: string; version: string; description: string; pluginApi: number
  runtime: 'trusted' | 'isolated'; icon?: string; server?: string; screen?: string
  permissions: { network?: string[]; sessions?: Array<'chat' | 'terminal'>; settings?: boolean }
  settings?: SettingField[]
}
type TaskContext = { name: string; markdown: string }
type SessionRequest = { title: string; cwd: string; context?: TaskContext; prompt?: string }
```

Isolated server protocol: JSON-RPC 2.0 over the child's stdin/stdout with `vscode-jsonrpc` `StreamMessageReader/StreamMessageWriter` (Content-Length framing).
- host → plugin request `plugin.call` params `{ method: string, params: unknown }` → result `unknown`.
- host → plugin notification `plugin.shutdown`.
- plugin → host request `settings.get` params `{ key }` → `string | null`; `settings.set` params `{ key, value: string | null }` → `null`.
- plugin → host notification `log` params `{ message: string }`.
- Env given to the child: `MC_PLUGIN_RUNTIME=isolated`, `MC_PLUGIN_ID`, `MC_PLUGIN_DATA` (absolute path of `plugin-data/<id>/files`).

Isolated screen protocol: the host serves `/plugin-frame/<id>/` = an HTML page that sets `window.__MC_PLUGIN__ = { id, runtime: 'isolated' }`, links `/plugin-frame/<id>/ui.css`, and loads `/plugin-frame/<id>/screen.js` as a CLASSIC script (the screen bundle is built with `Bun.build({ format: 'iife' })` so no CORS is needed from the opaque-origin frame). SDK `defineScreen` sees `__MC_PLUGIN__.runtime === 'isolated'`, builds `mc` with `Comlink.wrap(endpoint)` where the endpoint posts to `window.parent` with targetOrigin `'*'`, and calls `mount(document.getElementById('root'), mc)`. The host exposes the `mc` implementation with `Comlink.expose(api, endpoint)` where the endpoint only accepts messages whose `event.source === iframe.contentWindow`. Callbacks (`onTheme`) cross with `Comlink.proxy`.

Trusted screen: host imports `/plugin-module/<id>/screen.js` (ESM, `Bun.build({ format: 'esm' })`) and calls `mod.default.mount(root, mc)` with a direct `mc` object. `defineScreen(mount)` returns `{ mount }` and only self-mounts when `__MC_PLUGIN__.runtime === 'isolated'`.

`mc` (screen API), every method returns a Promise:
`call(method, params)`, `sessions.startChat(req: SessionRequest)`, `sessions.startTerminal(req: SessionRequest)`, `settings.view() → { values: Record<string,string>, configured: Record<string, boolean> }` (secret fields never appear in `values`), `settings.set(key, value)`, `folders.recent() → string[]`, `ui.toast(text, kind?: 'info' | 'error')`, `theme() → 'light' | 'dark'`, `onTheme(cb)`.

Server-part `ctx`: `settings.get(key)`, `settings.set(key, value)`, `data: string`, `log(message)`.

---

## Run H1 — sandbox spike (host repo, worktree `.worktree/plg-spike`)

Deliverable: `docs/spikes/2026-10-04-plugin-sandbox/` with `spike.ts`, `fixture-plugin.ts`, `README.md` (findings), and `@anthropic-ai/sandbox-runtime` + `vscode-jsonrpc` + `comlink` added to `package.json` dependencies (latest versions, `bun add`).

Steps:
1. `bun add @anthropic-ai/sandbox-runtime vscode-jsonrpc comlink`.
2. `docs/spikes/2026-10-04-plugin-sandbox/fixture-plugin.ts`: a Bun script that speaks the isolated server protocol above with `vscode-jsonrpc` and implements `plugin.call` methods `readFile({path})` (returns file text or `"DENIED: <error message>"`), `fetchUrl({url})` (returns HTTP status or `"DENIED: <error message>"`), `writeData({name})` (writes `$MC_PLUGIN_DATA/<name>`, returns `"ok"` or `"DENIED: …"`), `askSetting({key})` (calls host `settings.get`, returns the value).
3. `docs/spikes/2026-10-04-plugin-sandbox/spike.ts`: uses the sandbox-runtime library API (`SandboxManager.initialize(config)` then `SandboxManager.wrapWithSandbox(command)`; read the package's README/types in node_modules to get exact names) to spawn `bun fixture-plugin.ts` with config: network allowedDomains `['example.com']`; filesystem denyRead `[os.homedir()]` then allow reading the spike folder, the repo `node_modules`, and Bun's install dir (`process.execPath`'s parent and `~/.bun`); allowWrite only a temp data dir. Then runs these probes over JSON-RPC and prints one line each `PASS|FAIL <name> <detail>`:
   - `startup`: process answers a `plugin.call` within 10 s.
   - `read-own`: `readFile` of `fixture-plugin.ts` succeeds.
   - `read-secret`: `readFile` of `~/.config/mission-control/secrets.json` returns `DENIED` (do NOT print its content in any case; if it is readable print only `FAIL read-secret readable` ).
   - `read-ssh`: `readFile` of `~/.ssh/config` returns `DENIED` (same no-print rule).
   - `net-allowed`: `fetchUrl('https://example.com')` → 200.
   - `net-denied`: `fetchUrl('https://api.github.com')` → `DENIED` or a non-2xx proxy rejection.
   - `write-data`: `writeData` works; writing to `os.homedir()/mc-spike-should-not-exist` is denied (method `writeAbs({path})`, add it to the fixture).
   - `settings-roundtrip`: host answers `settings.get` with `"spike-value"` and the plugin returns it.
4. Run it: `bun docs/spikes/2026-10-04-plugin-sandbox/spike.ts`. Iterate the sandbox config until every probe passes or a probe is proven impossible; never weaken a denial probe to make it pass.
5. `README.md`: the final config object, the probe output verbatim, and a verdict line `VERDICT: GO` (all pass) or `VERDICT: NO-GO <which probe and why>`. Include anything the isolated runtime (Run H6) must copy (exact allow paths, env vars like HTTP_PROXY that sandbox-runtime sets, whether Bun `fetch` honours them).

Tests: none beyond the spike output (it is a throwaway probe). Do not add the spike to `bun test`.

### H1 revisions after plan review
- Denial classification: `readFile`/`writeAbs`/`writeData` return `DENIED <code>` ONLY when the error code is `EPERM` or `EACCES`; any other error returns `ERROR <code> <message>` and the probe is FAIL. `read-secret`, `read-ssh` pass only on `DENIED EPERM|EACCES`.
- Network classification: `fetchUrl` returns `STATUS <n>` or `ERROR <message>`. `net-denied` passes only when `net-allowed` passed in the same run AND the denied fetch either throws an error whose message mentions the proxy/connection being refused, or returns status 403/407 from the sandbox proxy; print the exact error/status.
- Forbidden write probe: `writeAbs({ path })` uses `fs.openSync(path, 'wx')` (exclusive create, never overwrites) on `~/mc-spike-<16 random hex>`; pass only on `DENIED EPERM|EACCES`. If the create succeeds, unlink it immediately and report FAIL.

## Run H2 — sessions: terminal first message + task-context files (worktree `.worktree/plg-sessions`)

Decisions:
- `initialPrompt` is an optional string, max 8000 chars, trimmed; empty after trim = absent.
- claude / glm / codex: `terminalArgs` appends `initialPrompt` as the LAST positional argument (after all flags, after `--append-system-prompt`/`-c` values).
- Connections: `{{prompt}}` placeholder replaced by the prompt (or by empty string when absent, then empty args are dropped). A connection whose `terminalArgs` has no `{{prompt}}` ignores `initialPrompt` and the create result includes `firstMessageDropped: true`.
- Context files: `context/<pluginId>/<yyyymmdd-hhmmss>-<safe>.md`, `<safe>` = name lowercased, non `[a-z0-9.-]` → `-`, collapsed, trimmed to 60 chars, `.md` appended if missing. Mode 0600, folders 0700. Sweep: on every write, delete files in `context/*/` whose mtime is older than 30 days.

Preserve:
- `POST /api/terminals` existing fields and validation (`server/routes/terminals.ts:57-96`); resume (`resumeSessionId`) still never takes `initialPrompt` — if both given → 400 `"initialPrompt cannot be used when resuming"`.
- `terminalArgs` output for calls without `initialPrompt` is byte-identical to today (existing tests in `test/terminals*.test.ts` must stay green unchanged).

Steps:
1. `server/terminals.ts`: add `initialPrompt?: string` to `CreateTerminalParams`; `terminalArgs(engine, model, resumeSessionId, sessionId, instructions, initialPrompt?)` appends it last; connection branch (~line 240) replaces `{{prompt}}`; return `firstMessageDropped` on the created terminal record only when dropped.
2. `server/routes/terminals.ts`: accept and validate `initialPrompt` (string, ≤8000 after trim) and pass it through; the resume conflict rule above.
3. `server/plugins/context-files.ts`: `export async function writeContextFile(pluginId: string, context: { name: string; markdown: string }, now = new Date()): Promise<string>` (returns absolute path; throws `ContextTooLarge` when `Buffer.byteLength(markdown) > 524288`) and `export async function sweepContextFiles(now = new Date()): Promise<number>` (called inside `writeContextFile`).
4. `server/secrets.ts`: export `readJsonFile`, `writeJsonFile`, `configDir`, `ensureConfigDir` (no behaviour change).

Tests (`test/terminal-first-message.test.ts`, `test/plugin-context-files.test.ts`):
- `terminalArgs('claude', null, undefined, 'S', undefined, 'hello')` ends with `'hello'`; same for `'codex'` and `'glm'`.
- without `initialPrompt` the arrays equal today's (assert against the literal arrays the existing tests use).
- route: `initialPrompt` of 8001 chars → 400; `initialPrompt` + `resumeSessionId` → 400 with the message above.
- `writeContextFile('clickup-board', { name: 'HerMEZ kood queue', markdown: '# x' }, new Date('2026-10-04T10:11:12Z'))` → path ends with `context/clickup-board/20261004-101112-hermez-kood-queue.md`, file mode `0o600`.
- 600 KB markdown → throws `ContextTooLarge`.
- a file with mtime 31 days ago is removed by the next write; one 29 days old stays.

### H2 revisions after plan review
- Put new tests only in the new files named above. Do NOT edit `test/terminals-routes.test.ts` (its existing 50 ms waits are legacy and out of scope); the new tests contain no sleeps or fixed waits — await the returned promises.
- `terminalArgs` model argument in the tests is `undefined` (signature takes `string | undefined`), e.g. `terminalArgs('claude', undefined, undefined, 'S', undefined, 'hello')`.
- Extract the connection branch into `export function connectionTerminalArgs(template: string[], vars: { model?: string; instructions?: string; prompt?: string }): { args: string[]; promptUsed: boolean }` in `server/terminals.ts` (replace `{{model}}`, `{{instructions}}`, `{{prompt}}`; drop args that become empty; `promptUsed` = a `{{prompt}}` placeholder existed and a prompt was given) and use it at the existing call site. Tests: `connectionTerminalArgs(['--x','{{prompt}}'], { prompt: 'hi' })` → `{ args: ['--x','hi'], promptUsed: true }`; `connectionTerminalArgs(['--x','{{prompt}}'], {})` → `{ args: ['--x'], promptUsed: false }`; `connectionTerminalArgs(['--m','{{model}}'], { model: 'k', prompt: 'hi' })` → `{ args: ['--m','k'], promptUsed: false }` and the created terminal then carries `firstMessageDropped: true` (route test with a stubbed registry/connection, no real PTY).

## Run H3 — plugin store, manifests, marketplaces, install lifecycle, settings (worktree `.worktree/plg-store`)

Decisions:
- Files (spec §6.2): `plugins.json` = `{ "plugins": InstalledPlugin[] }` where `InstalledPlugin = { id, name, version, description, runtime, source: { repo: string; ref: string; marketplace?: string }, commit: string, permissions: PluginManifest['permissions'], settingsFields: SettingField[], icon?: string, server?: string, screen?: string, enabled: boolean, installedAt: string, updatedAt: string }`.
- `config.json` gains `marketplaces: { url: string }[]` (default `[]`; `readConfig` returns `[]` when absent).
- Git: shell out with `git` via the existing `git`/`gitTimed` helpers in `server/job-worktrees.ts`; clone = `git clone --depth 1 --branch <ref> <repo> <tmp>`; when `--branch` fails for a SHA ref, fall back to full clone + `git checkout <ref>`. Commit recorded = `git rev-parse HEAD`. Timeouts 120 s.
- Allowed repo URLs: `https://`, `git@host:path`, and `file://` (tests use `file://` fixture repos). Anything else → 400.
- Marketplace slug: url → lowercase, non-alnum → `-`, trimmed, max 60.
- Install = preview checks + `bun install --production --ignore-scripts` in the checkout (skip when no `package.json`) + build screen (when `screen` set): `Bun.build({ entrypoints:[screen], target:'browser', format: runtime==='isolated' ? 'iife' : 'esm', outdir: '.mc-build', naming: 'screen.js', minify: true })` + atomic move from tmp into `plugins/<id>/`. Any failure → remove tmp, nothing written to `plugins.json`, response `{ error, step }` with `step` ∈ `clone|manifest|dependencies|build|move`.
- Trusted installs require body `trust: true`, else 400 `"Trusted plugins need trust: true"`.
- Update: re-clone at the new ref (marketplace listing ref, or body `ref` for link installs); compute `added = permissionsAdded(old, new)` (new network hosts, new session kinds, settings false→true). If `added` is non-empty and body `accept !== true` → 409 `{ needsConsent: true, added }`. Data folder untouched.
- Uninstall body `{ keepData: boolean }` default true. Disable/enable via PATCH `{ enabled }`. Disabled plugin: call route 409 `"This plugin is turned off"`.
- Settings: `plugin-data/<id>/settings.json` = `Record<string,string>`. GET returns `{ fields, values (non-secret only), configured: Record<key, boolean> }`. PUT `{ key, value: string|null }` only for declared keys (else 400); null deletes.
- Routes exactly as spec §6.6 table except `/call`, `/plugin-frame`, `/plugin-module`, `/context` (those are H5/H6/H4b). Router: `server/routes/plugins.ts` exporting `pluginsRoutes(deps)` with `.onBeforeHandle(requireLocal)`; mount in `server/index.ts` right after `.use(providersRoutes)`. Do not change `allowToken`.

Preserve: `readConfig`/`writeConfig` existing keys and defaults (`server/secrets.ts`); `server/index.ts` mount order of existing routes; static plugin stays last.

Steps:
1. `server/plugins/manifest.ts`: `PluginManifest`, `SettingField` types, `SUPPORTED_PLUGIN_APIS`, `export function parseManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] }` (zod 4; every rule from spec §4.1 + Global decisions; `server`/`screen`/`icon` must be relative, no `..`, no leading `/`); `export function permissionsAdded(old, next): string[]` (human lines like `Reach api.example.com`, `Start terminals`, `Keep its own settings`).
2. `server/plugins/store.ts`: read/write `plugins.json`; `listInstalled()`, `getInstalled(id)`, `saveInstalled(p)`, `removeInstalled(id)`.
3. `server/plugins/marketplaces.ts`: add/remove/list marketplaces in config, `syncMarketplace(url)` (clone or `git -C fetch --depth 1 && reset --hard origin/HEAD` under `marketplaces/<slug>/`), `catalog()` merges every `marketplace.json` (`{ name, plugins: [{ id, repo, ref, name, description, runtime }] }`, invalid entries skipped with a reason list).
4. `server/plugins/installer.ts`: `preview({ repo, ref })`, `install({ repo, ref, trust, marketplace? })`, `update(id, { ref?, accept? })`, `uninstall(id, { keepData })`, `setEnabled(id, enabled)`.
5. `server/plugins/settings.ts`: `settingsView(id)`, `setSetting(id, key, value)`, `getSetting(id, key)`.
6. `server/routes/plugins.ts` + mount in `server/index.ts`.

Tests (`test/plugin-manifest.test.ts`, `test/plugin-installer.test.ts`, `test/plugins-routes.test.ts`) using fixture git repos created in a temp dir with `git init` + commit + `git tag v1.0.0`:
- valid ClickUp manifest from spec §4.1 parses ok.
- `pluginApi: 2` → errors contains `"This plugin needs a newer Mission Control"`.
- `id: "Bad_ID"` → error; `server: "../x.ts"` → error; `network: ["*.clickup.com"]` → error.
- `permissionsAdded({network:['a.com']},{network:['a.com','b.com'],sessions:['chat']})` equals `['Reach b.com','Start chats']`.
- install isolated fixture (no package.json, screen `src/screen.ts` exporting a trivial default) → `plugins.json` has it with `enabled: true`, `plugins/<id>/.mc-build/screen.js` exists.
- install trusted fixture without `trust` → 400; with `trust: true` → 200.
- fixture whose screen has a syntax error → `{ step: 'build' }`, no `plugins/<id>` folder, `plugins.json` unchanged.
- update adding a network host without `accept` → 409 `needsConsent` with `added: ['Reach b.example.com']`; with `accept: true` → 200.
- uninstall `keepData: false` removes `plugin-data/<id>`; default keeps it.
- settings GET never contains a secret value; PUT unknown key → 400.

### H3 revisions after plan review
- Reviewed-commit binding: `POST /api/plugins/preview` returns `{ manifest, commit, permissions, runtime }`. `install` and `update` require body `commit` (the SHA from preview); after cloning, if `git rev-parse HEAD` ≠ `commit` → 409 `"The plugin changed since you reviewed it; preview again"`, tmp removed.
- Update identity rules: the new manifest `id` must equal the installed id (else 409 `"The update changed the plugin id"`); the source repo URL must equal the installed `source.repo` (else 409 `"The update comes from a different repo"`); runtime isolated→trusted requires body `trust: true` (else 409 `{ needsTrust: true }`); permission growth needs `accept: true` (409 `{ needsConsent: true, added }`).
- Update replacement with rollback: build the new version fully in tmp; rename `plugins/<id>` → `plugins/<id>.old-<epoch ms>`; rename tmp → `plugins/<id>`; save `plugins.json`; delete the `.old-*` folder. If any step after the first rename fails, rename the old folder back, leave `plugins.json` unchanged, return `{ error, step: 'move' }`.
- Installer deps are injectable for tests: `createInstaller({ git, runBunInstall, build, rename })` with real defaults.
- Failure coverage tests (each asserts no `plugins/<id>` folder, no tmp leftovers under the config dir, `plugins.json` unchanged, and the exact `step`): clone (`file://` path that does not exist → `clone`; existing repo with ref `v9.9.9` → `clone`), manifest (missing `mc-plugin.json` → `manifest`; invalid manifest → `manifest` with its errors), dependencies (package.json depending on `"definitely-not-a-real-pkg-mc": "1.0.0"` → `dependencies`; to keep the test offline, inject `runBunInstall` that rejects), build (syntax error → `build`), move (inject `rename` that rejects → `move`), commit mismatch (409 as above). Update rollback test: inject `rename` that rejects on the second call → old version still installed and loadable, `plugins.json` unchanged.
- Marketplace parsing tests: a `marketplace.json` with one valid entry and one entry missing `repo` → catalog has 1 plugin and `skipped: [{ id, reason: 'missing repo' }]`; malformed JSON → catalog entry `{ marketplace, error: 'marketplace.json is not valid JSON' }`.
- `test/secrets.test.ts`: update the config-defaults assertion (~line 45) to include `marketplaces: []`; no other change to that file.

## Run H4 — context route + trusted runtime + call route (worktree `.worktree/plg-store`, after H3 lands)

Decisions:
- `POST /api/plugins/:id/context` `{ name, markdown }` → `{ path }` (uses H2 `writeContextFile`); requires plugin permission `sessions` non-empty, else 403.
- `POST /api/plugins/:id/call` `{ method, params }` → `{ result }` or `{ error }` 4xx/5xx; unknown method → 404 `"No method <m>"`; timeout 30 s → 504 `"The plugin did not answer"`.
- Trusted server runtime: `server/plugins/runtime-trusted.ts` `createTrustedRuntime(installed, ctxFactory)` loads `await import(<plugins/<id>/<server>>)` once, uses `mod.default.methods`. Errors thrown by a method → 500 `{ error: message }`.
- `ctx.settings` reads/writes via H3 settings module; `ctx.data` = `plugin-data/<id>/files` (mkdir 0700); `ctx.log` → `console.log('[plugin <id>]', message)`.
- `GET /plugin-module/:id/screen.js` serves `plugins/<id>/.mc-build/screen.js` with `content-type: text/javascript` only for enabled trusted plugins (404 otherwise).
- `server/plugins/runtimes.ts`: `getRuntime(id)` picks trusted (H4) or isolated (H6, stub that returns 501 `"Isolated runtime not available yet"` until H6).

Steps: 1 `server/plugins/runtime-trusted.ts`; 2 `server/plugins/runtimes.ts`; 3 routes `/context`, `/call`, `/plugin-module` added to `server/routes/plugins.ts`.

Tests (`test/plugin-runtime-trusted.test.ts`): fixture trusted plugin with method `echo` returning params and `secret` returning `ctx.settings.get('token')` → `/call` echo returns params; `secret` returns the stored value; unknown method 404; a method that never resolves → 504 after the timeout (inject a 50 ms timeout through deps for the test); disabled plugin → 409; `/context` writes file and returns path; plugin without sessions permission → 403.

## Run H5 — isolated runtime (worktree `.worktree/plg-spike`, after H1 GO and H4 land)

Decisions: copy the sandbox config, allow paths and env handling from `docs/spikes/2026-10-04-plugin-sandbox/README.md` exactly. `server/plugins/runtime-isolated.ts` `createIsolatedRuntime(installed, deps)`:
- spawn lazily on first call: `bun <plugins/<id>/<server>>` wrapped by sandbox-runtime with network allowedDomains = `permissions.network ?? []`, reads denied for home except the plugin folder, its `node_modules`, `plugin-data/<id>/files`, Bun install paths; writes only `plugin-data/<id>/files`; env `MC_PLUGIN_RUNTIME=isolated`, `MC_PLUGIN_ID`, `MC_PLUGIN_DATA`.
- JSON-RPC via `vscode-jsonrpc/node` `createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin))`; handle `settings.get/set` (only when `permissions.settings`), `log`.
- idle stop 600000 ms reset on every call (`plugin.shutdown` notification, then kill after 2 s).
- crash: reject in-flight calls with `"The plugin stopped: <last 5 stderr lines>"`; 3 crashes in 300000 ms → state `stopped`, calls 409 `"Stopped after repeated crashes"` until `PATCH enabled` toggles it.
- `GET /plugin-frame/:id/` HTML (exact): `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/plugin-frame/<id>/ui.css"></head><body><div id="root"></div><script>window.__MC_PLUGIN__={id:"<id>",runtime:"isolated"}</script><script src="/plugin-frame/<id>/screen.js"></script></body></html>` with header `content-security-policy: default-src 'none'; script-src <origin> 'unsafe-inline'; style-src <origin> 'unsafe-inline'; img-src <origin> data:; connect-src 'none'; frame-ancestors <origin>` where `<origin>` = `http://` + request Host header. (`'self'` does not match inside an opaque-origin sandboxed frame.)
- `/plugin-frame/:id/screen.js` serves the iife bundle; `/plugin-frame/:id/ui.css` serves `public/plugin-ui.css` (created in H6b).

Tests (`test/plugin-runtime-isolated.test.ts`, macOS only — skip with a clear `test.skipIf(process.platform !== 'darwin')`): fixture isolated plugin (copy of the spike fixture using the SDK-less raw protocol) → call works; reading `secrets.json` of the temp config dir → `DENIED`; fetch non-allowed host → `DENIED`; crash method (`process.exit(1)`) → call rejects with "The plugin stopped"; 3 crashes → 409; idle stop with injected 100 ms idle → process exits; frame HTML has the CSP header with the request origin.

## Run H6 — UI (worktree `.worktree/plg-store`, after H3–H5 land)

Split as MC_SHAPE paths: (a) sidebar + Marketplace screen, (b) plugin screen host + launch dialog + plugin-ui.css.

Decisions:
- Sidebar (variant B): in `client/sidebar.ts` `paint`, before the day groups, render `<p class="sb-day">Plugins</p>` + one `sb-item > a.sb-row` per enabled plugin that has a screen (icon = `<img src="/api/plugins/<id>/icon">` 16 px, or `#auto-icon` when no icon; title = plugin name); clicking dispatches `quiet:show-plugin` with the id. Rail: same items as `sb-mini` buttons at the top of `#sidebar-mini`. Footer: Marketplace button `<button type="button" id="open-marketplace" class="sb-link">` with a store icon symbol `#store-icon` added to the shell sprite (copy path data from `visualizer/marketplace/build.py` `mk-store`), placed first in `.sb-foot`; rail gets the same as `sb-icon` above history. Installed list loads from `GET /api/plugins` once at boot and again on `quiet:plugins-changed` (no polling).
- `GET /api/plugins/:id/icon` serves the manifest icon (svg/png only) — add to `server/routes/plugins.ts`.
- Screens: `client/shell.ts` `screens` gains `'plugin'` and `'marketplace'`; both set `.canvas` `data-screen="studio"` styling so the composer hides (same as studio). `server/views/shell.ts` adds `<section id="plugin" class="studio" hidden>` and `<section id="marketplace" class="studio" hidden>` after `#studio`.
- Marketplace screen (`client/plugins/marketplace.ts`): exact layout/classes from `visualizer/marketplace/market.html` (connection-list + connection-settings), states: browse, isolated install dialog, trusted install dialog (Install disabled until switch on), installed detail (settings fields from manifest, Enabled switch, Check for update, Uninstall with keep-data choice, Open). "Add a marketplace" = inline url input + Add. "Install from a link" = inline repo + ref inputs under the list. Every action shows feedback: busy text on the button, `quiet:toast` on success, inline error text with the `step` on failure.
- Plugin screen host (`client/plugins/plugin-screen.ts`): heading = plugin name; body = trusted: `import('/plugin-module/<id>/screen.js')` then `mod.default.mount(root, mc)`; isolated: `<iframe sandbox="allow-scripts" src="/plugin-frame/<id>/" style="width:100%;height:calc(100vh - 140px);border:0">` + Comlink expose with the source-checked endpoint (Shared contract). `mc` implementation in `client/plugins/host-api.ts` enforces manifest permissions before each call (rejects with `"This plugin did not ask to start terminals"` etc.).
- Launch dialog (`client/plugins/launch-dialog.ts`, markup in `server/views/shell.ts` as `<dialog id="plugin-launch" class="access-dialog flat">`): fields exactly as `board.html?s=launch` — task-context note (name + size KB), AI select (providers list like terminals), Model, Working directory (prefilled from request, datalist of recent folders), First message (optional). On Start: `POST /api/plugins/:id/context` → path; prompt = `Read the task context in <path> before anything else.` + (`\n\n` + first message when given). Chat → dispatch `quiet:start-chat` `{ engine, model, cwd, prompt }`; Terminal → dispatch `quiet:open-terminal` `{ launch: { engine, model, cwd, title, initialPrompt: prompt } }`.
- `client/chat.ts`: add listener `quiet:start-chat` that runs the same body as `startChat` (lines ~1000–1020) but with the given engine/model/cwd/prompt (extract shared `createChat({ engine, model, cwd, prompt, images })`, keep `startChat` behaviour identical), then shows the conversation screen.
- `client/terminals.ts`: `quiet:open-terminal` detail gains `launch`; handler calls new `launchTerminal(launch)` mirroring `createTerminal` (lines 444–465) with `initialPrompt` and `title`.
- `public/plugin-ui.css`: the token block of `public/quiet.css` `:root` (light + dark) plus `.pill`, `.connection-*`, field styles, and `visualizer/marketplace/mk.css` board/card/empty/dialog classes — so isolated screens match.
- Dark theme: frame gets theme via `mc.theme()`/`onTheme`; `plugin-ui.css` honours `[data-theme="dark"]` on the frame's `<html>`; SDK sets it.

Tests: `test/plugins-ui.test.ts` with the existing DOM test setup used by `test/attention*.test.ts` (happy-dom/linkedom — copy whatever those files use): sidebar renders a Plugins group for an enabled plugin with screen and none for disabled; Marketplace footer button exists in both open sidebar and rail; host-api rejects `startTerminal` for a plugin with `sessions: ['chat']`; launch dialog builds prompt `Read the task context in /x/y.md before anything else.\n\nPlan it` for first message `Plan it`; `createChat` called by `quiet:start-chat` posts `/api/jobs` with `purpose: 'chat'` and the given cwd.
Verification (orchestrator): render in a real browser at the end (Run E).

## Run S1 — SDK (repo `mc-plugin-sdk`)

Package `@mission-control/plugin-sdk`, version `0.1.0`, `"type": "module"`, TypeScript source shipped (no build step), exports map: `"."` → `src/index.ts` (types), `"./server"` → `src/server.ts`, `"./screen"` → `src/screen.ts`, `"./manifest"` → `src/manifest.ts`, `"./ui.css"` → `ui.css`. Dependencies: `vscode-jsonrpc`, `comlink`, `zod` (4). Files:
1. `src/types.ts`: the Shared contract types + `ScreenApi` (`mc`) + `ServerContext` + `MethodHandler<P,R> = (params: P, ctx: ServerContext) => Promise<R> | R`.
2. `src/manifest.ts`: `manifestSchema` (zod) + `parseManifest` with the same rules as host H3 step 1, and `schema/mc-plugin.schema.json` (JSON Schema draft 2020-12 of the same rules) for editors.
3. `src/server.ts`: `definePlugin({ methods })` returns the definition; when `process.env.MC_PLUGIN_RUNTIME === 'isolated'` it also calls `serveStdio(def)` which implements the isolated server protocol (vscode-jsonrpc) and builds `ctx` from host requests.
4. `src/screen.ts`: `defineScreen(mount)` returns `{ mount }`; isolated self-mount via Comlink as in Shared contract; sets `document.documentElement.dataset.theme` from `mc.theme()` and `onTheme`.
5. `ui.css`: copy of host `public/plugin-ui.css` content rules (tokens + components); identical file.
6. `README.md`: author guide — manifest reference, the two runtimes and the trust trade, `mc` and `ctx` API tables, a 20-line example, how to list a plugin in a marketplace, local testing (`Install from a link` with `file://`).
7. Tests `test/manifest.test.ts` (same cases as host H3 manifest tests), `test/server.test.ts` (spawn `bun test/fixtures/echo-plugin.ts` with `MC_PLUGIN_RUNTIME=isolated`, call `plugin.call echo` over vscode-jsonrpc, assert result; assert `ctx.settings.get` round-trips through a host handler).
8. `LICENSE` MIT (holder "LynchzDEV"), `.gitignore` (`node_modules`).

## Run T1 — Hello board template (repo `mc-plugin-template`, after S1 pushed)

Trusted plugin, id `hello-board`, permissions `{ sessions: ['chat'], settings: true }`, settings `[{ key: 'greeting', label: 'Greeting', type: 'text' }]`. Server method `hello.cards()` returns 3 static cards `[{ id:'1', title:'Read the plugin guide' }, { id:'2', title:'Change this board' }, { id:'3', title:'Ship your own plugin' }]` and the greeting setting. Screen renders the greeting + cards using `ui.css` classes (`mk-card`), each card has "Start chat" calling `mc.sessions.startChat({ title, cwd: (await mc.folders.recent())[0] ?? '~', context: { name: 'hello-<id>', markdown: '# ' + title } })`. `package.json` depends on `"@mission-control/plugin-sdk": "github:LynchzDEV/mc-plugin-sdk#v0.1.0"`. README: "copy this repo to start a plugin", step list. Test: `test/server.test.ts` calls `hello.cards` through `definePlugin` directly with a fake ctx.

## Run C1 — ClickUp plugin server part (repo `mc-plugin-clickup`, after S1 pushed)

Manifest exactly spec §4.1 (`id: clickup-board`, isolated). Server methods (spec §9.2, §9.3):
- `src/clickup-api.ts`: `createClickUp(token, fetchImpl = fetch)` with a queue of max 4 in flight; 429 → wait `Retry-After` seconds (default 60) then retry once; 401 → throws `TokenRejected`; network failure → throws `Unreachable`. Base `https://api.clickup.com/api/v2`, header `Authorization: <token>`.
- `src/links.ts`: `parseClickUpLink(url)` → `{ kind:'list', listId } | { kind:'view', viewId } | null` for `https://app.clickup.com/<team>/v/li/<listId>`, `/v/b/<viewId>`, `/v/l/<viewId>` (also with trailing path/query).
- `src/board.ts`: `loadBoard(api, board)` → `{ columns: [{ status, color, tasks: Card[] }], partialFilters: boolean }`; columns ordered by `GET /list/{id}` `statuses[].orderindex`; view source uses `GET /view/{viewId}/task?page=N` until `last_page`; on 401/403/404 from the view endpoint falls back to list tasks and sets `partialFilters: true`; list source `GET /list/{id}/task?page=N&subtasks=false` until a page has < 100 tasks. `Card = { id, name, url, status, tags: string[], assignees: { initials, color }[], subtaskCount, commentCount? }`.
- `src/dossier.ts`: `buildDossier(api, taskId, { maxDepth: 3, maxTasks: 60 })` → markdown (sections in spec §9.3 order); visited set; subtasks re-fetched by id with `include_subtasks=true`; comments + `GET /comment/{id}/reply`; dependencies + `linked_tasks` + task URLs found in description/comments (`/t/<id>` pattern) one hop; custom fields with non-empty values; attachments as `- [title](url)`; footer `Gathered at <ISO time> from ClickUp`; cap note `Stopped after 60 tasks` when hit.
- `src/tree.ts`: lazy `tree.children({ kind:'root'|'team'|'space'|'folder', id? })`.
- `src/server.ts`: `definePlugin({ methods: { 'token.check', 'tree.children', 'link.resolve', 'boards.list', 'boards.save', 'boards.remove', 'board.load', 'task.dossier' } })`; token from `ctx.settings.get('token')` (missing → error `"Connect ClickUp first"`); boards stored as JSON string in setting `boards` (not a declared field; host H3 PUT allows undeclared keys only from the server part via ctx — host `ctx.settings.set` is unrestricted, the screen `mc.settings.set` is restricted to declared keys).
Tests with a fake fetch: each link shape; view fallback sets `partialFilters`; status order; pagination stops correctly; dossier: subtask re-fetch happens (fake returns embedded subtasks without description, asserting the re-fetched description appears), visited set (cycle A↔B fetched once each), 60-task cap note, reply threads included, attachments rendered as links; 429 waits then retries once (inject a fake sleep); 401 → `TokenRejected`.

## Run C2 — ClickUp plugin screen (repo `mc-plugin-clickup`, after C1)

`src/screen.ts` with `defineScreen`; states exactly as `visualizer/marketplace/board.html` (Board, Start chat via `mc.sessions.startChat`/`startTerminal` with `cwd = board.folder` and `context = { name: 'task-<id>', markdown: await mc.call('task.dossier', { taskId }) }`, No token, No boards, Add a board Browse/Paste link). Card shows "Gathering task…" while the dossier loads. Refresh button + "Updated N min ago" text computed on render (no timer). Partial-filters note when `partialFilters`. Errors per spec §10 rendered inline with Retry. Keyboard: card actions visible on `:focus-within`. Tests: pure render helpers in `src/view.ts` (`renderColumns(board)`, `renderEmpty(kind)`) tested as string/DOM output with literal expected text ("Connect ClickUp", "Pick your first board", "This board shows the whole list; ClickUp didn't let us apply the view's filters.").

## Run E — orchestrator end-to-end (main session, not a cockpit job)

Push SDK (tag v0.1.0), template, clickup (tag v1.0.0), marketplace (`marketplace.json` listing clickup-board v1.0.0 and hello-board v0.1.0 from `https://github.com/LynchzDEV/...`). In mission-control: full `bun test` once, typecheck, start a throwaway server on a free port with a temp `MISSION_CONTROL_CONFIG_DIR`, add the marketplace, install Hello (trusted) and ClickUp (isolated) through the UI, open both screens, start a Hello chat and confirm the first message carries the context path, confirm ClickUp shows "Connect ClickUp". Restore the `~/.claude/skills/mc-dispatch` link after. Push mission-control main.

---

## Acceptance baseline (verbatim, every run)

Done means all of these hold, verified by you before you report:
1. Every spec for a file you touched, plus every spec that references a class or module you changed, passes locally. Run those specs while iterating and once more at the end. Do NOT run the full suite or bin/ci: the orchestrator runs it once at landing.
2. Those runs have no hard or forced waits (no sleep, no fixed wait_for/timeout padding) and are clean: zero warnings, zero error logs, zero deprecation output. No model spec that proves ActiveRecord plumbing (associations, column defaults, attribute round-trips, enum listings, allow_nil): a model example exists only for a rule the model itself enforces, and plumbing examples in files you touch are deleted. If a model you touch holds business logic, do not spec it there: flag it in your report as "why is this business logic in the model layer?" and name the service / query / PORO it should move to. A spec that sometimes passes and sometimes fails is a FAILING spec: never re-run until green or call it "just flaky" — find the cause (shared state, ordering, timing, a wrong column type) and fix it; evidence is the same specs green on repeated runs. Brakeman cannot be ignored: `config/brakeman.ignore` stays empty, every warning is fixed in code, and `brakeman --no-pager` reports 0 warnings with nothing ignored.
3. Nothing on the remote is lost and the code stays compatible: fetch and rebase onto the latest remote tip before you finish, never force-push or drop commits, and keep existing callers, data and already-applied migrations working.
4. The engine HAS TO spin up on its own: `spec/dummy` boots and its specs run with no host, no sibling engine and no host table; you added no dependency that is not necessary, and any that is enters through a settings adapter, never a direct constant.
5. Migrations track schema changes and nothing else: create every new migration with `bin/rails g migration` so it carries a real wall-clock timestamp, never rename or re-timestamp one that is committed or already applied anywhere, and never add, update or delete data inside one — a data move is its own rake task with a spec.
6. No needless recurring jobs: add no cron, scheduled, recurring or polling job (sidekiq-cron, whenever, solid_queue recurring, setInterval poll) that fires on a short fixed interval such as every 1 or 5 minutes to check whether something changed. Trigger the work from the event that causes it (enqueue at the moment of change, a callback, a webhook). A new recurring job is allowed only when no event exists to hang it on, and then at the longest interval the business tolerates.
Report the exact spec command you ran and its summary line as evidence for 1 and 2, every model spec you added or changed with the model rule each example covers (plus any business-logic-in-model flag) for 2, the dummy boot command for 4, and the generator command plus resulting filename for any migration you added for 5, and every recurring or scheduled job you added (or "none") with its interval and why no event trigger fits for 6.

(Rails-specific items 2-brakeman, 4, 5 do not apply to this Bun/TypeScript work: report "n/a — not a Rails repo" for them. The worker does NOT commit, push, fetch or rebase; the orchestrator does that at landing, so item 3 is satisfied by not touching git history.)
