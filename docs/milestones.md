# Milestones

Shipped: Mission Control 2.0 (tag `v2.0`, plan `docs/superpowers/plans/2026-09-24-v2-roadmap.md`), `mctl` 0.1.0 (tag `mctl-v0.1.0`).

## Later

### Mission Control inside Claude Code (a mod)
Parked 2026-10-04: not needed yet.

A Claude Code mod (plugin of function hooks, Claude Code v2.1.287+) that brings the cockpit into the session. It talks to the Mission Control server over HTTP, so it can run Codex, Grok, GLM and Claude jobs headless from inside Claude Code.

- Status line: usage per provider and running jobs.
- "Waiting on you" band above the prompt, only when something needs an answer, with Allow / Deny.
- `/mc` command: start jobs and runs (`/mc run "..." --engine grok`); opens a side pane with jobs, runs and the waiting list, live output, Follow / Kill / Open in app.
- Toast when a job finishes or fails.
- A tool Claude can call to hand work to another AI (for example "have Codex review this"); starts the job and returns its id, so Claude never blocks for minutes.

Where it works: Claude Code in a terminal and the Desktop app's Code tab show everything. VS Code, `claude -p` and Remote Control run the hooks but draw nothing, so fall back to text replies. Open bug: a mod's band does not draw in Desktop/iOS views of a Remote Control session (anthropics/claude-code#99217).

Constraints: refresh at most every ~30 s while visible (no high-frequency polling). Use HTTP, not `$.process` (terminal-only).

Docs: https://code.claude.com/docs/en/plugins/mods/overview
