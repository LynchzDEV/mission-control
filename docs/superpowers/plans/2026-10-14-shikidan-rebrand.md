# Shikidan rebrand

Mission Control becomes **Shikidan** (shikidan.com). Three phases, run one at a time on `main`.

## Name map

| Old | New |
|---|---|
| "Mission Control" (UI, docs) | Shikidan |
| repo / package / dir `mission-control`, GitHub `LynchzDEV/mission-control` | `shiki`, `LynchzDEV/shiki` |
| CLI `mctl` (`cli/mctl.ts`, `man/mctl.1`) | `shiki` (`cli/shiki.ts`, `man/shiki.1`) |
| env `MISSION_CONTROL_*`, `MC_*` | `SKD_*` |
| `~/.config/mission-control`, `~/.cache/mission-control` | `~/.config/shikidan`, `~/.cache/shikidan` |
| per-repo session folder `.mission-control/` | `.shikidan/` |
| localStorage `mc.*` | `skd.*` |
| log event types `mc_permission_request`, `mc_permission_resolved`, `mc_models` | `skd_*` |
| `window.__MC_PLUGIN__` | `window.__SKD_PLUGIN__` |
| skill `mc-dispatch` (`skills/mc-dispatch/`, `prompts/mc-dispatch.md`) | `skd-dispatch` |
| plugin repos `mc-plugin-sdk`, `mc-plugin-clickup`, `mc-plugin-template`, `mc-marketplace` | `skd-plugin-*`, `skd-marketplace` |
| Windows scheduled task `Mission Control`, log `~/mission-control.log` | `Shikidan`, `~/shiki.log` |

## Phase 1: documents

Living docs only. Dated records (`docs/decisions`, `docs/superpowers`, `docs/spikes`, `docs/design/**/DECISION.md`) keep the old name as history. Runtime-read docs (`skills/`, `prompts/`) move with Phase 2.

## Phase 2: codebase and views

Running installs must survive the upgrade: the WSL PC is started by the Windows task from `~/mission-control` and must not be killed or moved.

- **2a host (this repo)**
  - Rename every visible string, title, package name, CLI, man page, skill and prompt file.
  - Read compatibility, removed in a later cleanup:
    - env: read `SKD_X`, then the old `MISSION_CONTROL_X` / `MC_X`.
    - config dir: at startup, if `~/.config/shikidan` is missing and `~/.config/mission-control` exists, rename it and leave a symlink at the old path.
    - per-repo folder: write `.shikidan/`, and read `.mission-control/` when the new one is missing.
    - localStorage: copy `mc.*` to `skd.*` once on load.
    - log events: write `skd_*`, read both `skd_*` and `mc_*`.
    - generated-file marker: recognise both the old and the new marker.
    - plugins: the host exports both `SKD_PLUGIN_*` and `MC_PLUGIN_*`, and both window globals, until every plugin is on the new SDK.
  - Skill installer: remove links in `~/.claude/skills` that point into this repo's `skills/` but no longer resolve, so the old `mc-dispatch` link does not dangle.
  - Windows autostart: the new task removes an existing `Mission Control` task first, so the app never starts twice.
- **2b plugin repos** (`.plugins-dev/*`): rename packages, the schema file and the README; the SDK reads `SKD_PLUGIN_*` first, then `MC_PLUGIN_*`.
- **2c GitHub**: rename the 5 repos (GitHub redirects the old URLs), update `origin` in every checkout and worktree, and update the marketplace URLs. Each rename needs an explicit go-ahead first.
- **2d global Claude config**: rename `mc-dispatch` to `skd-dispatch` in the hand-written dispatch table in `~/.claude/CLAUDE.md`, in the same push as 2a, so other sessions keep finding the skill.

## Decisions (2026-10-14)

