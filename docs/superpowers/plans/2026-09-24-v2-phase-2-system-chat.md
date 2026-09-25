# Mission Control 2.0 — Phase 2: System chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The quiet landing page becomes a real chat: one job thread per chat, run in Chat home by the AI the composer chip names, that spawns Mission Control agents on its own, gets their reports back as chat turns, lands reviewed work itself, and shows each reply's team as a card.

**Architecture:** A chat is a job thread (`server/threads.ts`) with `purpose: 'chat'`. The chat process is an ordinary engine job whose rules (`server/chat-profile.ts`) arrive as an appended system prompt and whose environment carries `MC_URL`, `MC_TOKEN` and `MC_CHAT_ID`, so it drives the existing `/api/jobs*` endpoints with curl exactly as the mc-dispatch skill does. Jobs it spawns carry `chatId` + `chatTurn`; when one settles the server posts an agent report as a new turn of the chat (`source: 'agent'`), so the chat reacts (review, land, retry, relay) without the user. The client island `client/chat.ts` renders the thread (markdown, activity line, team card per turn) from `/api/jobs/:id/thread` and `/api/jobs?chat=<root>`.

**Tech Stack:** Bun + Elysia, `@kitajs/html` views, client islands bundled on demand, `client/markdown.ts`, `bun:test`.

**Spec:** `docs/decisions/system-chat.md` (binding), `docs/design/chat-agent-cards/DECISION.md` (visuals), `docs/new-design-port-status.md` §2, design markup `docs/design/quiet-chat/index.html` (`#assistant-row`, `.team-card` template) and `style.css` (already ported into `public/quiet.css`).

## Global Constraints

- Trunk-based on `main`, no branches or worktrees for this work; commit per task; never push.
- No code comments except one line for a trap no refactor can express; no emoji anywhere; flat inputs (no inset/neumorphic fields); Neumorphism only on cards, dialogs, buttons.
- The chat never runs in `~`; Chat home must be under `$HOME` (`validateWorkspaceCwd(path, home)` already enforces the `$HOME` bound).
- Only resumable engines can run a chat: built-in `claude`/`glm`/`codex` (`engineSupportsResume`), and connections whose adapter resumes (`resumeSupported`).
- Never touch port 7777; verify on a throwaway `MISSION_CONTROL_PORT=7781 MISSION_CONTROL_CONFIG_DIR=<scratch> bun server/index.ts`.
- Existing behaviour of `/api/jobs` for non-chat jobs (mc-dispatch, Studio, plans) must not change; every new field is optional.
- Test style: `bun:test`, `mkdtemp` config dir + `MISSION_CONTROL_CONFIG_DIR`, echo resolvers, as in `test/jobs-routes.test.ts`.

## Review Focus

1. A chat's agent settles while the chat turn that spawned it is still running → the report must wait, not be lost (Task 4 queues it and posts when the chain is idle).
2. The chat spawns the same step a 4th time → 409 from the server, not an endless retry loop (Task 3 caps retries at 3 per step per chat).
3. A user reply is sent while the chat is mid-turn → the client disables send while `running` and shows why (Task 5).
4. Chat home resolves to `~` or nothing (fresh install) → the first send asks where projects live instead of running in `~` (Tasks 1, 5).
5. A chat-spawned job carrying `chatId` is deleted/archived or its chat root is gone → the report poster skips silently (Task 4).

---

### Task 1: Chat home `[agent]`

**Files:**
- Create: `server/chat-home.ts`
- Modify: `server/secrets.ts` (`AppConfig.chatHome`), `server/routes/meta.ts` → no; create `server/routes/chat.ts` and mount it in `server/index.ts` next to `.use(jobsRoutes(...))`
- Test: `test/chat-home.test.ts`, `test/chat-routes.test.ts`

**Interfaces:**
- Produces: `sharedRoot(paths: readonly string[]): string | null` (deepest common ancestor of absolute paths, `null` for an empty list); `chatHome(config: { chatHome: string | null }, known: readonly string[], home: string): ChatHomeStatus` where `type ChatHomeStatus = { ok: true; path: string; source: 'config' | 'derived' } | { ok: false; reason: 'home' | 'none'; candidates: string[] }`; routes `GET /api/chat/home` → `ChatHomeStatus`, `PUT /api/chat/home { path }` → `{ ok: true, path }` or 400.
- Consumes: `readConfig`/`writeConfig` (`server/secrets.ts`), `validateWorkspaceCwd` (`server/workspace.ts`), `manager.listJobs()` cwds and `terminals.list()` cwds as the known paths.

- [ ] **Step 1: Write the failing tests**

```ts
// test/chat-home.test.ts
import { describe, expect, test } from 'bun:test'
import { chatHome, sharedRoot } from '../server/chat-home'

describe('sharedRoot', () => {
  test('deepest folder shared by every path', () => {
    expect(sharedRoot(['/Users/me/work/a', '/Users/me/work/b/c'])).toBe('/Users/me/work')
    expect(sharedRoot(['/Users/me/work/a'])).toBe('/Users/me/work/a')
    expect(sharedRoot(['/Users/me/work', '/Users/me/other'])).toBe('/Users/me')
    expect(sharedRoot([])).toBeNull()
  })
  test('ignores relative and empty entries', () => {
    expect(sharedRoot(['/Users/me/work/a', 'relative', ''])).toBe('/Users/me/work/a')
  })
})

describe('chatHome', () => {
  const home = '/Users/me'
  test('a configured home wins', () => {
    expect(chatHome({ chatHome: '/Users/me/code' }, ['/Users/me/x'], home)).toEqual({ ok: true, path: '/Users/me/code', source: 'config' })
  })
  test('derives the shared folder of known projects', () => {
    expect(chatHome({ chatHome: null }, ['/Users/me/work/a', '/Users/me/work/b'], home)).toEqual({ ok: true, path: '/Users/me/work', source: 'derived' })
  })
  test('never answers ~: asks with the known folders as candidates', () => {
    expect(chatHome({ chatHome: null }, ['/Users/me/work', '/Users/me/other'], home)).toEqual({ ok: false, reason: 'home', candidates: ['/Users/me/work', '/Users/me/other'] })
    expect(chatHome({ chatHome: null }, [], home)).toEqual({ ok: false, reason: 'none', candidates: [] })
  })
  test('a configured home outside $HOME is ignored', () => {
    expect(chatHome({ chatHome: '/tmp/elsewhere' }, [], home)).toEqual({ ok: false, reason: 'none', candidates: [] })
  })
})
```

