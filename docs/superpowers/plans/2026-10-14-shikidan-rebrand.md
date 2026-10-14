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

## Phase 3: landing page

A new marketing page for shikidan.com. Same colors and fonts as the app, a slot for the logo (coming later), SVG icons only, no emoji.