- The uncommitted daily-retro notes in `skills/mc-dispatch/SKILL.md` are never staged. They ride along the folder move as unstaged changes.
- `~/.claude/CLAUDE.md` changes `mc-dispatch` to `skd-dispatch`, in the hand-written section only. The edit lands in the same push as 2a, not before.
- The GitHub renames come last. Each one is confirmed just before it runs.
- Phases 1 and 2 are pushed together.
- Phase 1 already renamed these in the docs (0e3f262); Phase 2 code must write the same names:
  - log file → `~/shiki.log`
  - backup suffix → `.pre-shikidan-<ts>`
  - sysctl file → `60-shikidan-userns.conf`
  - planned `/mc` command → `/skd`
- Never changed: the existing tag `mctl-v0.1.0`, and the design-brief "MC mark", which is history.

## Phase 2a spec (host repo)

### Ground rules
- Work on `main` in the main checkout. Commit locally after each unit below and never push.
- Never stage the daily-retro hunks, `.DS_Store`, `brag-output*/`, `visualizer/` or `docs/superpowers/plans/2026-09-29-dark-theme.md`.
- Never start, stop or kill the cockpit on :7777.
- Before the first `bun test` and after the last one, record `readlink ~/.claude/skills/mc-dispatch`. Restore the link if a test run re-pointed it.
- Record a baseline first: `bun test`, `bun run typecheck:studio` and `bun run typecheck:cli` pass or fail counts. A unit is done only when there are no new failures.

### Units, one commit each
1. **Env names.**
   - Add one helper `server/env.ts` that reads `SKD_X`, then `MISSION_CONTROL_X`, then `MC_X`. Route every env read in `server/`, `cli/` and `scripts/` through it.
   - Env vars in use: `CONFIG_DIR`, `PORT`, `ALLOWED_HOSTS`, `ALLOWED_USERS`, `FULL_AGENT_SETUP`, `FAKE_ENGINES`, `FAKE_ENGINE_CMD`, `FAKE_CHAT_BRIDGE`, `MODEL_DISCOVERY`, `LOG`, `GOAL_SCRATCH`, `BRIDGE_FAKE`, `TEST_HOST_ONLY_MARKER`, `FIXTURE_KEY`.
   - Tests set the `SKD_*` names. One test proves each legacy name still works.
2. **Data folders.**
   - `~/.config/shikidan` and `~/.cache/shikidan` (`server/secrets.ts:67`, `cli/mctl.ts:113`, `server/workflow-builder.ts:37`).
   - At startup, if the new config folder is missing and the old one exists, rename it and leave a symlink at the old path.
   - Per-repo `SESSION_CONTEXT_DIR` becomes `.shikidan`, falling back to reading `.mission-control` when the new one is missing. Write the new name to `.git/info/exclude`.
   - Tests cover: fresh install, migrate, already migrated, and both folders present (new one wins, old one untouched).
3. **Views and browser storage.**
   - Change every visible "Mission Control" (e.g. `server/views/shell.ts:218` and `:236`) and the favicon title.
   - CSS classes `mc-panes` → `skd-panes`, `mc-terminal` → `skd-terminal`.
   - Storage keys `mc.*` → `skd.*`: `alerts`, `motion.paused`, `queue.layout`, `quiet.terminal`, `shell.edit`, `shell.engine`, `shell.mode`, `shell.model`, `shell.project`, `sidebar.hidden`, `term.recentCwd`, `theme`, and the `chat.leaf.*`, `chat.mode.*`, `chat.model.*` prefixes. Saved values copy over once on load.
4. **Log events and plugin contract.**
   - Write `skd_capabilities`, `skd_child`, `skd_commands`, `skd_context`, `skd_models`, `skd_permission_request`, `skd_permission_resolved`, `skd_stderr`. Readers accept the `mc_*` names too, so old job logs still read correctly.
   - The plugin host exports both `SKD_PLUGIN_*` and `MC_PLUGIN_*` (`server/plugins/isolated-supervisor.ts`, `runtime-isolated.ts`), and both `window.__SKD_PLUGIN__` and `window.__MC_PLUGIN__`.
   - `AGENT_MARKER` in `server/engine-assets.ts:32` becomes `# generated by shikidan`, and both markers are recognised.
   - The `SKD_RESULT` output marker is written, and `MC_RESULT` is still read.