```ts
// test/chat-routes.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { chatRoutes } from '../server/routes/chat'
import { readConfig } from '../server/secrets'

let configDir: string
let project: string
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-chat-routes-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  project = await mkdtemp(join(homedir(), 'mc-chat-home-'))
})
afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const app = (known: string[]) => new Elysia().use(chatRoutes({ knownDirectories: () => known }))
const local = (init: RequestInit = {}) => ({ headers: { host: '127.0.0.1:7777', ...(init.headers ?? {}) }, ...init })

describe('chat home routes', () => {
  test('GET reports a derived home and PUT stores one', async () => {
    const first = await app([join(project, 'a'), join(project, 'b')]).handle(new Request('http://127.0.0.1:7777/api/chat/home', local()))
    expect(await first.json()).toEqual({ ok: true, path: project, source: 'derived' })
    const put = await app([]).handle(new Request('http://127.0.0.1:7777/api/chat/home', local({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: project }) })))
    expect(put.status).toBe(200)
    expect((await readConfig()).chatHome).toBe(project)
  })
  test('PUT rejects ~, a missing folder and a folder outside $HOME', async () => {
    for (const path of [homedir(), join(project, 'missing'), tmpdir()]) {
      const response = await app([]).handle(new Request('http://127.0.0.1:7777/api/chat/home', local({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })))
      expect(response.status).toBe(400)
    }
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/chat-home.test.ts test/chat-routes.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// server/chat-home.ts
import { resolve, sep } from 'node:path'

export type ChatHomeStatus =
  | { ok: true; path: string; source: 'config' | 'derived' }
  | { ok: false; reason: 'home' | 'none'; candidates: string[] }

export function sharedRoot(paths: readonly string[]): string | null {
  const absolute = paths.filter(path => path.startsWith('/')).map(path => resolve(path).split(sep).filter(Boolean))
  if (absolute.length === 0) return null
  const shared: string[] = []
  for (let index = 0; index < absolute[0]!.length; index += 1) {
    const part = absolute[0]![index]
    if (!absolute.every(parts => parts[index] === part)) break
    shared.push(part!)
  }
  return `/${shared.join('/')}`
}

function underHome(path: string, home: string): boolean {
  const normalized = resolve(path)
  return normalized !== resolve(home) && normalized.startsWith(`${resolve(home)}/`)
}

export function chatHome(config: { chatHome: string | null }, known: readonly string[], home: string): ChatHomeStatus {
  if (config.chatHome !== null && underHome(config.chatHome, home)) return { ok: true, path: resolve(config.chatHome), source: 'config' }
  const candidates = [...new Set(known.filter(path => underHome(path, home)))]
  if (candidates.length === 0) return { ok: false, reason: 'none', candidates: [] }
  const derived = sharedRoot(candidates)
  if (derived === null || !underHome(derived, home)) return { ok: false, reason: 'home', candidates }
  return { ok: true, path: derived, source: 'derived' }
}
```

`server/secrets.ts`: add `chatHome: string | null` to `AppConfig`; in `readConfig` return `chatHome: typeof raw.chatHome === 'string' && raw.chatHome !== '' ? raw.chatHome : null`.

```ts
// server/routes/chat.ts
import { Elysia } from 'elysia'
import { homedir } from 'node:os'
import { requireLocal } from '../auth'
import { chatHome } from '../chat-home'
import { readConfig, writeConfig } from '../secrets'
import { validateWorkspaceCwd } from '../workspace'

export type ChatDeps = { knownDirectories: () => string[]; home?: string }

export function chatRoutes(deps: ChatDeps): Elysia {
  const home = deps.home ?? homedir()
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/chat/home', async () => chatHome(await readConfig(), deps.knownDirectories(), home))
    .put('/api/chat/home', async ({ body, set }) => {
      const path = typeof (body as { path?: unknown } | null)?.path === 'string' ? (body as { path: string }).path.trim() : ''
      const check = await validateWorkspaceCwd(path, home)
      if (!check.ok) { set.status = 400; return { error: check.error } }
      if (check.path === home) { set.status = 400; return { error: 'Chat home cannot be your home folder' } }
      await writeConfig({ chatHome: check.path })
      return { ok: true, path: check.path }
    })
}
```

`server/index.ts`: `.use(chatRoutes({ knownDirectories: () => [...jobManager.listJobs().map(job => job.baseRepo ?? job.cwd), ...terminalRegistry.list().map(session => session.cwd)] }))` — read `terminalRegistry`'s list method name in `server/terminals.ts` before writing this line and use the real one.

- [ ] **Step 4: Run the tests**

Run: `bun test test/chat-home.test.ts test/chat-routes.test.ts test/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/chat-home.ts server/routes/chat.ts server/secrets.ts server/index.ts test/chat-home.test.ts test/chat-routes.test.ts
git commit -m "feat(chat): chat home derived from known projects, never ~, settable through the API"
```

---

### Task 2: Chat rules and the chat engine profile `[agent]`

**Files:**
- Create: `server/chat-profile.ts`
- Modify: `server/jobs-engine-iface.ts` (`EngineResolverParams.purpose`, `edit`), `server/engines.ts` (`buildEnv` worker flag stays; add `chat` option), `server/worker-profile.ts` (export `ensureProfileDir` helper if needed)
- Test: `test/chat-profile.test.ts`, extend `test/threads.test.ts` `engineArgs` cases or `test/jobs-engine-iface.test.ts` if it exists (check first)

**Interfaces:**
- Produces: `CHAT_RULES: string` (the appended system prompt), `chatRules(context: { chatId: string; home: string; project: string | null; edit: boolean; memory: string }): string`, `ensureChatProfile(opts?: { configDir?: string }): Promise<{ claude: string }>` (a `chat-claude` dir with `CLAUDE.md` = `CHAT_RULES` and `settings.json` = bypass permissions), `chatEnv(engine: EngineName, dirs: { claude: string; codex: string }): Record<string, string>` (`glm` → `CLAUDE_CONFIG_DIR: chat-claude`; `codex` → `CODEX_HOME: worker-codex`; `claude` → `{}`).
- Resolver: `EngineResolverParams` gains `purpose?: 'workflow-design' | 'chat'` and `edit?: boolean`. For `purpose === 'chat'`: `coreRules` is set by the caller (Task 3) to `chatRules(...)`; env = `buildEnv(name, { worker: false })` merged with `chatEnv`; when `edit === false` and the engine is claude/glm append `--disallowedTools`, `Edit,Write,MultiEdit,NotebookEdit`; codex ignores `edit` (its sandbox cannot allow curl while blocking writes — record in the rules text that direct edits are unavailable on Codex).

- [ ] **Step 1: Write the failing tests**

```ts
// test/chat-profile.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_RULES, chatEnv, chatRules, ensureChatProfile } from '../server/chat-profile'
import { engineArgs, realEngineResolver } from '../server/jobs-engine-iface'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-chat-profile-')); process.env.MISSION_CONTROL_CONFIG_DIR = dir; process.env.MC_FAKE_ENGINES = '1' })
afterEach(async () => { delete process.env.MISSION_CONTROL_CONFIG_DIR; delete process.env.MC_FAKE_ENGINES; await rm(dir, { recursive: true, force: true }) })

describe('chat rules', () => {
  test('name the API, the retry cap, the review rule and the landing call', () => {
    for (const phrase of ['POST $MC_URL/api/jobs', 'MC_CHAT_ID', 'different AI family', 'up to 3 times', '/land', 'never push', '/api/quota']) expect(CHAT_RULES).toContain(phrase)
  })
  test('carry the chat context', () => {
    const text = chatRules({ chatId: 'root-1', home: '/Users/me/work', project: '/Users/me/work/app', edit: false, memory: 'Recent: fixed login' })
    expect(text).toContain('root-1')
    expect(text).toContain('/Users/me/work/app')
    expect(text).toContain('read-only')
    expect(text).toContain('Recent: fixed login')
    expect(chatRules({ chatId: 'r', home: '/h', project: null, edit: true, memory: '' })).toContain('may edit files directly')
  })
})

describe('chat profile', () => {
  test('writes a slim Claude profile and maps engines to it', async () => {
    const dirs = await ensureChatProfile({ configDir: dir })
    expect(await readFile(join(dirs.claude, 'CLAUDE.md'), 'utf8')).toBe(CHAT_RULES)
    expect(JSON.parse(await readFile(join(dirs.claude, 'settings.json'), 'utf8')).permissions.defaultMode).toBe('bypassPermissions')
    expect(chatEnv('glm', { claude: dirs.claude, codex: '/codex' })).toEqual({ CLAUDE_CONFIG_DIR: dirs.claude })
    expect(chatEnv('codex', { claude: dirs.claude, codex: '/codex' })).toEqual({ CODEX_HOME: '/codex' })
    expect(chatEnv('claude', { claude: dirs.claude, codex: '/codex' })).toEqual({})
  })
})

describe('resolver for a chat', () => {
  test('appends the rules, blocks edit tools when edit is off, and skips the worker profile', async () => {
    const spawn = await realEngineResolver({ engine: 'claude', prompt: 'hi', purpose: 'chat', edit: false, coreRules: 'RULES' })
    expect(spawn.args).toContain('--append-system-prompt')
    expect(spawn.args[spawn.args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,MultiEdit,NotebookEdit')
    expect(spawn.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    const editing = await realEngineResolver({ engine: 'glm', prompt: 'hi', purpose: 'chat', edit: true, coreRules: 'RULES' })
    expect(editing.args).not.toContain('--disallowedTools')
    expect(editing.env.CLAUDE_CONFIG_DIR).toContain('chat-claude')
  })
  test('a worker job is unchanged', () => {
    expect(engineArgs('claude', 'p')).toEqual(['-p', 'p', '--output-format', 'stream-json', '--verbose'])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/chat-profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/chat-profile.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineName } from './engines'
import { configDir } from './secrets'
import { WORKER_CLAUDE_SETTINGS } from './worker-profile'

export const CHAT_RULES = `# Mission Control chat
You are the system chat of Mission Control, talking with its owner. Answer directly, like a colleague. No plan step unless asked.

