# Connected AIs find their own models

Goal: every connected AI (Studio → Manage AIs) shows its real model list without anyone typing it, and the list stays current. Built-ins (claude, glm, codex) already discover theirs in `server/models.ts`; this covers user connections.

## Facts (verified 2026-10-04)

- A connection's models today are only `connection.models`, typed in the "Available model IDs · one per line" box (`client/studio-settings.tsx:135`). The saved Grok connection has `"models": []`, so Grok shows no models anywhere.
- ACP agents report models when a session opens. `grok agent stdio` → `session/new` returns BOTH:
  - `configOptions`: standard ACP; a `type: "select"` option with `category: "model"` (or `id: "model"`); its `options` is `SessionConfigSelectOption[]` (`{ value, name }`) or `SessionConfigSelectGroup[]` (`{ group, name, options: SessionConfigSelectOption[] }`) — `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:2611-2740`.
  - `models`: older form, `{ currentModelId, availableModels: [{ modelId, name }] }`.
  - Grok's list: grok-4.7 (current), grok-4.7-build-fast, grok-4.6, grok-4.5. Its `agentCapabilities.sessionCapabilities` includes `close`.
- The `opencode` adapter also speaks ACP (`opencode acp`). With a custom `baseUrl`, OpenCode needs the model ids written into `OPENCODE_CONFIG_CONTENT` (`server/agent-connections.ts:56-63`), so those must be known before launch; an OpenAI-compatible endpoint lists them at `GET {baseUrl}/models` → `{ data: [{ id }] }`.
- The `cli` adapter has no protocol to ask. It stays manual.
- The bridge already handles `probe: true` right after initialize/authenticate (`server/agent-bridge.ts:138`) and already picks a model via `configOptions` or `session/set_model` (`:155-160`).
- `modelsCache` (`server/routes/models.ts:7`) is a lazy TTL cache refreshed on read. Standing rule for this repo: no high-frequency scheduled jobs. Discovery must be lazy too: no timers, no intervals.
- `connections/*.json` is listed with a filename regex in `createConnectionStore().list()`; do not put other files in that folder.

## Design

### Storage
Discovered lists live apart from the user's own list, so a refresh never overwrites what the user typed:
`<configDir>/connection-models/<id>.json` = `{ models: string[], current: string | null, checkedAt: number, error: string | null }`.
Effective list = discovered models first, then manual `connection.models` not already in it (dedupe, order kept).

