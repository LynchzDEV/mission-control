# Mission Control 2.0 · Phase 0 · Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app itself serves the quiet design at `/`, opens without a password (locked to this machine), exposes one provider list that every AI picker reads, and shows a live usage card — so phases 1–4 build on the real app, not the Vite preview.

**Architecture:** Server views stay `@kitajs/html` JSX rendered by Elysia; client code stays flat `client/*.ts` islands bundled on demand by `Bun.build` (`server/index.ts:65-90`). The quiet design's markup moves from `docs/design/quiet-chat/index.html` into `server/views/shell.tsx`; its scripts become islands under `client/`; its stylesheet becomes `public/quiet.css`. Authentication becomes a header guard (`server/local-access.ts`) plus the existing bearer token; the server always binds `127.0.0.1`.

**Tech Stack:** Bun, Elysia 1.4, @kitajs/html, xterm 6 (+fit, +web-links, +search), zod 4, `bun test`. No new dependencies in this phase.

**Spec:** `docs/decisions/system-chat.md` (Engine, Around the chat), `docs/new-design-port-status.md` §6–7, `docs/design/chat-agent-cards/DECISION.md` (launcher, chips), roadmap `docs/superpowers/plans/2026-09-24-v2-roadmap.md`.

## Global Constraints

- Trunk-based on `main`; one commit per task; never `git merge`.
- Comments: max 1 line, only for a trap no refactor can express. Decision records → commit body or `docs/decisions/*.md`.
- Do NOT match the surrounding code's comment density — existing dense files are legacy, not license.
- Form fields in the quiet design are flat (`#e2e6f0`, no inset shadow). Neumorphism only on cards, dialogs, buttons. No emoji anywhere; provider identity uses `public/providers/*.svg`.
- `bun test` must stay green after every task (859 pass today). Run only the files you touched while working; the full suite once before the last commit of the task.
- The app on 7777 is the user's live tool. Tasks marked **restart** change `server/` and take effect only after the user restarts it. Never restart it yourself.
- mc-dispatch keeps working throughout: `POST /api/jobs`, `/api/flow/*`, `/api/studio/runs*` with the bearer token (`server/auth.ts:9-27`) are untouched.

## Review Focus