## What you may do without asking
Read and search files, answer, spawn agents, reply to and stop your own agents, retry a failed agent up to 3 times (each time on a different AI), land reviewed work.
## What always needs the owner's click
Pushing, deploying, anything touching production, deleting outside a worktree. Never push.

## Agents (Mission Control jobs)
The cockpit API is at $MC_URL; every call sends "Authorization: Bearer $MC_TOKEN". Your chat id is $MC_CHAT_ID; the current turn's job id is $MC_JOB_ID. Use curl through Bash. Never print the token.
- Spawn: POST $MC_URL/api/jobs with JSON {"engine","model","cwd","prompt","label","worktree":true,"chat":"$MC_CHAT_ID","chatTurn":"$MC_JOB_ID","reason":"<one line: why this AI>"}. label is the step name (short). cwd is the project folder. prompt is the whole spec: files, exact steps, acceptance criteria.
- Pick engines yourself: GET $MC_URL/api/providers lists them with one-line strengths; GET $MC_URL/api/quota shows usage — avoid a provider near its 5-hour or weekly limit. State the reason in every spawn.
- Fixed rule: any code change is reviewed by a different AI family before it lands. Spawn the review as a job with "reviewOf":"<job id>" on another family. Naming a Studio workflow makes you follow it instead.
- Agents report back to you automatically as chat turns that start with "[agent". Read them; then review, land, retry, or relay.
- Land: when the review passes, POST $MC_URL/api/jobs/<id>/land. Then tell the owner what landed.
- Stop: POST $MC_URL/api/jobs/<id>/kill. Reply to an agent: POST $MC_URL/api/jobs/<id>/reply {"message"}.
- Retry cap: 3 attempts per step; the server refuses a 4th. After that, tell the owner what blocks and wait.
- Relay every agent question, blocker or final failure to the owner in plain words.

## Project
You run in Chat home and never leave it. Work out which project a message is about from the folders under Chat home; when unsure, ask. When you know, tell the cockpit once: PATCH $MC_URL/api/jobs/$MC_CHAT_ID {"project":"<absolute path>"}. Spawned agents run in that project with "worktree":true.

## Titles
After your fifth reply, if the owner has not renamed the chat, PATCH $MC_URL/api/jobs/$MC_CHAT_ID {"label":"<a 3-6 word title>"} once.

## Style
Markdown: paragraphs, headings, lists, code fences, inline code, bold, italics only. No emoji. No tables.`

export function chatRules(context: { chatId: string; home: string; project: string | null; edit: boolean; memory: string }): string {
  const edit = context.edit
    ? `You may edit files directly, only inside ${context.project ?? 'the chosen project'}; never elsewhere in Chat home. Say what you changed.`
    : 'You are read-only for direct edits: every code change goes through an agent.'
  const project = context.project ? `Project for this chat: ${context.project}.` : 'Project: not chosen yet.'
  const memory = context.memory ? `\n## Recent work in this project\n${context.memory}` : ''
  return `${CHAT_RULES}\n\n## This chat\nChat id ${context.chatId}. Chat home: ${context.home}. ${project}\n${edit}${memory}`
}

export function chatProfileDirs(configDirOverride?: string): { claude: string } {
  return { claude: join(configDirOverride ?? configDir(), 'chat-claude') }
}

export async function ensureChatProfile(opts: { configDir?: string } = {}): Promise<{ claude: string }> {
  const dirs = chatProfileDirs(opts.configDir)
  try {
    await mkdir(dirs.claude, { recursive: true, mode: 0o700 })
    await writeFile(join(dirs.claude, 'CLAUDE.md'), CHAT_RULES)
    await writeFile(join(dirs.claude, 'settings.json'), `${JSON.stringify(WORKER_CLAUDE_SETTINGS, null, 2)}\n`)
  } catch (error) {
    console.error('chat profile: setup failed -', error)
  }
  return dirs
}

export function chatEnv(engine: EngineName, dirs: { claude: string; codex: string }): Record<string, string> {
  if (engine === 'glm') return { CLAUDE_CONFIG_DIR: dirs.claude }
  if (engine === 'codex') return { CODEX_HOME: dirs.codex }
  return {}
}
```

`server/jobs-engine-iface.ts` — extend `EngineResolverParams` with `purpose?: 'workflow-design' | 'chat'` and `edit?: boolean`; in `realEngineResolver` after computing `args` for a built-in engine:

```ts
  if (purpose === 'chat' && edit === false && name !== 'codex') args.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit')
  ...
  const env = purpose === 'chat'
    ? { ...(await buildEnv(name, { worker: false })), ...chatEnv(name, { claude: (await ensureChatProfile()).claude, codex: (await ensureWorkerProfiles()).codex }) }
    : await buildEnv(name, { worker: !readOnly })
  return { cmd: resolveBinary(resolveEngine(name).cmd), args, env }
