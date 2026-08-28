# P0 Runtime Spike — Verdicts

Ran for real under Bun on macOS arm64 (Darwin 25.5.0). Reproduce with `bun spike/run.ts`.

## Verdict table

| Component | Version | Verdict |
|---|---|---|
| Bun | 1.2.17 | PASS — `bun --version` |
| elysia | 1.4.30 | PASS — hello server booted on 127.0.0.1:7997, curled, killed |
| @elysiajs/static | 1.4.10 | PASS — plugin loads and mounts without error |
| @elysiajs/cookie | 0.8.0 | PASS — plugin loads without error |
| @elysiajs/html | 1.4.2 (uses @kitajs/html 4.2.13) | PASS — JSX view rendered through a real Elysia route, curled, killed |
| node-pty | 1.1.0 | **FAIL** — spawns, but reading the PTY master fd throws `ENXIO` under Bun |
| bun-pty | 0.4.10 | PASS — chosen replacement, see below |
| `Bun.build` (write:false) | Bun 1.2.17 built-in | PASS — in-memory transpile, output has zero TS syntax |

## Chosen pty path: `bun-pty`

node-pty is the spec's first choice but does not work under Bun on this machine. Evidence:

1. Installed `node-pty@1.1.0`. It ships prebuilt binaries for `darwin-arm64` (`prebuilds/darwin-arm64/pty.node` + `spawn-helper`), so no compile step is needed.
2. First run failed immediately:
   ```
   error: posix_spawnp failed.
         at new UnixTerminal (node_modules/node-pty/lib/unixTerminal.js:92:24)
   ```
   Root cause: Bun does not run dependency lifecycle scripts by default (`bun pm untrusted` → "Found 0 untrusted dependencies with scripts" — meaning none ran). node-pty's own `postinstall` (`node scripts/post-install.js`) normally chmods `spawn-helper` executable; since it never ran, the shipped binary had `rw-r--r--` permissions.
3. After manually `chmod +x` on `spawn-helper`, spawn succeeds, but reading from the pty immediately throws:
   ```
   ENXIO: no such device or address, read
         fd: 5,
    syscall: "read",
       errno: -6,
        code: "ENXIO"
   ```
   This is a genuine Bun-vs-Node incompatibility in how node-pty's N-API binding polls the PTY master fd (Bun's I/O layer doesn't drive it the way Node's libuv does) — not a permissions or install issue. It reproduces every time (see `spike/check-node-pty.ts`, run via `spike/run.ts` step 3a).
4. Per the spec's fallback order, tried `bun-pty@0.4.10` (Rust `portable-pty` + Bun FFI, built specifically for Bun). Both required checks passed cleanly:
   - Non-interactive spawn: `spawn('/bin/echo', ['hello'], ...)` → `onData` captured `"hello\r\n"`.
   - Interactive shell: `spawn('/bin/sh', [], ...)` → `write('echo hi\n')` → `onData` captured `"echo hi\r\n"`, then `kill()` succeeded.
5. **Decision: use `bun-pty` for `server/terminals.ts`.** Its API (`spawn`, `onData`, `onExit`, `write`, `resize`, `kill`) is a near-drop-in match for node-pty's shape, so the spec's `terminals.ts` design (pty <-> ws bridge) needs no structural changes — only the import source changes from `node-pty` to `bun-pty`.
6. `script -q /dev/null` fallback was not needed and was not exercised, since `bun-pty` succeeded outright.

node-pty is kept installed in `package.json`/`spike/` only so the failure above stays reproducible for anyone re-running the spike — it must **not** be used by real server code in later phases.

## Bun / Elysia quirks later phases must know

1. **`bun add`/`bun install` silently drops `package.json` writes when the workspace's own `postinstall` script fails.** This repo's `package.json` declares `"postinstall": "bun scripts/postinstall.ts"`, but `scripts/postinstall.ts` doesn't exist yet (it's future-phase work). Every `bun add <pkg>` in this state resolves and downloads the package, updates `bun.lock`, and populates `node_modules` correctly — but does **not** persist the new dependency into `package.json`, and the process exits 1. Verified by installing `left-pad` this way: `bun.lock` had it, `node_modules` had it, `package.json` did not, and `bun remove left-pad` then failed with "package.json doesn't have dependencies, there's nothing to remove!".
   - **Workaround used in this spike:** run `bun add <pkg> --ignore-scripts` (or `bun install --ignore-scripts`), then manually verify/edit `package.json`'s `dependencies` field against `bun.lock` if any non-`--ignore-scripts` install slipped through.
   - **Action for phase 1:** create `scripts/postinstall.ts` (even as a no-op) early, before any further `bun add` calls, so this stops being a footgun.

2. **Bun does not run dependency lifecycle scripts (`install`/`postinstall`) by default**, even when the *workspace's own* postinstall succeeds — only packages listed in `trustedDependencies` get theirs run (`bun pm untrusted` reports the count). This is a deliberate supply-chain protection, not a bug, but it means any dependency whose correctness depends on a postinstall step (permission fixes, native rebuilds without a shipped prebuild) will silently be missing that step unless added to `trustedDependencies` in `package.json`. This is exactly what caused the node-pty `spawn-helper` permissions gap above.

3. **`@elysiajs/html` JSX views need no project-wide `tsconfig.json`.** A per-file pragma comment, `/** @jsxImportSource @kitajs/html */` as the first line of a `.tsx` file, is enough for Bun's built-in transpiler to route JSX through `@kitajs/html`'s automatic runtime (`jsx-runtime.js`) — confirmed working with zero `tsconfig.json` present anywhere in the repo. The file must have a `.tsx` extension; `.ts` files cannot contain JSX syntax even with the pragma. For phase 1, decide once whether to keep the per-file pragma (simple, but must be remembered in every `server/views/*.tsx`) or add a repo-root `tsconfig.json` with `"jsx": "react-jsx", "jsxImportSource": "@kitajs/html"` so view files need no pragma at all — the spike used the per-file pragma only to avoid introducing a new top-level config file during the spike.

4. **`@elysiajs/html`'s own bundled README is stale** — it shows importing from `@elysia/html` (no `s`) and manually importing `Html` for JSX support. Neither is needed with the installed `@elysiajs/html@1.4.2` / `@kitajs/html@4.2.13`: JSX views render correctly with only `/** @jsxImportSource @kitajs/html */` and no `Html` import in scope. Don't copy the README's import style verbatim.

5. **`Bun.build({ write: false })` behaves as documented**: `result.outputs[0].text()` gives fully-stripped browser JS (confirmed no TS-only syntax — no type annotations, no `interface` keyword — survives in output), suitable for the spec's in-memory `GET /js/:name.js` transpile-on-request route with no `dist/` on disk.

## Files

- `spike/run.ts` — runs all checks in order, end to end
- `spike/check-elysia.ts`, `spike/server-hello.ts` — check 2
- `spike/check-node-pty.ts` — check 3a (documented failure)
- `spike/check-bun-pty.ts` — check 3b (chosen path)
- `spike/check-bun-build.ts`, `spike/fixtures/sample-client.ts` — check 4
- `spike/server-jsx.tsx`, `spike/fixtures/sample-view.tsx` — check 5