### New module `server/model-discovery.ts`
- `modelsFromSession(response: unknown): { models: string[]; current: string | null }` (pure). Model option from `configOptions` (category `model` or id `model`, type `select`): flatten groups, ids = `value`, current = `currentValue`. If there is none, fall back to `models.availableModels[].modelId` / `models.currentModelId`. Dedupe. Nothing found → `{ models: [], current: null }`.
- `endpointModels(baseUrl, apiKey | undefined, fetchImpl)`: `GET` baseUrl without trailing slash + `/models`, `Authorization: Bearer` only when there's a key, 10 s timeout. Returns `data[].id` strings. Throws `Error` with the HTTP status or the network reason (never the key).
- `spawnBridge(input, timeoutMs)`: the spawn/collect/parse logic now inline in the probe route (`server/routes/studio.ts:74-87`), moved here and reused by both probe and discovery.
- `mergeModels(discovered, manual)`.
- `createModelDiscovery({ base = configDir(), fetchImpl = fetch, now = Date.now, bridge = spawnBridge })` with:
  - `read(id)` → state or `null`.
  - `refresh(connection)`: one run at a time per id (a second caller gets the same promise). `cli` → returns null and writes nothing. `opencode` with `baseUrl` → `endpointModels` (key from `process.env[apiKeyEnv]`). Otherwise → bridge with `discoverModels: true`, 45 s timeout. Success writes `{models, current, checkedAt: now(), error: null}`. Failure writes `{ ...previous models kept, checkedAt: now(), error: message }`. Returns the state.
  - `ensureFresh(connection)`: not `cli`, and the state is missing, or older than 24 h after a success, or older than 15 min after a failure → start `refresh` in the background (don't await; catch everything). Returns the current state right away.
  - `effective(connection)` → `{ ...connection, models: mergeModels(state?.models ?? [], connection.models) }`.
  - `forget(id)` → delete the state file.
  - Named constants: `FRESH_MS = 24h`, `RETRY_AFTER_FAILURE_MS = 15min`, `DISCOVERY_TIMEOUT_MS = 45s`, `ENDPOINT_TIMEOUT_MS = 10s`.

### Bridge (`server/agent-bridge.ts`)
- `launchSchema`: add `discoverModels: z.boolean().default(false)`.
- Right where `probe` is handled: if `discoverModels`, run `session/new` with `{ cwd: os.tmpdir(), mcpServers: [] }`, emit `{ type: 'mc_models', ...modelsFromSession(session) }`, then `session/close` if `init.agentCapabilities?.sessionCapabilities?.close` (ignore its errors), return 0.

### Wiring: one place reads models
- `server/models.ts` `listModels`: connections use `effective(connection).models`, and call `ensureFresh` for each.
- `server/providers.ts` / `server/routes/providers.ts`: same effective list. `ensureFresh` per connection on read.
- Launch paths use the effective connection, so OpenCode-with-endpoint gets the discovered ids in its config: `server/jobs-engine-iface.ts:100`, `server/workflow-runner.ts:327`, `server/terminals.ts:198`, `server/auto-review.ts:63`. Add `getEffective(id)` on the store, or wrap at those call sites; pick one and use it at all four.
- `server/agent-connections.ts`: relax the rule "A custom endpoint needs at least one model ID". `POST /api/studio/connections` for `opencode` + `baseUrl` + no manual models: call `endpointModels` before saving. If it returns ≥ 1 model, save and write the discovery state. If not, 400 with `Couldn't list models from <baseUrl>: <reason>. Add at least one model ID.` (Implement the check in the route; drop the schema rule.)
- `POST /api/studio/connections` (any other save): after saving, `void refresh(saved)`, plus `modelsCache.invalidate()` as now.
- `DELETE /api/studio/connections/:id`: also `forget(id)`.
- New `POST /api/studio/connections/:id/models/refresh` → awaits `refresh`, returns the state; `cli` → 400 `This connection can't report its models; list them in its settings.`; then `modelsCache.invalidate()`.
- `GET /api/studio/connections`: add `discovery: Record<id, state | null>`.

### UI (`client/studio-settings.tsx`, `public/quiet.css`)
Detail view of a connected AI:
- The Models chips show the effective list (the details call already reads `/api/models`; make sure the connection's entry there is the effective list).
- Under the chips, one muted line:
  - ACP/OpenCode, ok: `Found automatically · checked <relative time>` + a `Refresh` button.
  - Error: `Couldn't list models: <error>` + `Refresh`.
  - Not checked yet: `Looking for models…` + `Refresh`.
  - `cli`: `This AI can't report its models. Add them in its settings.`
- `Refresh` calls the refresh route, disables itself and shows `Checking…` while waiting, then re-reads. A failure shows its message, never silence.
Edit form: label becomes `Extra model IDs · one per line (optional)` for acp/opencode, unchanged for cli.
Repo design rules: no emoji (SVG icons from the existing sprite), inputs flat `#e2e6f0`, match existing `.connection-*` styles. Check light and dark themes.

### mctl
- `mctl connection models <id> [--refresh]`: without the flag, read `GET /api/studio/connections` and print the effective list, checked time and error for that id. With `--refresh`, `POST .../models/refresh` and print the result. `--json` prints the state.
- Add it to `cli/commands/system.ts`, `test/cli-commands.test.ts`, `man/mctl.1`.

## Tests (TDD: each red first)
Match the style of the existing `test/agent-connections.test.ts`, `test/agent-bridge.test.ts`, `test/providers*.test.ts`.
1. `test/model-discovery.test.ts`
   - `modelsFromSession`: configOptions flat; configOptions grouped; only the old `models` form; both present (configOptions wins); neither; duplicates.
   - `endpointModels` with a fake fetch: ok; trailing slash; Bearer only with a key; HTTP 401 → error; malformed body → error; the key never appears in the error text.
   - Store with temp dir, fake bridge and fake `now`: refresh writes state; failure keeps the old models and records the error; two concurrent refreshes = one bridge call; `ensureFresh` triggers at 24 h (success) / 15 min (failure) and not before; `cli` never triggers; `effective` merges and dedupes; `forget` deletes.
2. Bridge: a fake ACP agent (follow `test/agent-bridge.test.ts`) returning configOptions → `mc_models` emitted; `session/close` sent only when advertised.
3. Routes: save opencode+baseUrl with no models → endpoint ok saves, endpoint fail 400 with message; refresh route on cli → 400; delete forgets; `/api/providers` returns the merged list.
4. `providers.test.ts` / `models` tests updated for the effective list.

## Acceptance
- New and touched tests green; full `bun test` has no new failures (record counts before and after).
- `bunx tsc -p tsconfig.studio.json`, `bunx tsc -p tsconfig.shell.json`, `bun run typecheck:cli` clean.
- Real-agent check without touching the live cockpit: run `refresh` against the real `grok agent stdio` with a TEMP config dir and print the result. It must list grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5.
- UI check on a throwaway server: `MISSION_CONTROL_CONFIG_DIR=<temp dir with a copy of ~/.config/mission-control/connections/grok.json> MISSION_CONTROL_PORT=7791 bun server/index.ts`. Use Playwright: Manage AIs → Grok shows the 4 models and "Found automatically · checked …"; Refresh works; light and dark screenshots. Stop that server by its PID only. Afterwards run `ln -sfn /Users/lynchz/Desktop/kingpinggroup/mission-control/skills/mc-dispatch ~/.claude/skills/mc-dispatch` (starting a server or running tests re-points it).
- The live cockpit on :7777 is never restarted or killed. The new server code goes live when the user restarts it.