```

Keep the `coreRules` unshift as is (it carries the rules for all three engines). For the ACP/agent-bridge path pass `purpose` and `edit` through in the stdin JSON so a future adapter can honour them; the bridge ignores unknown keys today (check `server/agent-bridge.ts` parses with a permissive schema before relying on this; if it is strict, add the two optional fields to its schema).

- [ ] **Step 4: Run the tests**

Run: `bun test test/chat-profile.test.ts test/threads.test.ts test/worker-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/chat-profile.ts server/jobs-engine-iface.ts test/chat-profile.test.ts
git commit -m "feat(chat): chat rules as an appended system prompt, slim chat profile, direct-edit toggle"
```

---

### Task 3: Chat jobs in the job manager and routes `[agent]`

**Files:**
- Modify: `server/jobs.ts` (`JobRecord`, `CreateJobParams`, `createJob`, add `updateJob`), `server/routes/jobs.ts` (`POST /api/jobs`, `GET /api/jobs?chat=`, `PATCH /api/jobs/:id`, reply route passes chat context)
- Test: `test/jobs-routes.test.ts` (new `describe('chat jobs')`), `test/jobs.test.ts` if it exists (check) for `updateJob`

**Interfaces:**
- `JobRecord` gains optional `chatId?: string` (root id of the chat that spawned this job), `chatTurn?: string` (the chat turn job id that spawned it), `reason?: string`, `project?: string | null` (chat roots only), `titleLocked?: boolean` (chat roots only), `source?: 'user' | 'agent'` (chat turns: who wrote the prompt), `edit?: boolean` (chat roots only). `purpose` union becomes `'workflow-design' | 'chat'`.
- `CreateJobParams` gains the same optional fields plus `purpose: 'chat'` support; `createJob` sets env `MC_URL`, `MC_TOKEN` (`readApiToken()`), `MC_CHAT_ID` (thread root) on chat jobs, and passes `purpose`, `edit` and `coreRules: chatRules(...)` to the resolver (memory text from Task 4's `projectMemory`; until Task 4 lands pass `''`).
- `manager.updateJob(id, patch: Partial<Pick<JobRecord, 'label' | 'project' | 'titleLocked'>>): JobRecord | undefined` persists a new line.
- Routes: `POST /api/jobs` accepts `purpose: 'chat'` (skips spec lint; requires a resumable engine; `label` defaults to the first line of the prompt trimmed to 60 chars), `chat`, `chatTurn`, `reason`, `edit`, `project`; `GET /api/jobs?chat=<rootId>` returns only jobs whose `chatId === rootId` or `threadRoot === rootId`; `PATCH /api/jobs/:id` body `{ label?, project?, titleLocked? }` — only for `purpose === 'chat'` roots, 404 otherwise; a `label` sent by the chat (no `titleLocked` in the body) is ignored when `titleLocked` is already true; `project` must pass `validateWorkspaceCwd` and be under Chat home. Retry cap: a spawn with `chat` + `label` when 3 jobs with the same `chatId` + `label` already exist (excluding `reviewOf` jobs) → 409 `{ error: 'retry cap reached for this step' }`.
- Reply route: for a chat root, the new turn inherits `purpose: 'chat'`, `edit`, `source: body.source === 'agent' ? 'agent' : 'user'` (only local/bearer callers reach it), and the env/rules as the root.

- [ ] **Step 1: Write the failing tests** (append to `test/jobs-routes.test.ts`)

```ts
describe('chat jobs', () => {
  const chatBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ engine: 'claude', cwd: repo, prompt: 'Fix the login bug\nmore', purpose: 'chat', ...extra })
  const post = (app: Elysia, body: string) => app.handle(new Request('http://127.0.0.1:7777/api/jobs', { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body }))

  test('a chat root takes its title from the first line and carries the chat env', async () => {
    const seen: EngineResolverParams[] = []
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, (params) => { seen.push(params); return { cmd: 'echo', args: [params.prompt], env: {} } })
    const response = await post(app, chatBody({ edit: true }))
    expect(response.status).toBe(200)
    const job = await response.json()
    expect(job.purpose).toBe('chat')
    expect(job.label).toBe('Fix the login bug')
    expect(job.edit).toBe(true)
    expect(seen[0]?.purpose).toBe('chat')
    expect(seen[0]?.edit).toBe(true)
    expect(seen[0]?.coreRules).toContain('Mission Control chat')
  })

  test('a chat needs a resumable engine and skips the spec lint', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    expect((await post(app, chatBody({ engine: 'glm' }))).status).toBe(200)
    expect((await post(app, chatBody({ engine: 'unknown-connection' }))).status).toBe(400)
  })

  test('spawned jobs carry chatId/chatTurn/reason and are listed by ?chat=', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const spawned = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan(), label: 'Build it', chat: root.id, chatTurn: root.id, reason: 'Codex · many small edits' }))).json()
    expect(spawned.chatId).toBe(root.id)
    expect(spawned.chatTurn).toBe(root.id)
    expect(spawned.reason).toBe('Codex · many small edits')
    const listed = await (await app.handle(new Request(`http://127.0.0.1:7777/api/jobs?chat=${root.id}`, { headers: { host: '127.0.0.1:7777' } }))).json()
    expect(listed.jobs.map((job: { id: string }) => job.id).sort()).toEqual([root.id, spawned.id].sort())
  })

  test('the fourth attempt at a step is refused', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const step = () => post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan(), label: 'Build it', chat: root.id, chatTurn: root.id }))
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await step()).status).toBe(200)
    const fourth = await step()
    expect(fourth.status).toBe(409)
    expect((await fourth.json()).error).toContain('retry cap')
  })

  test('PATCH renames a chat, sets its project, and a locked title stays', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    const patch = (body: Record<string, unknown>) => app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await (await patch({ project: repo })).json()).project).toBe(repo)
    expect((await (await patch({ label: 'Login fix', titleLocked: true })).json()).label).toBe('Login fix')
    expect((await (await patch({ label: 'Auto title' })).json()).label).toBe('Login fix')
    expect((await patch({ project: '/tmp' })).status).toBe(400)
    const worker = await (await post(app, JSON.stringify({ engine: 'codex', cwd: repo, prompt: executionPlan(), label: 'x' }))).json()
    expect((await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${worker.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: '{"label":"y"}' }))).status).toBe(404)
  })

  test('a reply to a chat is a chat turn with a source', async () => {
    const manager = createJobManager({ home: homedir() })
    const app = buildApp(manager, echoResolver)
    const root = await (await post(app, chatBody())).json()
    await new Promise(resolve => setTimeout(resolve, 200))
    // echo prints no session id; set one the way the stream parser would
    ;(manager as unknown as { setSessionIdForTest?: (id: string, session: string) => void }).setSessionIdForTest?.(root.id, 'sess-1')
    const reply = await app.handle(new Request(`http://127.0.0.1:7777/api/jobs/${root.id}/reply`, { method: 'POST', headers: { host: '127.0.0.1:7777', 'content-type': 'application/json' }, body: JSON.stringify({ message: '[agent Build it] done', source: 'agent' }) }))
    expect(reply.status).toBe(200)
    const turn = await reply.json()
    expect(turn.purpose).toBe('chat')
    expect(turn.source).toBe('agent')
  })
})
```

If `setSessionIdForTest` does not exist, look at how `test/jobs-routes.test.ts` already tests the reply route (search for `sessionId` there) and reuse that mechanism instead of inventing a test hook.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/jobs-routes.test.ts -t 'chat jobs'`
Expected: FAIL on `purpose`, `label`, 409, PATCH 404.

- [ ] **Step 3: Implement**

`server/jobs.ts`:
- Types: add the fields listed in Interfaces to `JobRecord` and `CreateJobParams`; `purpose?: 'workflow-design' | 'chat'` on both.
- In `createJob`, before the resolver call:

```ts
    const isChat = params.purpose === 'chat'
    const chatRoot = isChat ? params.threadRoot ?? null : null
    const rootRecord = chatRoot ? jobs.get(chatRoot) : undefined
    const chatContext = isChat ? {
      purpose: 'chat' as const,
      edit: params.edit ?? rootRecord?.edit ?? false,
      coreRules: chatRules({ chatId: chatRoot ?? 'pending', home: cwdCheck.path, project: params.project ?? rootRecord?.project ?? null, edit: params.edit ?? rootRecord?.edit ?? false, memory: params.memory ?? '' }),
    } : {}
```

  `chatId` for the resolver is unknown before the id exists: generate `const id = crypto.randomUUID()` BEFORE the resolver call (move the existing line up) and use `params.threadRoot ?? id` as the chat id in `chatRules`.