1. A page on another origin (e.g. `https://evil.example`) fetching `http://127.0.0.1:7777/api/jobs` with `Origin: https://evil.example` — must get 403, never data. (Task 2 test `rejects a foreign Origin`.)
2. DNS rebinding: a request whose `Host` is `rebind.example:7777` resolving to loopback — must get 403. (Task 2 test `rejects a non-local Host`.)
3. A top-level link from another site to `http://127.0.0.1:7777/` (`Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) — must open the app; blocking it would make bookmarks from Slack/Notion fail. (Task 2 test `allows a top-level navigation from elsewhere`.)
4. A stale `mc_session` cookie from 1.x still in the browser — must be ignored, not crash `verifyCookieHeader` (it no longer exists). (Task 2 test `ignores leftover session cookies`.)
5. `/api/quota` returns `available: false` for every provider (fresh machine, no CLIs) — the usage card must render three dashes, not throw or hide the toolbar. (Task 6 test `renders unavailable providers as dashes` on `usageItems`.)

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `server/local-access.ts` (new) | pure request guard: local Host, matching Origin, Fetch-Metadata | 2 |
| `server/auth.ts` | keep `allowToken`, `verifyBearerToken`; add `requireLocal`; delete password/session code | 2 |
| `server/secrets.ts` | drop `AuthRecord`, `AUTH_FILE`, `bind`; `DEFAULT_BIND` becomes the only bind | 2, 3 |
| `server/routes/secrets.ts` | drop `bind`/`confirmAnyInterface` | 3 |
| `server/index.ts` | `/` → shell; delete setup/login/logout; no cookie plugin; bind from `MISSION_CONTROL_PORT` | 2, 3, 5 |
| `server/routes/terminals.ts` | ws upgrade uses `requireLocal` | 2 |
| `server/routes/providers.ts` (new) | `GET /api/providers` | 4 |
| `server/views/shell.tsx` (new) | quiet design markup | 5 |
| `server/views/login.tsx` | deleted | 2 |
| `public/quiet.css`, `public/vendor/neumo-ui.css`, `public/providers/*.svg` | quiet design assets | 5 |
| `client/shell.ts`, `client/shell-terminal.ts`, `client/shell-activity.ts`, `client/usage-card.ts` (new) | quiet islands | 5, 6 |
| `test/local-access.test.ts` (new), `test/providers-routes.test.ts` (new), `test/usage-card.test.ts` (new), `test/shell.test.ts` (new) | new coverage | 2, 4, 5, 6 |
| 14 existing test files | drop `completeSetup`/cookie helpers | 2 |

---

### Task 1: Freeze the preview as the reference `[here]`

The Vite preview (`docs/design/quiet-chat`) stays the design source. Before touching the app, capture what "done" looks like so Task 5 has a literal diff target.

**Files:**
- Create: `docs/design/quiet-chat/screenshots/` is gitignored; screenshots go to `docs/design/quiet-chat/reference/` (new, committed): `welcome-1512.png`, `terminal-1512.png`, `welcome-390.png`.

- [ ] **Step 1: Start the preview** (skip if 51947 already answers)

Run: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:51947/`
Expected: `200`. If not: `npm exec --yes --package=vite@8.3.0 -- vite docs/design/quiet-chat --host 127.0.0.1 --port 51947 --strictPort` in the background.

- [ ] **Step 2: Capture with the existing check script's browser**

Run: `mkdir -p docs/design/quiet-chat/reference && node -e "const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();for(const [w,h,n] of [[1512,982,'1512'],[390,844,'390']]){const p=await b.newPage({viewport:{width:w,height:h}});await p.goto('http://127.0.0.1:51947/');await p.screenshot({path:'docs/design/quiet-chat/reference/welcome-'+n+'.png'});}await b.close()})()"`
Expected: two PNGs written. Open both and confirm they show the welcome screen with the usage card at top right.

- [ ] **Step 3: Commit**

```bash
git add docs/design/quiet-chat/reference
git commit -m "docs(design): reference screenshots of the quiet shell for the 2.0 port"
```

---

### Task 2: Replace the password with a local-access guard `[worker]` **restart**

**Files:**
- Create: `server/local-access.ts`, `test/local-access.test.ts`
- Modify: `server/auth.ts` (keep lines 1-46 `allowToken`/`verifyBearerToken`; delete 48-249), `server/index.ts:13-20, 128-166, 254-296`, `server/routes/terminals.ts:6, 186-190`, `server/secrets.ts` (`AuthRecord`, `AUTH_FILE`, `readAuthRecord`, `writeAuthRecord`)
- Delete: `server/views/login.tsx`
- Modify tests: `test/api-token-auth.test.ts`, `test/auth.test.ts`, `test/flow-routes.test.ts`, `test/http.test.ts`, `test/jobs-routes.test.ts`, `test/models-routes.test.ts`, `test/meta.test.ts`, `test/resize.test.ts`, `test/runs-routes.test.ts`, `test/roles-routes.test.ts`, `test/secrets-route.test.ts`, `test/studio-routes.test.ts`, `test/terminals-routes.test.ts`, `test/views.test.ts`

**Interfaces:**
- Produces: `localRequestAllowed(request: Request): boolean` and `requireLocal(context: GuardContext): Promise<{ error: string } | undefined>` — every `.onBeforeHandle(requireSession)` becomes `.onBeforeHandle(requireLocal)`.

- [ ] **Step 1: Write the failing guard tests**

```ts
// test/local-access.test.ts
import { describe, expect, test } from 'bun:test'
import { localRequestAllowed } from '../server/local-access'

const req = (headers: Record<string, string>, url = 'http://127.0.0.1:7777/api/jobs', method = 'GET') =>
  new Request(url, { method, headers })

describe('localRequestAllowed', () => {
  test('allows a same-origin request from the app itself', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })
  test('allows localhost and [::1] hosts on any port', () => {
    expect(localRequestAllowed(req({ host: 'localhost:7781' }))).toBe(true)
    expect(localRequestAllowed(req({ host: '[::1]:7777' }))).toBe(true)
  })
  test('rejects a non-local Host (DNS rebinding)', () => {
    expect(localRequestAllowed(req({ host: 'rebind.example:7777' }))).toBe(false)
  })
  test('rejects a foreign Origin', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, 'http://127.0.0.1:7777/api/jobs', 'POST'))).toBe(false)
  })
  test('rejects a cross-site fetch even without Origin', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }))).toBe(false)
  })
  test('allows a top-level navigation from elsewhere', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'http://127.0.0.1:7777/'))).toBe(true)
  })
  test('rejects an embedded document from another site', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, 'http://127.0.0.1:7777/'))).toBe(false)
  })
  test('ignores leftover session cookies', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', cookie: 'mc_session=1.2.3' }))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/local-access.test.ts`
Expected: FAIL — `Cannot find module '../server/local-access'`.

- [ ] **Step 3: Write the guard**

```ts
// server/local-access.ts
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function hostname(host: string | null): string | null {
  if (host === null || host === '') return null
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(host)
  if (bracketed) return bracketed[1]!
  return host.split(':')[0]!
}

export function localRequestAllowed(request: Request): boolean {
  const host = hostname(request.headers.get('host'))
  if (host === null || !LOCAL_HOSTS.has(host)) return false
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'null') {
    let originHost: string | null
    try { originHost = hostname(new URL(origin).host) } catch { return false }
    if (originHost === null || !LOCAL_HOSTS.has(originHost)) return false
  }
  const site = request.headers.get('sec-fetch-site')
  if (site === null || site === 'same-origin' || site === 'none') return true
  const topLevelDocument = request.method === 'GET'
    && request.headers.get('sec-fetch-mode') === 'navigate'
    && request.headers.get('sec-fetch-dest') === 'document'
  return topLevelDocument
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/local-access.test.ts`
Expected: 8 pass.

- [ ] **Step 5: Replace `requireSession` with `requireLocal` in `server/auth.ts`**

Delete everything from `export const MIN_PASSWORD_LENGTH` (line 48) to the end of the file. Keep the imports needed by `verifyBearerToken` (`timingSafeEqual`, `readApiToken`). Append:

```ts
import { localRequestAllowed } from './local-access'

export type GuardContext = { request: Request; set: { status?: number | string } }

export async function requireLocal(context: GuardContext) {
  if (localRequestAllowed(context.request)) return
  const { pathname } = new URL(context.request.url)
  if (allowToken(pathname, context.request.method) && (await verifyBearerToken(context.request.headers.get('authorization')))) return
  context.set.status = 403
  return { error: 'local access only' }
}
```

Then: `grep -rl "requireSession" server | xargs sed -i '' 's/requireSession/requireLocal/g'`.

- [ ] **Step 6: Strip auth records and the bind setting from `server/secrets.ts`**

Delete `AUTH_FILE`, `AuthRecord`, `readAuthRecord`, `writeAuthRecord`. Leave `bind` in `AppConfig` for Task 3. Run `bun test test/secrets.test.ts` and delete any test in it that exercised the auth record.

- [ ] **Step 7: Rewrite the entry points in `server/index.ts`**

Remove the imports `MIN_PASSWORD_LENGTH, SESSION_COOKIE, SESSION_TTL_MS, attemptLogin, completeSetup, isSetupComplete, verifyCookieHeader` and `cookie`, `LoginPage, SetupPage`. Delete `setupPage`, `loginPage`, `CookieJar`, `grantSession`, `rateLimitKey`, the `.use(cookie())`, `.post('/api/setup'…)`, `.post('/api/login'…)`, `.post('/api/logout'…)`. Replace `.get('/', …)` and `tabPages()`:

```ts
import { requireLocal } from './auth'
import { localRequestAllowed } from './local-access'

function tabPages() {
  const instance = new Elysia()
  for (const [path, view] of Object.entries(TAB_PAGES)) {
    instance.get(path, async ({ request, set }) => {
      if (!localRequestAllowed(request)) { set.status = 403; return 'local access only' }
      const embedded = new URL(request.url).searchParams.get('embed') === '1'
      return page(await (embedded || path === '/terminals' ? view(embedded) : terminalsPage()))
    })
  }
  return instance
}
// in createApp():
    .get('/', async ({ request, set }) => {
      if (!localRequestAllowed(request)) { set.status = 403; return 'local access only' }
      return appShellPage()
    })
```

- [ ] **Step 8: Guard the terminal WebSocket the same way**

In `server/routes/terminals.ts` replace the import of `verifyCookieHeader` with `localRequestAllowed` from `'../local-access'`, and in the `.ws('/ws/terminal/:id', { beforeHandle … })` block replace the cookie check with:

```ts
      if (localRequestAllowed(request) && request.headers.get('origin') !== null) return
      set.status = 403
      return 'local access only'
```

(A WebSocket upgrade always carries `Origin`; requiring it blocks non-browser clients from opening a PTY without the bearer token path, which never covered `/ws`.)

- [ ] **Step 9: Delete the login view**

`git rm server/views/login.tsx`. No client code redirects to a login page (`client/shared.ts` has no 401 branch; checked 2026-09-24), so a 403 surfaces as the response's `error` text like any other failure. Nothing else to change.

- [ ] **Step 10: Update the 14 test files**

In each listed test file: delete `PASSWORD`, `sessionCookie`/`cookie()` helpers, `completeSetup`, `resetLoginLimiter` and `SESSION_COOKIE` imports; call `app.handle(request)` without a cookie. Requests built as `new Request('http://localhost/…')` carry `Host: localhost` and pass the guard. In `test/http.test.ts` replace the `setup then login then health` and `login rate limiting` describes with:

```ts
describe('local access', () => {
  test('GET / serves the app shell to a local browser', async () => {
    const response = await app.handle(get('/'))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('id="composer"')
  })
  test('a foreign Origin is refused on data routes', async () => {
    const response = await app.handle(new Request('http://127.0.0.1/api/jobs', { headers: { host: '127.0.0.1:7777', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }))
    expect(response.status).toBe(403)
  })
  test('a rebinding Host is refused everywhere but health', async () => {
    expect((await app.handle(new Request('http://rebind.example/api/jobs', { headers: { host: 'rebind.example:7777' } }))).status).toBe(403)
    expect((await app.handle(new Request('http://rebind.example/api/health', { headers: { host: 'rebind.example:7777' } }))).status).toBe(200)
  })
})
```

In `test/auth.test.ts` delete the `password hashing`, `session tokens`, `cookie header parsing`, `isolated service`, `rate limiter`, `setup`, `login`, `verifyCookieHeader` describes; keep `allowToken` and `verifyBearerToken`. In `test/views.test.ts` delete `gate views` and change `unauthenticated tab requests are redirected to the gate` to expect 403 for `Host: rebind.example`. In `test/api-token-auth.test.ts` keep every bearer case; the "cookie flow still works alongside" test becomes "a plain local request works alongside the token scope". In `test/secrets-route.test.ts` the `session guard` describe becomes a foreign-Origin 403 check.

- [ ] **Step 11: Run the suite**

Run: `bun test`
Expected: all pass; the count drops (deleted password tests) and rises (new guard tests). Zero fail.

- [ ] **Step 12: Commit**

```bash
git add -A server client test
git commit -m "feat(auth): replace the password with a local-access guard

Mission Control is used on this machine only. A request is served when its Host is loopback, its Origin (if any) is loopback, and Fetch Metadata says same-origin, none, or a top-level document navigation; the bearer token keeps its scoped API access for mc-dispatch. Setup, login, logout, session cookies, rate limiting and the auth record are removed."
```

---

### Task 3: Always bind loopback `[worker]` **restart**

**Files:**
- Modify: `server/secrets.ts` (`AppConfig.bind`, `readConfig`, `parseBind`), `server/routes/secrets.ts` (bind patch + `confirmAnyInterface`), `server/index.ts:296-311`, `test/secrets-route.test.ts`, `test/secrets.test.ts`, `README.md` (Security section)

**Interfaces:**
- Produces: `listenTarget(): BindTarget` in `server/secrets.ts` — `{ hostname: '127.0.0.1', port: Number(process.env.MISSION_CONTROL_PORT) || 7777 }`.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/secrets.test.ts
import { listenTarget } from '../server/secrets'
describe('listenTarget', () => {
  test('is loopback on 7777 by default', () => {
    delete process.env.MISSION_CONTROL_PORT
    expect(listenTarget()).toEqual({ hostname: '127.0.0.1', port: 7777 })
  })
  test('honours MISSION_CONTROL_PORT and ignores junk', () => {
    process.env.MISSION_CONTROL_PORT = '7781'
    expect(listenTarget().port).toBe(7781)
    process.env.MISSION_CONTROL_PORT = 'nope'
    expect(listenTarget().port).toBe(7777)
    delete process.env.MISSION_CONTROL_PORT
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/secrets.test.ts`
Expected: FAIL — `listenTarget` is not exported.

- [ ] **Step 3: Implement**

In `server/secrets.ts` remove `bind` from `AppConfig` and `readConfig`, delete `parseBind` and `BindTarget` consumers, add:

```ts
export type BindTarget = { hostname: '127.0.0.1'; port: number }
export function listenTarget(): BindTarget {
  const port = Number.parseInt(process.env.MISSION_CONTROL_PORT ?? '', 10)
  return { hostname: '127.0.0.1', port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7777 }
}
```

In `server/routes/secrets.ts` delete `bind`, `confirmAnyInterface`, `isBind`, `isAnyInterfaceHost`, `parseBind` import; `SecretsResponse` loses `bind`; `applyPatch` errors with `nothing to update` when both token and base URL are null. In `server/index.ts` the `import.meta.main` block becomes:

```ts
if (import.meta.main) {
  const target = listenTarget()
  const occupied = await fetch(`http://${target.hostname}:${target.port}/api/health`, { signal: AbortSignal.timeout(800) }).then(() => true, () => false)
  if (occupied) { console.error(`mission-control: ${target.hostname}:${target.port} already answers — another instance is running, refusing to double-bind`); process.exit(1) }
  const app = await createApp()
  app.listen({ hostname: target.hostname, port: target.port, reusePort: false })
  console.log(`mission-control listening on http://${target.hostname}:${target.port}`)
}
```

Delete the five `bind` tests in `test/secrets-route.test.ts` (`updates the base url and a non-wildcard bind address` keeps only its base-url half). README Security bullet becomes: "Binds `127.0.0.1` only; the port comes from `MISSION_CONTROL_PORT` (default 7777). Requests are served only to local browsers (Host/Origin/Fetch-Metadata guard) or with the API token; health and static assets are public."

- [ ] **Step 4: Run tests**

Run: `bun test test/secrets.test.ts test/secrets-route.test.ts test/http.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A server test README.md
git commit -m "feat(server): always listen on loopback

The bind address setting is gone; the port comes from MISSION_CONTROL_PORT. Widening to a network interface is no longer possible from the app, which is what makes the password-free local guard safe."
```

---

### Task 4: One provider list for every AI picker `[worker]` **restart**

**Files:**
- Create: `server/providers.ts`, `server/routes/providers.ts`, `test/providers.test.ts`, `test/providers-routes.test.ts`
- Modify: `server/index.ts` (`.use(providersRoutes)`), `server/auth.ts:5` (`TOKEN_SCOPED_GET_ONLY_PATHS` gains `/api/providers`)

**Interfaces:**
- Produces:
```ts
export type Provider = { id: string; name: string; builtin: boolean; models: string[]; resumable: boolean; family: string | null }
export async function listProviders(deps: { models: () => Promise<ModelLists>; connections: () => Promise<AgentConnection[]> }): Promise<Provider[]>
// GET /api/providers → { providers: Provider[] }
```
Phases 1, 2 and 4 read this for the composer AI chip, the launcher engine select, and Studio step engines.

- [ ] **Step 1: Write the failing unit test**

```ts
// test/providers.test.ts
import { describe, expect, test } from 'bun:test'
import { listProviders } from '../server/providers'

const acp = { id: 'qwen', name: 'Qwen Code', adapter: 'acp' as const, command: 'qwen', args: ['--acp'], env: {}, models: ['qwen3-coder'], autoApprove: false, output: 'text' as const, provider: 'custom', family: 'qwen' }
const cli = { ...acp, id: 'mycli', name: 'My CLI', adapter: 'cli' as const, args: ['-p', '{{prompt}}'], models: [], family: undefined }
const resumableCli = { ...cli, id: 'rcli', name: 'Resumable CLI', args: ['-p', '{{prompt}}', '--resume', '{{session}}'] }

describe('listProviders', () => {
  test('built-ins come first with their live model lists and are resumable', async () => {
    const providers = await listProviders({ models: async () => ({ claude: ['opus', 'sonnet'], glm: ['glm-5.3'], codex: ['gpt-5.5'] }), connections: async () => [] })
    expect(providers.map(p => p.id)).toEqual(['claude', 'glm', 'codex'])
    expect(providers[0]).toEqual({ id: 'claude', name: 'Claude', builtin: true, models: ['opus', 'sonnet'], resumable: true, family: 'claude' })
  })
  test('custom connections follow, sorted by name, with resumable derived from the connection', async () => {
    const providers = await listProviders({ models: async () => ({ claude: [], glm: [], codex: [] }), connections: async () => [cli, acp, resumableCli] })
    expect(providers.slice(3).map(p => [p.id, p.resumable, p.family])).toEqual([['mycli', false, null], ['qwen', true, 'qwen'], ['rcli', true, null]])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/providers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/providers.ts
import type { AgentConnection } from './agent-connections'
import { ENGINE_NAMES, type EngineName } from './engines'
import type { ModelLists } from './models'

export type Provider = { id: string; name: string; builtin: boolean; models: string[]; resumable: boolean; family: string | null }

const BUILTIN_NAMES: Record<EngineName, string> = { claude: 'Claude', glm: 'GLM', codex: 'Codex' }

function connectionResumable(connection: AgentConnection): boolean {
  if (connection.adapter === 'cli') return connection.args.some(arg => arg.includes('{{session}}'))
  return true
}

export async function listProviders(deps: { models: () => Promise<ModelLists>; connections: () => Promise<AgentConnection[]> }): Promise<Provider[]> {
  const [models, connections] = await Promise.all([deps.models(), deps.connections()])
  const builtins = ENGINE_NAMES.map(id => ({ id, name: BUILTIN_NAMES[id], builtin: true, models: models[id] ?? [], resumable: true, family: id }))
  const custom = connections
    .map(connection => ({ id: connection.id, name: connection.name, builtin: false, models: connection.models, resumable: connectionResumable(connection), family: connection.family ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...builtins, ...custom]
}
```

```ts
// server/routes/providers.ts
import { Elysia } from 'elysia'
import { createConnectionStore } from '../agent-connections'
import { requireLocal } from '../auth'
import { listProviders } from '../providers'
import { modelsCache } from './models'

export const providersRoutes = new Elysia()
  .onBeforeHandle(requireLocal)
  .get('/api/providers', async () => ({ providers: await listProviders({ models: () => modelsCache.get(), connections: () => createConnectionStore().list() }) }))
```

Note for the ACP branch: `agent-bridge.ts:154` learns `loadSession` only after a session starts; the list reports ACP agents as resumable and the chat (phase 2) checks the live capability before offering a reply.

- [ ] **Step 4: Route test**

```ts
// test/providers-routes.test.ts — same beforeEach/afterEach shape as test/models-routes.test.ts
test('GET /api/providers lists built-ins and saved connections', async () => {
  await createConnectionStore(dir).save({ id: 'qwen', name: 'Qwen Code', adapter: 'acp', command: 'qwen', args: ['--acp'], models: ['qwen3-coder'] })
  const response = await app.handle(new Request('http://localhost/api/providers'))
  expect(response.status).toBe(200)
  const { providers } = await response.json() as { providers: Array<{ id: string }> }
  expect(providers.map(p => p.id)).toEqual(['claude', 'glm', 'codex', 'qwen'])
})
test('the bearer token may read it', async () => {
  const response = await app.handle(new Request('http://rebind.example/api/providers', { headers: { host: 'rebind.example:7777', authorization: `Bearer ${await readApiToken()}` } }))
  expect(response.status).toBe(200)
})
```

Add `'/api/providers'` to `TOKEN_SCOPED_GET_ONLY_PATHS` in `server/auth.ts` and `.use(providersRoutes)` after `.use(modelsRoutes)` in `server/index.ts`.

- [ ] **Step 5: Run**

Run: `bun test test/providers.test.ts test/providers-routes.test.ts test/auth.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add server/providers.ts server/routes/providers.ts server/auth.ts server/index.ts test/providers.test.ts test/providers-routes.test.ts
git commit -m "feat(api): one provider list for every AI picker

GET /api/providers merges the built-in engines (with live model lists) and saved connections into one ordered list with a resumable flag, so the composer chip, the terminal launcher and Studio read the same source."
```

---

### Task 5: Serve the quiet shell at `/` `[here]` **restart**

The design's markup and scripts move into the app. Everything that already worked in the preview against the real API (launcher, terminal, Agents, Flow) keeps working; the sample chat stays sample until phase 2.

**Files:**
- Create: `server/views/shell.tsx`, `client/shell.ts` (from `docs/design/quiet-chat/preview.js`), `client/shell-terminal.ts` (from `live-terminal.js`), `client/shell-activity.ts` (from `live-activity.js`), `public/quiet.css` (from `style.css` + `terminals.css` is NOT included; phase 1), `public/vendor/neumo-ui.css` (+ `neumo-ui-LICENSE`), `public/providers/{claude,codex,glm,qwen}.svg` (+ `SOURCE.txt`), `test/shell.test.ts`
- Modify: `server/index.ts` (`appShellPage`), `server/views/layout.tsx` (nothing yet — old tab pages keep the old layout until phase 5), `scripts/postinstall.ts` (no change: `public/quiet.css` is committed, not generated)

**Interfaces:**
- Consumes: `GET /api/providers` (Task 4) for the launcher engine list; `GET /api/terminals`, `POST /api/terminals`, `/ws/terminal/:id`, `/api/jobs`, `/api/flow`, `/api/studio/workflows` as the preview does today.
- Produces: `ShellPage(props: { workspaceDir: string }): string`; islands `shell`, `shell-terminal`, `shell-activity` served at `/js/<name>.js`.

- [ ] **Step 1: Write the failing view test**

```ts
// test/shell.test.ts — beforeEach/afterEach as in test/views.test.ts
describe('quiet shell', () => {
  test('/ renders the composer, toolbar controls and the usage card mount', async () => {
    const markup = await (await app.handle(new Request('http://localhost/'))).text()
    for (const marker of ['id="composer"', 'id="new-chat"', 'id="open-agents"', 'id="toggle-flow"', 'id="usage-track"', 'id="live-launch"', 'href="/quiet.css"', 'href="/vendor/neumo-ui.css"']) expect(markup).toContain(marker)
    expect(markup).not.toContain('id="tabs"')
    expect(markup).not.toContain('Design preview')
  })
  test('the shell islands transpile', async () => {
    for (const island of ['shell', 'shell-terminal', 'shell-activity']) {
      const response = await app.handle(new Request(`http://localhost/js/${island}.js`))
      expect(response.status).toBe(island === 'shell' ? 200 : 200)
      expect((await response.text()).length).toBeGreaterThan(100)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/shell.test.ts`
Expected: FAIL — `/` still renders the old terminals page (`id="tabs"` present).

- [ ] **Step 3: Copy assets**

```bash
cp docs/design/quiet-chat/style.css public/quiet.css
cp docs/design/quiet-chat/vendor/neumo-ui.css docs/design/quiet-chat/vendor/neumo-ui-LICENSE public/vendor/
mkdir -p public/providers && cp docs/design/quiet-chat/vendor/providers/* public/providers/
```
In `public/quiet.css` line 1 change `@import url('./vendor/neumo-ui.css') layer(neumo);` to `@import url('/vendor/neumo-ui.css') layer(neumo);` and every `./vendor/providers/` to `/providers/`.

- [ ] **Step 4: Write `server/views/shell.tsx`**

Convert `docs/design/quiet-chat/index.html` body to JSX in one component. Rules for the conversion:
- `<svg class="symbols">` block, `<main class="canvas">`, the three `<dialog>`s and the `<template>`s copy verbatim (JSX: `class` stays `class` under @kitajs/html; self-closing `<use href="#x"/>` stays).
- Delete `<footer class="preview-footer">` and the `preview-label` span.
- Delete `<script type="module" src="./preview.js">`/`usage-card.js` tags; the head is built by the component.
- `./vendor/providers/` → `/providers/`.
- Head:

```tsx
/** @jsxImportSource @kitajs/html */
export type ShellProps = { workspaceDir: string }
export function ShellPage(props: ShellProps): string {
  return `<!doctype html>\n${(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Mission Control</title>
        <link rel="icon" href="data:," />
        <link rel="stylesheet" href="/vendor/xterm.css" />
        <link rel="stylesheet" href="/vendor/neumo-ui.css" />
        <link rel="stylesheet" href="/quiet.css" />
        <script>{`window.MC_WORKSPACE_DIR=${JSON.stringify(props.workspaceDir)}`}</script>
        <script src="/js/shell.js" type="module" defer></script>
        <script src="/js/shell-terminal.js" type="module" defer></script>
        <script src="/js/shell-activity.js" type="module" defer></script>
        <script src="/js/usage-card.js" type="module" defer></script>
      </head>
      <body>{/* converted markup */}</body>
    </html>
  )}`
}
```
- The Studio button (`#open-studio`) becomes `<a class="pill" id="open-studio" href="/studio">Studio</a>` — the React Studio page stays on the old theme until phase 4. Remove the `#studio` section and its `data-studio` handlers from `client/shell.ts`.
- The `usage-card` markup (`<section class="usage-card">…`) is kept as an empty `<div class="usage-track" id="usage-track"></div>`; Task 6 fills it.

- [ ] **Step 5: Port the scripts**

`client/shell.ts` ← `preview.js`: drop Studio (`showScreen('studio')`, `renderSteps`, connections, runs, rules handlers); keep welcome/history/conversation/agents/flow/session dialog/composer. Add `export {}` at the end so it is a module. Type `$` as `(id: string) => document.getElementById(id) as HTMLElement`.

`client/shell-terminal.ts` ← `live-terminal.js`: imports become `from './terminal-view'` and `from './shared'` (flat `client/`), `import { Terminal } from '@xterm/xterm'`, `import { FitAddon } from '@xterm/addon-fit'` stay (Bun bundles them); delete the `import '@xterm/xterm/css/xterm.css'` line (the head links `/vendor/xterm.css`); `import.meta.env.VITE_WORKSPACE_DIR` → `(window as { MC_WORKSPACE_DIR?: string }).MC_WORKSPACE_DIR ?? ''`; the engine list comes from `getJson('/api/providers')` — replace the `/api/models` + `/api/roles` pair with:

```ts
const providers = await getJson('/api/providers')
if (!providers.ok) { $('live-error').textContent = errorText(providers); return }
const list = readArray(providers.data.providers) as Array<{ id: string; name: string; models: string[] }>
$('live-engine').replaceChildren(...list.map(p => new Option(p.name, p.id)))
models = Object.fromEntries(list.map(p => [p.id, p.models]))
```
The last-used engine/model is remembered in `localStorage` under `mc.shell.engine` and `mc.shell.model` (decision: "a new chat and the terminal launcher start with what you used last").

`client/shell-activity.ts` ← `live-activity.js`: imports `from './awareness'`, `from './work'`, `from './shared'`, `from './terminal-view'`.

- [ ] **Step 6: Wire `/`**

In `server/index.ts`:

```ts
import { ShellPage } from './views/shell'
async function appShellPage(): Promise<Response> {
  return page(ShellPage({ workspaceDir: homedir() }))
}
```
(`import { homedir } from 'node:os'`.) `/terminals` keeps rendering the old page until phase 1 replaces it.

- [ ] **Step 7: Run tests, then look at it**

Run: `bun test test/shell.test.ts test/views.test.ts test/transpile.test.ts`
Expected: pass. Then ask the user to restart the app; open `http://127.0.0.1:7777/` at 1512px and 390px and compare with `docs/design/quiet-chat/reference/*.png`: toolbar row, welcome mark, composer geometry, usage-card slot. Open the launcher, start a real terminal, confirm keystrokes echo and Agents/Flow open. Fix any drift in `public/quiet.css` before committing.

- [ ] **Step 8: Commit**

```bash
git add server/views/shell.tsx server/index.ts client/shell.ts client/shell-terminal.ts client/shell-activity.ts public/quiet.css public/vendor/neumo-ui.css public/vendor/neumo-ui-LICENSE public/providers test/shell.test.ts
git commit -m "feat(ui): serve the quiet shell at /

The quiet design's markup becomes server/views/shell.tsx, its scripts become the shell, shell-terminal and shell-activity islands, and its stylesheet public/quiet.css. The launcher reads /api/providers and remembers the last engine and model. Studio still opens the React page; the chat stays sample until the system chat lands."
```

---

### Task 6: Live usage card `[here]`

**Files:**
- Create: `client/usage-card.ts` (logic from `docs/design/quiet-chat/usage-card.js` + rendering), `test/usage-card.test.ts`
- Modify: `public/quiet.css` (usage-card rules already present from Task 5; add `[data-unavailable="true"] strong { color: var(--muted) }`)

**Interfaces:**
- Consumes: `normalizeUsage(provider, raw)` and `ProviderUsage` from `client/provider-usage.ts`; `GET /api/quota`; `GET /api/providers`.
- Produces: `usageItems(values: ProviderUsage[]): UsageItem[]` (pure), `renderUsageCard(track: HTMLElement, values: ProviderUsage[]): void`, `scrollPlan(distance: number, pps?: number): Keyframe[]`.

- [ ] **Step 1: Write the failing tests** (the repo has no DOM library in tests — `test/awareness-client.test.ts` hand-rolls nodes — so the card's data shape is a pure function and rendering is checked visually in Step 4)

```ts
// test/usage-card.test.ts
import { describe, expect, test } from 'bun:test'
import { scrollPlan, usageItems } from '../client/usage-card'
import { normalizeUsage } from '../client/provider-usage'

describe('usageItems', () => {
  test('one item per provider with logo path, primary percent and weekly percent', () => {
    const items = usageItems([normalizeUsage('claude', { available: true, fiveHourPct: 42, weeklyPct: 61 }), normalizeUsage('codex', { available: true, weeklyPct: 73 })])
    expect(items).toEqual([
      { provider: 'claude', name: 'Claude', logo: '/providers/claude.svg', period: '5h', primary: '42%', primaryPercent: 42, weekly: '61%', weeklyPercent: 61, unavailable: false },
      { provider: 'codex', name: 'Codex', logo: '/providers/codex.svg', period: 'Week', primary: '73%', primaryPercent: 73, weekly: null, weeklyPercent: null, unavailable: false },
    ])
  })
  test('renders unavailable providers as dashes', () => {
    const [item] = usageItems([normalizeUsage('glm', { available: false, reason: 'no token' })])
    expect(item).toMatchObject({ name: 'GLM', primary: '—', weekly: '—', unavailable: true })
  })
})

describe('scrollPlan', () => {
  test('goes out, pauses 5s, comes back, pauses 5s', () => {
    const frames = scrollPlan(140, 14)
    expect(frames.map(f => f.transform)).toEqual(['translateX(0)', 'translateX(-140px)', 'translateX(-140px)', 'translateX(0)', 'translateX(0)'])
    const total = (140 / 14) * 1000 * 2 + 10000
    expect(frames[1]!.offset).toBeCloseTo(10000 / total)
    expect(frames[2]!.offset).toBeCloseTo(15000 / total)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/usage-card.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// client/usage-card.ts
import { getJson, readArray } from './shared'
import { normalizeUsage, weeklyOnly, type ProviderUsage } from './provider-usage'

const VISIBLE = 3, PAUSE_MS = 5000, PIXELS_PER_SECOND = 14

export function scrollPlan(distance: number, pps = PIXELS_PER_SECOND): Keyframe[] {
  const travel = (distance / pps) * 1000, total = travel * 2 + PAUSE_MS * 2, at = (ms: number) => ms / total
  return [
    { transform: 'translateX(0)', offset: 0, easing: 'ease-in-out' },
    { transform: `translateX(${-distance}px)`, offset: at(travel) },
    { transform: `translateX(${-distance}px)`, offset: at(travel + PAUSE_MS), easing: 'ease-in-out' },
    { transform: 'translateX(0)', offset: at(travel * 2 + PAUSE_MS) },
    { transform: 'translateX(0)', offset: 1 },
  ]
}

export type UsageItem = { provider: string; name: string; logo: string; period: '5h' | 'Week'; primary: string; primaryPercent: number | null; weekly: string | null; weeklyPercent: number | null; unavailable: boolean }

const label = (percent: number | null): string => percent === null ? '—' : `${Math.round(percent)}%`

export function usageItems(values: ProviderUsage[]): UsageItem[] {
  return values.map(data => {
    const single = weeklyOnly(data.provider), primary = single ? data.weekly : data.fiveHour
    return {
      provider: data.provider,
      name: data.provider === 'glm' ? 'GLM' : data.provider[0]!.toUpperCase() + data.provider.slice(1),
      logo: `/providers/${data.provider}.svg`,
      period: single ? 'Week' : '5h',
      primary: label(primary.percent), primaryPercent: primary.percent,
      weekly: single ? null : label(data.weekly.percent), weeklyPercent: single ? null : data.weekly.percent,
      unavailable: primary.percent === null && data.weekly.percent === null,
    }
  })
}

function meter(value: number | null): HTMLMeterElement {
  const el = document.createElement('meter'); el.min = 0; el.max = 100; el.value = value ?? 0; return el
}

export function renderUsageCard(track: HTMLElement, values: ProviderUsage[]): void {
  track.replaceChildren(...usageItems(values).map(item => {
    const root = document.createElement('div'); root.className = 'usage-item'; root.dataset.provider = item.provider; root.dataset.unavailable = String(item.unavailable)
    const head = document.createElement('div'); head.className = 'usage-head'
    const logo = document.createElement('img'); logo.src = item.logo; logo.alt = ''
    const name = document.createElement('span'); name.textContent = item.name
    const period = document.createElement('small'); period.textContent = item.period
    const value = document.createElement('strong'); value.textContent = item.primary
    head.append(logo, name, period, value)
    root.append(head, meter(item.primaryPercent))
    if (item.weekly !== null) {
      const week = document.createElement('div'); week.className = 'usage-week'
      const weekLabel = document.createElement('span'); weekLabel.textContent = 'Week'
      const weekValue = document.createElement('span'); weekValue.textContent = item.weekly
      week.append(weekLabel, meter(item.weeklyPercent), weekValue); root.append(week)
    }
    return root
  }))
}

function startScroll(track: HTMLElement, viewport: HTMLElement, current: { animation: Animation | null }): void {
  current.animation?.cancel(); current.animation = null
  const { paddingLeft, paddingRight } = getComputedStyle(viewport)
  const distance = track.scrollWidth - (viewport.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight))
  if (track.children.length <= VISIBLE || distance <= 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const frames = scrollPlan(distance)
  current.animation = track.animate(frames, { duration: (distance / PIXELS_PER_SECOND) * 1000 * 2 + PAUSE_MS * 2, iterations: Infinity })
}

async function refresh(track: HTMLElement, viewport: HTMLElement, current: { animation: Animation | null }): Promise<void> {
  if (document.hidden) return
  const [quota, providers] = await Promise.all([getJson('/api/quota'), getJson('/api/providers')])
  const ids = providers.ok ? readArray(providers.data.providers).map(p => (p as { id: string }).id) : ['claude', 'glm', 'codex']
  const withQuota = ids.filter(id => ['claude', 'glm', 'codex'].includes(id) || (quota.ok && quota.data[id] !== undefined))
  renderUsageCard(track, withQuota.map(id => normalizeUsage(id, quota.ok ? quota.data[id] : null)))
  startScroll(track, viewport, current)
}

const track = document.getElementById('usage-track')
if (track) {
  const viewport = track.parentElement as HTMLElement
  const current: { animation: Animation | null } = { animation: null }
  viewport.addEventListener('mouseenter', () => current.animation?.pause())
  viewport.addEventListener('mouseleave', () => current.animation?.play())
  viewport.addEventListener('focusin', () => current.animation?.pause())
  viewport.addEventListener('focusout', () => current.animation?.play())
  new ResizeObserver(() => startScroll(track, viewport, current)).observe(viewport)
  void refresh(track, viewport, current)
  setInterval(() => void refresh(track, viewport, current), 15000)
}
export {}
```
Brand colours already live in `public/quiet.css` (`.usage-item[data-provider="…"] { --brand: … }`); a custom provider without a rule falls back to `--accent`.

- [ ] **Step 4: Run, then look**

Run: `bun test test/usage-card.test.ts`
Expected: pass. Reload `http://127.0.0.1:7777/` (no restart needed: islands rebuild on change): the card shows real Claude/GLM/Codex numbers from `/api/quota`; with only three providers it does not scroll.

- [ ] **Step 5: Commit**

```bash
git add client/usage-card.ts test/usage-card.test.ts public/quiet.css
git commit -m "feat(ui): live usage card in the quiet shell

Three providers visible; with more it auto-scrolls left to right, pauses 5 s, returns, pauses 5 s, and stops on hover, focus or reduced motion. Bars use each provider's logo colour; unavailable providers show a dash."
```

---

### Task 7: Retire the old entry points `[worker]` **restart**

The shell owns `/`. The old header still links to `/lanes`, `/dispatch`, `/review`, `/settings`; those pages keep working until their phases delete them, but nothing in the shell should lead to a login-era page.

**Files:**
- Modify: `client/workspace.ts` (`ROUTES` keeps old paths; remove `installMotion` ASCII horizon call from `/`), `client/nav.ts` (unchanged), `server/views/layout.tsx:53` (brand link `href="/"`), `README.md` (Quick start: remove "create a password")

- [ ] **Step 1: Write the failing test**

```ts
// append to test/shell.test.ts
test('the old tab pages link home to the shell and never to a gate', async () => {
  const markup = await (await app.handle(new Request('http://localhost/settings'))).text()
  expect(markup).toContain('href="/" aria-label="Mission Control home"')
  expect(markup).not.toContain('/api/login')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/shell.test.ts`
Expected: FAIL — brand link is `/terminals`.

- [ ] **Step 3: Implement**

`server/views/layout.tsx` line 53: `href="/terminals"` → `href="/"`. README Quick start: delete "On your first visit, create a password (argon2id, minimum 10 characters). Then:" → "Then:". In `client/workspace.ts` guard `installMotion()` so it only runs when `#ascii-horizon` exists (it already returns early; no change if so — verify and move on).

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/views/layout.tsx README.md client/workspace.ts test/shell.test.ts
git commit -m "chore(ui): old pages link home to the quiet shell; README drops the password step"
```

---

## Restart points

- After Task 2 + 3 (do them back to back, one restart): the app opens with no password; the cockpit's mc-dispatch token keeps working.
- After Task 4: `/api/providers` exists.
- After Task 5: `/` is the quiet shell.
- Task 6 needs no restart. Task 7 needs one.

## Self-review

- Spec coverage: password removal (system-chat "Around the chat" → Task 2/3), one provider list (port-status §6 rule → Task 4), usage card (§6 → Task 6), shell served by the app (roadmap phase 0 → Task 5), last-used engine default (§7 → Task 5 step 5). Chat home, History, team cards belong to phases 2–3 and are not in this plan.
- Type consistency: `Provider` shape used identically in Task 4 tests/route and Task 5/6 consumers; `requireLocal`/`localRequestAllowed` names match across Tasks 2, 4.
- Review Focus items 1–4 pinned in Task 2 tests, item 5 in Task 6.
