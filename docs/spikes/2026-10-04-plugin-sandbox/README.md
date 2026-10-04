# Plugin sandbox spike (Run H1)

Question: can `@anthropic-ai/sandbox-runtime` host an isolated plugin process (Bun child speaking
JSON-RPC over stdio) with home-directory reads denied, network locked to an allowlist, and writes
confined to a data dir — on this macOS machine, driven from a Bun host?

- `fixture-plugin.ts` — the sandboxed child. Speaks the isolated server protocol
  (`vscode-jsonrpc` StreamMessageReader/Writer over stdin/stdout, `plugin.call` request,
  `plugin.shutdown` notification, host `settings.get` request, `log` notification) and implements
  `readFile` / `fetchUrl` / `writeData` / `writeAbs` / `askSetting`. FS denials are classified
  `DENIED EPERM|EACCES`; every other errno is returned as `ERROR <code> <message>` (probe FAIL).
- `spike.ts` — the host. Initializes `SandboxManager`, wraps the child via
  `SandboxManager.wrapWithSandboxArgv()` (same wrapper as `wrapWithSandbox()`, but returns
  `{ argv, env }` so the child gets piped stdio without a `shell: true` spawn), then runs the 8
  probes and prints one `PASS|FAIL <name> <detail>` line each.

## Final sandbox config

```ts
const config: SandboxRuntimeConfig = {
  network: { allowedDomains: ['example.com'], deniedDomains: [] },
  filesystem: {
    denyRead: [homedir()],
    allowRead: [
      REPO_ROOT,                      // worktree root; see "Bun-specific requirements" below
      join(REPO_ROOT, 'node_modules'),
      dirname(process.execPath),      // bun binary dir (exec needs file-read of the image)
      join(homedir(), '.bun'),        // bun install dir (module cache)
    ],
    allowWrite: [DATA_DIR],           // mkdtemp dir standing in for plugin-data/<id>/files
    denyWrite: [],
  },
}
```

Host-side spawn settings that are as load-bearing as the config itself:

- `process.env.CLAUDE_CODE_TMPDIR = <DATA_DIR>/tmp` before `initialize()` — sandbox-runtime bakes
  the child's `TMPDIR` from this (default `/tmp/claude`, which does not exist here and is not
  writable inside the sandbox).
- child env adds `BUN_TMPDIR=<DATA_DIR>/tmp` plus `MC_PLUGIN_RUNTIME=isolated`,
  `MC_PLUGIN_ID=sandbox-spike`, `MC_PLUGIN_DATA=<DATA_DIR>`.
- child `cwd: DATA_DIR` — Bun refuses to start a script whose cwd it cannot write to
  (`error: bun is unable to write files: AccessDenied`; with a read-denied cwd it dies with the
  generic `error: An unknown error occurred (Unexpected)`).

## Probe output (verbatim)

Working run — Bun 1.2.23, sandbox-runtime 0.0.78, macOS (darwin):

```text
$ bun docs/spikes/2026-10-04-plugin-sandbox/spike.ts
spike bun=1.2.23 sandbox-runtime=0.0.78 darwin
[plugin-log] env SANDBOX_RUNTIME=1 HTTP_PROXY=http://localhost:60004 HTTPS_PROXY=http://localhost:60004 ALL_PROXY=http://localhost:60004 NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16 TMPDIR=/var/folders/dy/c99q_rv97nqbh4_tj64nc2t00000gn/T/mc-spike-data-kGQ10s/tmp
PASS startup 43ms
PASS read-own content matches fixture-plugin.ts
PASS read-secret DENIED EPERM
PASS read-ssh DENIED EPERM
PASS net-allowed STATUS 200
PASS net-denied STATUS 403
PASS write-data writeData=ok data-file=ok writeAbs(/Users/lynchz/mc-spike-8d550ddd8fa77c6c)=DENIED EPERM
PASS settings-roundtrip spike-value
VERDICT: GO
```

(the `[plugin-log]` line is stderr, shown sanitized — the real proxy URLs embed the session
token, and the mkdtemp dir is run-specific). Every probe but the two network ones is
version-independent. Identical `VERDICT: GO` on a repeat run and under Bun 1.4.2
(all 8 PASS, startup 34 ms).

Boundary run — the repo's currently installed Bun 1.2.17 (only the two network probes fail; the
child's proxy env is identical, the mux proxy's `node:http` backend cannot parse
`CONNECT` under this Bun, so every proxied HTTPS request dies with the proxy's
`400 Bad Request` parse-error response):

```text
$ bun docs/spikes/2026-10-04-plugin-sandbox/spike.ts
spike bun=1.2.17 sandbox-runtime=0.0.78 darwin
note: bun 1.2.17 cannot parse HTTP CONNECT inside node:http (fixed by bun 1.2.23); net-allowed/net-denied are expected to FAIL with STATUS 400 under this host
PASS startup 42ms
PASS read-own content matches fixture-plugin.ts
PASS read-secret DENIED EPERM
PASS read-ssh DENIED EPERM
FAIL net-allowed STATUS 400
FAIL net-denied STATUS 400
PASS write-data writeData=ok data-file=ok writeAbs(/Users/lynchz/mc-spike-de4a76fdca49a739)=DENIED EPERM
PASS settings-roundtrip spike-value
VERDICT: NO-GO net-allowed, net-denied
```