- Resolver call gains `...chatContext`.
- Spawn env: `env: { ...process.env, ...spawnSpec.env, MC_JOB_ID: id, ...(isChat ? { MC_URL: mcUrl, MC_TOKEN: await readApiToken(), MC_CHAT_ID: params.threadRoot ?? id, MISSION_CONTROL_CONFIG_DIR: configDir() } : {}) }` where `mcUrl = `http://127.0.0.1:${listenTarget().port}`` (import `listenTarget` from `./secrets`).
- Record: spread `chatId`, `chatTurn`, `reason`, `source`, `edit`, `project: null`, `titleLocked: false` for chat roots (`isChat && !params.threadRoot`), and `purpose`.
- Retry cap in `createJob` before spawning: `if (params.chatId && !params.reviewOf && [...jobs.values()].filter(job => job.chatId === params.chatId && job.label === params.label && !job.reviewOf).length >= 3) return { ok: false, status: 409, error: 'retry cap reached for this step' }`.
- `updateJob(id, patch)`: `const record = jobs.get(id); if (!record) return undefined; const next = { ...record, ...patch }; await persist(next); return next` — add to `JobManager` type and the returned object. `persist` already replaces the map entry and appends a line; `loadJobs` keeps the last line per id (verify by reading `loadJobs`).

`server/routes/jobs.ts`:
- `POST /api/jobs`: accept `purpose === 'chat'` — then `label` may be missing (derive `firstLine(prompt).slice(0, 60)`), skip the spec-lint branch, require `engineSupportsResume(engine)` or a connection with `resumeSupported` (400 `'chat needs an AI that can resume a conversation'`), pass `purpose`, `edit: payload.edit === true`, `project` (validated via `validateWorkspaceCwd` when given). For any job accept `chat` (string, must be an existing chat root → else 400), `chatTurn`, `reason` (≤ 200 chars) and forward as `chatId`, `chatTurn`, `reason`.
- `GET /api/jobs`: read `query.chat`; when set, filter `job.chatId === chat || job.threadRoot === chat`.
- `PATCH /api/jobs/:id`: as specified in Interfaces; project validation uses `validateWorkspaceCwd(path, homedir())` and `chatHome(await readConfig(), [], homedir())` must be `ok` and the path must start with `${home.path}/` or equal it.
- Reply route: when `parent.purpose === 'chat'`, include `purpose: 'chat'`, `threadRoot: rootId`, `source`, `edit: root.edit`, `project: root.project` (read the root record via `manager.getJob(rootId)`), and drop the `workflow-design` 409 only for `workflow-design` (unchanged).

- [ ] **Step 4: Run the tests**

Run: `bun test test/jobs-routes.test.ts test/threads.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Commit**

```bash
git add server/jobs.ts server/routes/jobs.ts test/jobs-routes.test.ts
git commit -m "feat(chat): chat jobs — purpose chat, spawned-agent links, retry cap, PATCH title and project"
```

---

### Task 4: Agent reports, landing notifications and project memory `[agent]`

**Files:**
- Create: `server/chat-reports.ts`
- Modify: `server/index.ts` (`onJobSettled` hook), `server/notify.ts` (`notifyChat`), `server/routes/jobs.ts` (`/land` on a chat-spawned job notifies), `server/jobs.ts` (`memory` param feeds `chatRules`)
- Test: `test/chat-reports.test.ts`, `test/notify.test.ts` (one case)

**Interfaces:**
- `agentReport(job: JobRecord, log: string): { message: string; needsYou: boolean }` — pure. `message` starts with `[agent <label> · <engine>]`, then `done`/`failed (exit N)`, then the last assistant text of the log (`parseThread` → last `text` event, ≤ 1200 chars, via `oneLine` for the label line only), then the diff stat when present. `needsYou` is true when the job failed, or the last text ends with `?`, or `reportedJobOutcome(log) === 'failed'`.
- `projectMemory(jobs: readonly JobRecord[], project: string, exceptRoot: string, readLog: (id: string) => Promise<string>): Promise<string>` — up to 8 most recent chat roots with the same `project` (excluding `exceptRoot`), each as `- <label> (<relative day>): <last assistant text, one line, ≤ 160 chars>`; plus up to 8 most recent non-chat jobs in that project as `- agent <label> (<status>)`.
- `createReportPoster(manager, resolver, opts: { notify?: (title: string, body: string) => Promise<void> }): (record: JobRecord) => Promise<void>` — on a settled job with `chatId`: if the chat root is missing or not `purpose: 'chat'`, return; if `threadIsRunning(threadChain(manager.listJobs(), chatId))`, queue the report and retry every 3 s (bounded, 20 minutes) until the chain is idle; then `manager.createJob({ engine: root.engine, cwd: root.cwd, prompt: report.message, label: root.label, parentJobId: last turn id, threadRoot: chatId, resumeSessionId: replySessionId(chain), purpose: 'chat', source: 'agent', edit: root.edit, project: root.project, memory })`; when `needsYou`, call `notify('Needs you', `<chat label> · <agent label>`)`.
- `notifyChat(title: string, body: string, options?)` in `server/notify.ts` (same osascript shape as `notifySlowJob`, macOS only).
- `/land` success on a job with `chatId` → `notifyChat('Landed', `<label> · <n> commits`)`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/chat-reports.test.ts
import { describe, expect, test } from 'bun:test'
import type { JobRecord } from '../server/jobs'
import { agentReport, projectMemory } from '../server/chat-reports'

const base: JobRecord = { id: 'j1', engine: 'codex', cwd: '/p', worktree: null, baseRepo: null, baseBranch: null, label: 'Build it', prompt: 'x', pid: 1, status: 'done', startedAt: 1, turns: 3, slowAt: null, lastTool: null, endedAt: 2, exitCode: 0, diffStat: ' 2 files changed', reviewedAt: null, sessionId: null, parentJobId: null, threadRoot: 'j1', terminalId: null, reviewOf: null, model: null, chatId: 'root' }
const textEvent = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('agentReport', () => {
  test('a finished agent reports done with its last words and the diff', () => {
    const report = agentReport(base, `${textEvent('All tests pass.')}\n`)
    expect(report.message.startsWith('[agent Build it · codex] done')).toBe(true)
    expect(report.message).toContain('All tests pass.')
    expect(report.message).toContain('2 files changed')
    expect(report.needsYou).toBe(false)
  })
  test('a failure or a question needs you', () => {
    expect(agentReport({ ...base, status: 'failed', exitCode: 1 }, '').needsYou).toBe(true)
    expect(agentReport(base, `${textEvent('Which branch should I use?')}\n`).needsYou).toBe(true)
  })
})

describe('projectMemory', () => {
  test('lists recent chats and agents of the same project, not this chat', async () => {
    const chats: JobRecord[] = [
      { ...base, id: 'c1', purpose: 'chat', project: '/p', label: 'Login fix', threadRoot: 'c1', chatId: undefined, startedAt: 10 },
      { ...base, id: 'c2', purpose: 'chat', project: '/p', label: 'This chat', threadRoot: 'c2', chatId: undefined, startedAt: 20 },
      { ...base, id: 'c3', purpose: 'chat', project: '/other', label: 'Other', threadRoot: 'c3', chatId: undefined, startedAt: 30 },
      { ...base, id: 'a1', label: 'Build it', status: 'done', startedAt: 15, cwd: '/p', chatId: 'c1' },
    ]
    const memory = await projectMemory(chats, '/p', 'c2', async () => `${textEvent('Fixed the redirect loop.')}\n`)
    expect(memory).toContain('Login fix')
    expect(memory).toContain('Fixed the redirect loop.')
    expect(memory).toContain('agent Build it (done)')
    expect(memory).not.toContain('This chat')
    expect(memory).not.toContain('Other')
  })
})
```