5. **CLI and package.**
   - `git mv cli/mctl.ts cli/shiki.ts` and `man/mctl.1 man/shiki.1`.
   - In `package.json`, set the name to `shiki` and the bin to `{ "shiki": "cli/shiki.ts" }`. Update `tsconfig.cli.json` and `bun.lock`.
   - The help text and all output say `shiki`.
6. **Skill and prompt.**
   - `git mv skills/mc-dispatch skills/skd-dispatch` and `prompts/mc-dispatch.md prompts/skd-dispatch.md`. Rename `MC_URL` → `SKD_URL` (and the other names) inside them.
   - To commit `SKILL.md` without the retro hunks, stage the HEAD content with the renames applied: `git show HEAD:<old> | <rename> | git hash-object -w --stdin`, then `git update-index --add --cacheinfo 100644,<sha>,skills/skd-dispatch/SKILL.md`. Afterwards `git diff skills/skd-dispatch/SKILL.md` must show only the retro hunks.
   - `server/skill-install.ts` removes links in `~/.claude/skills` that point into this repo's `skills/` and no longer resolve. The backup suffix becomes `.pre-shikidan-<ts>`. Tests use a temp target directory only.
7. **Windows and WSL scripts.**
   - Default clone `~/shiki`, task `Shikidan`, log `~/shiki.log`, sysctl file `60-shikidan-userns.conf`.
   - `install-autostart.ps1` unregisters an existing `Mission Control` task before registering the new one.
   - `setup.sh` accepts an existing `~/mission-control` clone without moving it.
8. **Upgrade note.** Add a short "Upgrading from Mission Control" note to `README.md`, and check that the docs still match the code.

Exit condition: all units committed, no new test or typecheck failures, and `grep -rIiE "mission.?control|mctl|mc-dispatch|\bMC_[A-Z]|\bmc_[a-z]|'mc\." server client cli scripts public prompts skills test` shows only the compatibility reads, each with a `ponytail:` comment that names the cleanup.

## Phase 2b-2d (after 2a)

- **2b:** each `.plugins-dev` repo gets its own commit.
  - SDK: reads `SKD_PLUGIN_*`/`__SKD_PLUGIN__` first, then the old names.
  - Package names `skd-plugin-*`; `schema/mc-plugin.schema.json` → `skd-plugin.schema.json`, with the old schema path still resolving.
- **2b status (2026-10-14, local, not pushed):** done in `.plugins-dev/skd-*`.
  - The SDK is rebased onto GitHub `main`. `v0.2.0` was already published there (pluginApi 2 contributes), so the rename ships as **v0.3.0**; the tag exists locally only.
  - There is a sixth repo, `mc-plugin-card-pipeline`, cloned to `.plugins-dev/skd-plugin-card-pipeline`. The marketplace commit is rebased onto the GitHub card-pipeline listings.
  - Names the host reads stay as they are for now: the `mc-plugin.json` manifest file, `{{mc:mctl}}`, `.mc-plugin`, `.mc-build`.
- **2c:** `gh repo rename` for the 6 repos (`mission-control`, `mc-plugin-sdk`, `mc-plugin-template`, `mc-plugin-clickup`, `mc-plugin-card-pipeline`, `mc-marketplace`), one confirmation each. Then `git remote set-url` in every checkout and `.worktree/*`. After that:
  - Push SDK `main` + tag `v0.3.0`.
  - Switch the template, ClickUp and card-pipeline plugins to `"@shikidan/plugin-sdk": "github:LynchzDEV/skd-plugin-sdk#v0.3.0"` (dependency, imports, `bun.lock`).
  - Update the README repo URLs and the `marketplace.json` repo URLs.
- **2d (done 2026-10-14):**
  - `~/.claude/CLAUDE.md` dispatch row now says `skd-dispatch`.
  - `~/.claude/skills/skd-dispatch` links to this repo; the dangling `mc-dispatch` link is removed.
  - The global `shiki` command comes from `bun link`; the `mctl` link is removed.

## Phase 3: landing page

A new marketing page for shikidan.com. Same colors and fonts as the app, a slot for the logo (coming later), SVG icons only, no emoji.