Root cause of the 1.2.17 failure, isolated with a raw TCP `CONNECT example.com:443 HTTP/1.1`
against the proxy: under a Bun 1.2.17 host the backend answers `400 Bad Request` (SRT debug:
`Client connection error: Parse Error`) while a plain `GET http://example.com/` answers the
expected `407`; under Node 22 and Bun ≥ 1.2.23 both methods parse. So the sandbox itself denies
nothing extra on 1.2.17 — the host's HTTP server breaks HTTPS egress. Bun version matrix probed:
1.2.17 broken; 1.2.23, 1.3.0, 1.4.2 all pass the full spike.

VERDICT: GO — with the hard requirement that the host process running the sandbox
(mission-control server) uses Bun ≥ 1.2.23.

## What Run H6 (isolated runtime) must copy

Exact allow paths (relative to this layout):

- `denyRead: [<homedir>]` — deny the whole home, then re-allow:
  - the plugin's install/worktree root (see the resolver note below),
  - `<repo>/node_modules`,
  - `dirname(process.execPath)` and `~/.bun`.
- `allowWrite: [<plugin data dir>]` only. Denials of reads/writes surface as `EPERM`
  (seatbelt), so classify `EPERM`/`EACCES` as "denied by sandbox" and everything else as an error.

Bun-specific requirements (each cost a failed iteration before the probes went green):

1. **Bun ≥ 1.2.23 on the host.** Older Bun's `node:http` server cannot parse `CONNECT`, which
   kills all proxied HTTPS from plugins. 1.2.17 is installed on this machine today — upgrading
   the runtime that hosts plugins is part of H6, not optional.
2. **Writable cwd + writable TMPDIR + `BUN_TMPDIR` for the child.** Bun hard-fails without them
   (see the error strings above). Redirect `TMPDIR` into the data dir via
   `process.env.CLAUDE_CODE_TMPDIR` before `wrapWithSandbox`/`wrapWithSandboxArgv`, set
   `BUN_TMPDIR` to the same dir, and spawn with `cwd` = the data dir.
3. **Bun's resolver needs the ancestors.** With only the plugin folder allowed, Bun 1.2.23 aborts
   module resolution (`Cannot find module 'vscode-jsonrpc/node'`) when its walk-up hits a
   read-denied ancestor, so allow the worktree root rather than just the plugin folder.
4. **Bun `fetch` honours `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`** — verified by `net-allowed`
   returning 200 through the mux, including the proxy-auth credentials embedded in the URL.

Env the wrapped child actually receives (observed via the `log` notification; the proxy URLs are
shown sanitized, the real ones embed `http://<user>:<token>@localhost:<port>` — the token is
session-scoped and must never be logged raw):

- `SANDBOX_RUNTIME=1`
- `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` (+ lowercase) = `http://…@localhost:<muxPort>`
- `NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`
- `TMPDIR=<CLAUDE_CODE_TMPDIR value>`
- plus `GRPC_PROXY`, `FTP_PROXY`, `RSYNC_PROXY`, `DOCKER_HTTP(S)_PROXY`, `CLOUDSDK_PROXY_*`,
  `GIT_SSH_COMMAND` (SOCKS ProxyCommand for git+ssh), `JAVA_TOOL_OPTIONS` when relevant.

Network denial behaviour (for `net-denied` classification): the mux proxy answers `403` for an
off-allowlist host (`STATUS 403` above); on hosts where the tunnel cannot even be established the
client throws with the connection-refused/proxy message. Pass criteria per the plan revision:
`net-allowed` green in the same run AND the denied fetch is either `STATUS 403|407` or an `ERROR`
with actual refusal semantics — the message matches `ECONNREFUSED`/`refused`, or it mentions the
proxy together with an explicit rejection marker (rejected/denied/forbidden/unauthorized/403/407).
Generic connection failures (connect timeout, connection closed/reset, "fetch failed", even a
timeout that names the proxy) are infrastructure noise, not proof of denial, and FAIL the probe —
a message merely containing `connect` or `tunnel` must never count.

Other notes:

- `wrapWithSandboxArgv()` is preferred over `wrapWithSandbox()` for plugin hosting: it returns
  `{ argv, env }` for a `{shell: false}` spawn with piped stdio (JSON-RPC), keeping the child's
  command bytes off a host shell.
- stdio pipes are writable inside the sandbox without any allowWrite entry; the fixture writes
  nothing to stdout except JSON-RPC frames.
- `settings.get` round-trips host→plugin and plugin→host over the same connection (probe
  `settings-roundtrip`), so the H6 RPC surface works unchanged under the sandbox.
- Dependencies added for this spike (also what H6 needs): `@anthropic-ai/sandbox-runtime@0.0.78`,
  `vscode-jsonrpc@9.0.3`, `comlink@4.4.2`. Installed with
  `bun add --ignore-scripts …` so the repo `postinstall` (skill relinks) never ran from this
  worktree.

## Reproduce

```sh
bun add --ignore-scripts @anthropic-ai/sandbox-runtime vscode-jsonrpc comlink   # already in package.json
bun docs/spikes/2026-10-04-plugin-sandbox/spike.ts
```

Exit code 0 = all probes pass. Under Bun < 1.2.23 the run itself prints the boundary note and
fails only `net-allowed`/`net-denied` with `STATUS 400`.