Add to `test/notify.test.ts` (match its existing spawn-stub style): `notifyChat('Needs you', 'Login fix · Build it', { platform: 'darwin', spawn })` calls osascript with a message containing both strings; on `linux` it does not spawn.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/chat-reports.test.ts test/notify.test.ts`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement**

```ts
// server/chat-reports.ts
import { parseThread, reportedJobOutcome, oneLine } from './activity'
import type { JobManager, JobRecord } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import { replySessionId, threadChain, threadIsRunning } from './threads'

const REPORT_TEXT_MAX = 1200
const MEMORY_ITEMS = 8
const RETRY_MS = 3_000
const RETRY_LIMIT = 400

function lastText(log: string): string {
  const events = parseThread(log).filter(event => event.kind === 'text')
  return events[events.length - 1]?.text.trim() ?? ''
}

export function agentReport(job: JobRecord, log: string): { message: string; needsYou: boolean } {
  const text = lastText(log)
  const failed = job.status === 'failed' || reportedJobOutcome(log) === 'failed'
  const head = `[agent ${job.label} · ${job.engine}] ${failed ? `failed${job.exitCode !== null && job.exitCode !== 0 ? ` (exit ${job.exitCode})` : ''}` : 'done'}`
  const body = text.length > REPORT_TEXT_MAX ? `${text.slice(0, REPORT_TEXT_MAX - 1)}…` : text
  const diff = job.diffStat ? `\nDiff:${job.diffStat}` : ''
  return { message: `${head}\n${body}${diff}`.trim(), needsYou: failed || text.endsWith('?') }
}

function relativeDay(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

export async function projectMemory(jobs: readonly JobRecord[], project: string, exceptRoot: string, readLog: (id: string) => Promise<string>): Promise<string> {
  const roots = jobs.filter(job => job.purpose === 'chat' && job.threadRoot === job.id && job.project === project && job.id !== exceptRoot).sort((a, b) => b.startedAt - a.startedAt).slice(0, MEMORY_ITEMS)
  const lines: string[] = []
  for (const root of roots) {
    const turns = jobs.filter(job => job.threadRoot === root.id).sort((a, b) => b.startedAt - a.startedAt)
    const last = turns[0] ?? root
    lines.push(`- ${root.label} (${relativeDay(root.startedAt)}): ${oneLine(lastText(await readLog(last.id)), 160)}`)
  }
  const agents = jobs.filter(job => job.purpose !== 'chat' && (job.baseRepo ?? job.cwd) === project && job.chatId !== exceptRoot).sort((a, b) => b.startedAt - a.startedAt).slice(0, MEMORY_ITEMS)
  for (const agent of agents) lines.push(`- agent ${agent.label} (${agent.status})`)
  return lines.join('\n')
}

export function createReportPoster(manager: JobManager, resolver: EngineResolver, opts: { notify?: (title: string, body: string) => Promise<void>; readLog: (id: string) => Promise<string> }): (record: JobRecord) => Promise<void> {
  const post = async (record: JobRecord, attempt: number): Promise<void> => {
    const chatId = record.chatId
    if (!chatId) return
    const root = manager.getJob(chatId)
    if (!root || root.purpose !== 'chat') return
    const chain = threadChain(manager.listJobs(), chatId)
    if (threadIsRunning(chain)) {
      if (attempt < RETRY_LIMIT) setTimeout(() => void post(record, attempt + 1), RETRY_MS)
      return
    }
    const sessionId = replySessionId(chain)
    if (sessionId === null) return
    const report = agentReport(record, await opts.readLog(record.id))
    const memory = root.project ? await projectMemory(manager.listJobs(), root.project, chatId, opts.readLog) : ''
    await manager.createJob({ engine: root.engine, cwd: root.cwd, prompt: report.message, label: root.label, parentJobId: chain[chain.length - 1]!.id, threadRoot: chatId, resumeSessionId: sessionId, purpose: 'chat', source: 'agent', edit: root.edit ?? false, project: root.project ?? undefined, memory, ...(root.model === null ? {} : { model: root.model }) }, resolver)
    if (report.needsYou) await opts.notify?.('Needs you', `${root.label} · ${record.label}`)
  }
  return (record) => post(record, 0)
}
```

`server/jobs.ts`: `CreateJobParams.memory?: string` and `project?: string` already flow into `chatRules` (Task 3). `server/index.ts` `onJobSettled`: after the existing branches, `if (record.chatId) void reportPoster(record).catch(() => {})` where `const reportPoster = createReportPoster(jobManager, realEngineResolver, { notify: notifyChat, readLog: id => readRedactedLog(jobManager.logPath(id)) })` (`readRedactedLog` lives in `server/routes/jobs.ts` — export it or move it to `server/transcripts.ts`; check where it is defined). Also skip `maybeAutoReview` for jobs with `chatId` (the chat orders its own review). `notifyChat` in `server/notify.ts` mirrors `notifySlowJob` with `title`/`body` params. `/land` route: after `result.ok`, `if (record.chatId) void notifyChat('Landed', `${record.label} · ${result.landed.length} commit${result.landed.length === 1 ? '' : 's'}`)`.

- [ ] **Step 4: Run the tests**

Run: `bun test test/chat-reports.test.ts test/notify.test.ts test/jobs-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/chat-reports.ts server/notify.ts server/index.ts server/routes/jobs.ts server/jobs.ts test/chat-reports.test.ts test/notify.test.ts
git commit -m "feat(chat): agents report back into the chat, needs-you and landed notifications, project memory"
```

---

### Task 5: The chat island `[here]`

**Files:**
- Create: `client/chat.ts` (island), `client/chat-view.ts` (pure: turn grouping, activity summary, team rows)
- Modify: `client/shell.ts` (remove the sample `responses`, templates, `showConversation`, the fake composer submit and `[data-chat]` handlers; keep screens, agents/flow toggles, history search), `server/views/shell.ts` (conversation section gets `#messages`; remove `#reply-*` templates; add `#chat-home` dialog; script tag `/js/chat.js`), `public/quiet.css` (activity line, needs-you state, edited card), `test/shell.test.ts` markers + island list, `tsconfig.shell.json`
- Test: `test/chat-view.test.ts`

**Interfaces:**
- `client/chat-view.ts`: `type Turn = { id: string; source: 'user' | 'agent'; prompt: string; text: string; tools: number; started: number; ended: number | null; running: boolean }`; `turnsFrom(thread: ThreadMessage[], jobs: JobRecordLike[]): Turn[]` (one per `kind: 'prompt'` message; `text` = concatenated assistant `text` messages of that job; `tools` = count of `kind: 'tool'`); `workedLine(turn: Turn, now: number): string` (`'Working · 12s'` while running, else `'Worked 18s · used 4 tools'`, `'Answered'` when tools = 0); `teamRows(jobs, turnId): TeamRow[]` (`{ id, engine, model, label, reason, state: 'running' | 'done' | 'failed' | 'landed' | 'reviewing' | 'needs-you', activity, elapsed }` — `landed` when `reviewedAt !== null` or `diffStat === null && status === 'done'`… use: `status === 'running'` → running; `status === 'failed'` → needs-you; `status === 'done'` and a `reviewOf` job pointing at it is running → reviewing; done otherwise; a done job whose review is done and which has been landed (`reviewedAt !== null`) → landed); `titleFrom(prompt)` (first line, 60 chars).
- `client/chat.ts`: reads `?chat=<root>` on load and after send; `send(text)` → if no root: `GET /api/chat/home` (ask via `#chat-home` dialog when `!ok`, PUT the answer) then `POST /api/jobs { engine, model, cwd: home, prompt, purpose: 'chat', edit, project }` with the composer's stored engine/model/edit/project (`mc.shell.*` keys from `shell-composer.ts`); else `POST /api/jobs/:root/reply { message }`. Polls `GET /api/jobs/:root/thread` and `GET /api/jobs?chat=<root>` every 2 s while running (5 s idle), renders rows in place (keyed by turn id), scrolls to the bottom on new content unless the user scrolled up. While the chain is running the send button is disabled with title `'Waiting for the reply'`. Team card per turn from `teamRows`; "Open in Agents" dispatches `quiet:activity-scope` with `{ chat: root }` and clicks `#open-agents`. Agent turns (`source: 'agent'`) render as a muted activity row (`[agent …] done` one line, expandable) instead of a user bubble. Edited-directly cards: a tool message whose `title` is `Edit`/`Write`/`MultiEdit` renders `<article class="edit-card">Edited directly · <code>path</code></article>` (path from `detail`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/chat-view.test.ts
import { describe, expect, test } from 'bun:test'
import { teamRows, titleFrom, turnsFrom, workedLine } from '../client/chat-view'

const thread = [
  { role: 'user', kind: 'prompt', jobId: 't1', ts: 1000, text: 'Fix login' },
  { role: 'assistant', kind: 'tool', jobId: 't1', title: 'Read', detail: 'a.ts', input: '', result: '', resultIsError: false },
  { role: 'assistant', kind: 'text', jobId: 't1', text: 'On it.' },
  { role: 'user', kind: 'prompt', jobId: 't2', ts: 5000, text: '[agent Build it · codex] done' },
  { role: 'assistant', kind: 'text', jobId: 't2', text: 'Landed.' },
]
const jobs = [
  { id: 't1', status: 'done', startedAt: 1000, endedAt: 19000, source: 'user' },
  { id: 't2', status: 'running', startedAt: 5000, endedAt: null, source: 'agent' },
]

describe('turnsFrom', () => {
  test('one turn per prompt with its text, tool count and source', () => {
    const turns = turnsFrom(thread as never, jobs as never)
    expect(turns.map(turn => [turn.id, turn.source, turn.tools, turn.text, turn.running])).toEqual([['t1', 'user', 1, 'On it.', false], ['t2', 'agent', 0, 'Landed.', true]])
  })
})

describe('workedLine', () => {
  test('working while running, worked with tool count after', () => {
    const [first, second] = turnsFrom(thread as never, jobs as never)
    expect(workedLine(first!, 20000)).toBe('Worked 18s · used 1 tool')
    expect(workedLine(second!, 17000)).toBe('Working · 12s')
    expect(workedLine({ ...first!, tools: 0 }, 20000)).toBe('Answered')
  })
})

describe('teamRows', () => {
  const agents = [
    { id: 'a', engine: 'codex', model: 'gpt-5.5', label: 'Build it', reason: 'many edits', status: 'done', startedAt: 1, endedAt: 2, chatTurn: 't1', reviewOf: null, reviewedAt: null, currentActivity: null, diffStat: ' 1 file' },
    { id: 'r', engine: 'claude', model: null, label: 'Review', reason: 'other family', status: 'running', startedAt: 3, endedAt: null, chatTurn: 't1', reviewOf: 'a', reviewedAt: null, currentActivity: 'Reading diff', diffStat: null },
    { id: 'f', engine: 'glm', model: null, label: 'Docs', reason: '', status: 'failed', startedAt: 3, endedAt: 4, chatTurn: 't1', reviewOf: null, reviewedAt: null, currentActivity: null, diffStat: null },
    { id: 'x', engine: 'glm', model: null, label: 'Elsewhere', reason: '', status: 'done', startedAt: 3, endedAt: 4, chatTurn: 't9', reviewOf: null, reviewedAt: null, currentActivity: null, diffStat: null },
  ]
  test('rows for the turn only, with review and failure states', () => {
    expect(teamRows(agents as never, 't1').map(row => [row.id, row.state, row.activity])).toEqual([['a', 'reviewing', ''], ['r', 'running', 'Reading diff'], ['f', 'needs-you', '']])
    expect(teamRows([{ ...agents[0], reviewedAt: 9 }] as never, 't1')[0]?.state).toBe('landed')
  })
})

describe('titleFrom', () => {
  test('first line, 60 characters', () => {
    expect(titleFrom('Fix the login bug\nplease')).toBe('Fix the login bug')
    expect(titleFrom('x'.repeat(80))).toHaveLength(60)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/chat-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `client/chat-view.ts`** with the four functions exactly as the tests pin them (`workedLine` seconds = `Math.round((end - started) / 1000)`; `'used N tool'`/`'tools'`).

- [ ] **Step 4: Markup** in `server/views/shell.ts`: inside `#conversation` put `<div id="messages" class="chat" role="log" aria-live="polite"></div>`; delete the `#reply-simplify`, `#reply-reconnect`, `#reply-workflow`, `#reply-default` templates (keep `#assistant-row`); add

```html
<dialog id="chat-home" class="access-dialog flat" aria-labelledby="chat-home-title">
  <header class="dialog-heading"><h2 id="chat-home-title">Where do your projects live?</h2><form method="dialog"><button class="round" aria-label="Close" type="submit"><svg><use href="#close-icon"/></svg></button></form></header>
  <p class="muted">The chat runs in one folder that holds your projects. It is never your home folder.</p>
  <form id="chat-home-form" class="field-stack"><label>Folder<input id="chat-home-path" type="text" autocomplete="off" spellcheck="false" required></label><div id="chat-home-candidates" class="chip-menu"></div><p id="chat-home-error" class="muted" role="alert"></p><button class="pill" type="submit">Use this folder</button></form>
</dialog>
```

and `<script src="/js/chat.js" type="module" defer></script>` after `shell-composer.js`. Add the team card as a template `#team-card` copied from the design (`docs/design/quiet-chat/index.html` `.team-card` article) with the sample rows removed and `<img>` src `/providers/<engine>.svg`.

- [ ] **Step 5: Implement `client/chat.ts`** per Interfaces. Rendering rules from the decision: user turn = `.msg.user > .user-message`; assistant row = clone of `#assistant-row` with `time` = turn start `toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })`, `.msg-body` gets `<p class="activity-line">` (text from `workedLine`, `data-running`) + `renderMarkdown(turn.text)` in a `.md` div + the team card when `teamRows(jobs, turn.id).length > 0`; agent turns replace the user bubble with `<p class="agent-report muted">` showing the first line, `<details>` for the rest. Team card row: `data-engine`, `data-state`, `.engine-disc img`, `strong` label, `small` `${engineName} · ${model ?? 'default'} — ${reason}`, `.latest` with `.pulse` while running, `.state` text: running `Running · <elapsed>`, reviewing `In review`, done `Done`, landed `Landed`, needs-you `Needs you`, failed same as needs-you; `.team-progress` width = done rows / all rows while any row runs. After `renderMarkdown`, the `.md` container is what the decision calls for; do not add a project title above the conversation.

Chat home flow in `send()`:

```ts
async function ensureHome(): Promise<string | null> {
  const status = await getJson('/api/chat/home')
  if (status.ok && status.data.ok === true) return String(status.data.path)
  const candidates = readArray(status.data.candidates)
  return askHome(status.data.reason === 'home' ? 'Your projects share only your home folder. Pick the folder that holds them.' : 'No projects yet. Type the folder where your projects live.', candidates.map(String))
}
```

`askHome` opens `#chat-home`, fills candidate chips (clicking one fills the input), submits `PUT /api/chat/home`, shows the error text on 400, resolves with the path on 200.

- [ ] **Step 6: `client/shell.ts`** — remove `responses`, `appendUserMessage`, `appendAssistantMessage`, `showConversation`, the `[data-chat]` handler, and the composer submit/agent-reply handlers (the chat island owns them). Keep `showScreen` and export it through `dispatchEvent(new CustomEvent('quiet:screen', { detail: name }))` listeners: the chat island calls `dispatchEvent(new CustomEvent('quiet:show', { detail: 'conversation' }))` and shell.ts listens (`addEventListener('quiet:show', e => showScreen(e.detail))`). `#new-chat` click: clear `?chat=` and the messages, show welcome, focus the message (dispatch `quiet:new-chat` so the island resets its root).

- [ ] **Step 7: CSS** additions in `public/quiet.css`:

```css
.activity-line { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
.activity-line[data-running="true"]::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 8px; border-radius: 50%; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; vertical-align: 1px; }
.agent-report { font-size: 13px; }
.agent-report details { margin-top: 4px; }
.team-card [data-state="needs-you"] .state { color: #b0556a; }
.edit-card { margin-top: 12px; padding: 10px 14px; border-radius: 14px; box-shadow: var(--raised); font-size: 13px; }
.edit-card code { font-family: Menlo, monospace; font-size: 12px; }
.send[disabled] { opacity: .5; }
```

`.chat`, `.md`, `.team-card`, `.pulse`, `.engine-disc`, `.team-progress` already exist in `public/quiet.css`; verify the `--engine` custom property is set per row (`style="--engine: #d4a091"` from a map claude `#d4a091`, glm `#91b0dc`, codex `#bfd38b`, other `#b5a5d8`).

- [ ] **Step 8: Tests and tsconfig** — `test/shell.test.ts` markers: `'id="messages"'`, `'id="chat-home"'`, `'id="team-card"'`, `'/js/chat.js'`; add `'chat'` to the island transpile list; remove any marker for the deleted templates; `tsconfig.shell.json` include `client/chat.ts`, `client/chat-view.ts`.

- [ ] **Step 9: Verify on the throwaway** (real Claude, costs a few turns): send "Which files define the terminal routes?" → the reply streams, the activity line collapses to `Worked …`, markdown renders; send "Add a comment-free TODO note file named docs/notes/chat-smoke.md with one line and get it reviewed" → a team card appears with a build row and a review row, the agent report turns arrive, the card ends `Landed` (or `Needs you` with the reason in chat). Delete the smoke file afterwards. Run `bun test`.

- [ ] **Step 10: Commit**

```bash
git add client/chat.ts client/chat-view.ts client/shell.ts server/views/shell.ts public/quiet.css test/chat-view.test.ts test/shell.test.ts tsconfig.shell.json
git commit -m "feat(chat): the landing chat is real — turns, activity line, markdown, team cards, chat home"
```

---

### Task 6: Agents drawer, history and counts for chats `[here]`

**Files:**
- Modify: `client/shell-activity.ts` (scope by chat; Stop; reply), `client/chat.ts` (history list from real chats; Agents count), `server/views/shell.ts` (history section becomes an empty `#history-list` + `#no-results`; Agents button gets `<span id="agents-count" class="count" hidden>`), `public/quiet.css` (`.count` badge, `.agent .stop`), `test/shell.test.ts`

**Interfaces:**
- `quiet:activity-scope` detail becomes `{ session?: Session | null; chat?: string | null }`; with `chat`, the drawer lists `GET /api/jobs?chat=<root>` jobs (excluding the chat turns themselves: `purpose !== 'chat'`), each `<details class="agent">` with label, engine, state, latest activity, a `Stop` text-button while running (`POST /api/jobs/:id/kill`), and the reply form posting `POST /api/jobs/:id/reply { message }` to the open agent (the existing `#agent-reply` form; label `Message <agent label>`).
- History: `GET /api/jobs` roots with `purpose === 'chat'` sorted by latest turn `startedAt` desc → `<details class="history-item">` with the label, relative day, the last assistant line (from the root's `currentActivity` or a `/thread` fetch on expand), footer `Continue chat` → sets `?chat=<root>` and shows the conversation. A running chat shows a dot before the title; a chat whose latest agent report needs you shows a red dot. Search filters by text as today.
- Agents count: number of running jobs with any `chatId` → `#agents-count` (hidden at 0).

- [ ] **Step 1: Markup + CSS** as listed; keep `#chat-search`, `#no-results`, `#history-title` ids.
- [ ] **Step 2: `client/shell-activity.ts`** — extend `setActivityScope` for `{ chat }`; render rows from `/api/jobs?chat=`; Stop and reply handlers with `postJson`; refresh every 3 s while the drawer is open (existing cadence).
- [ ] **Step 3: `client/chat.ts`** — `renderHistory()` on `quiet:show` history and every 5 s while the history screen is visible; `paintAgentsCount()` from the jobs list already fetched for team cards plus a 5 s poll of `GET /api/jobs` when no chat is open.
- [ ] **Step 4: Verify on the throwaway**: after Task 5's smoke chat, History lists it with `Continue chat` restoring it; Agents shows the spawned jobs; Stop on a running agent kills it (`GET /api/jobs` shows failed); a reply from the drawer lands as a new job in the same thread (`/thread` of that agent grows). `bun test` green.
- [ ] **Step 5: Commit**

```bash
git add client/shell-activity.ts client/chat.ts server/views/shell.ts public/quiet.css test/shell.test.ts
git commit -m "feat(chat): agents drawer scoped to the chat with stop and reply, real chat history, agents count"
```

---

## Deferred by decision (record in the ledger, do not build here)

- "Edited directly" cards with diff and Undo (Phase 2 shows the file only).
- History dots for terminals/outside sessions and the one-list merge (Phase 3).
- Codex direct-edit toggle (its sandbox cannot allow curl while blocking writes).

## Self-review

- Spec coverage: engine (T2, T3), folders (T1, T3 PATCH project), autonomy incl. landing/retries (T2 rules, T3 cap, T4 reports), team (T2 rules, T5 card), conversation (T5), history/composer/notifications (T6, T4) — every section of `docs/decisions/system-chat.md` maps to a task; composer chips and split New chat already shipped in Phase 0.
- Type consistency: `purpose: 'workflow-design' | 'chat'` is the same union in `JobRecord`, `CreateJobParams`, `EngineResolverParams`; `chatId`/`chatTurn`/`reason`/`source`/`edit`/`project`/`titleLocked` are named identically in T3, T4, T5, T6; `ChatHomeStatus` shape is shared by T1 and T5.
- Review Focus 1–5 pinned to T4 (queue), T3 (cap), T5 (disabled send), T1+T5 (home), T4 (missing root).
