# Workflow Studio and agent connections

## Agreed behavior

Mission Control keeps protected core rules and a ready-to-run default: Plan → Verify plan → Execute → Cross-family review. Users duplicate this default or create a custom blueprint, edit arbitrary AI tasks, connect outcomes, select agents/models, attach skills and MCP tools, and add executable acceptance checks. A task such as E2E with Jev uses the configured tool and reports evidence; a model saying “done” is insufficient.

Core policy, workflow instructions, and node inputs are separate. Core policy has its own immutable revisions. Editing a blueprint cannot replace it. Each run snapshots its workflow, policy, agent configuration, and rendered instructions. Retrying/resuming uses those snapshots. Credential values are excluded from snapshots. The linked mc-dispatch skill remains a stable entry point, with no per-run writes to a shared skill file.

## Build sequence

1. Versioned workflow/policy storage, validation, default graph, and prompt composition. Test immutable revisions, invalid graphs, required implementation checkpoints, and task-specific instructions.
2. Configurable agent connections alongside existing Claude/GLM/Codex. Use the official ACP SDK for native agents and OpenCode's ACP interface for direct API/local providers. Provide a configurable headless CLI escape hatch. Test protocol exchange, failure, cancellation, permissions, environment references, and normalized output with local fake processes.
3. Persisted workflow execution using the existing job manager. One active node per run, outcome edges, bounded cycles, check commands, explicit blocked states, stop/retry/recovery, and no duplicate legacy auto-review. Test actual subprocess execution, revision isolation, missing evidence, checks, restart, and cross-family enforcement.
4. Studio page using React Flow in an isolated React island. Keep the existing visual language and terminal shell. Include graph editing plus accessible form controls, blueprint revisions/default selection, connection setup, prompt preview, run history, node evidence, and failure/retry controls. Verify browser bundling, authenticated routes, and browser interaction.
5. Integrate the stable dispatch entry and document setup/limitations. Run relevant tests throughout, the complete suite at the end, and self-review security and TypeScript changes in this thread.

## Reuse and compatibility

- Existing job processes, logs, threads, authentication, config directory, and workspace validation remain the execution foundation. Existing sequential runs and job APIs remain compatible.
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), Apache-2.0: maintained typed stdio protocol and capability negotiation. Use published stable APIs, not experimental remote transport.
- [OpenCode ACP](https://opencode.ai/docs/acp/) and [providers](https://opencode.ai/docs/providers/), MIT: reuse a coding agent's tool loop and provider integrations instead of implementing another coding harness. Users install/authenticate the native CLI. Subscription eligibility is provider-specific; technical connectivity does not imply unattended-use entitlement.
- [React Flow](https://reactflow.dev/learn), MIT core: reuse nodes, edges, keyboard interaction, pan/zoom, and dragging. React stays isolated to Studio. No paid template is needed. Preserve attribution. Bound blueprints to 64 nodes and execution to a finite visit count.
- No universal library can control a closed cloud product without a public integration. Connections are extensible; only configured and successfully probed capabilities are claimed.

## Execution and policy boundaries

Graphs route one execution token through pass/fail/blocked edges. Each node has at most one edge per outcome; this is explicit conditional routing, not parallel fan-out. Cycles have finite visit limits. Concurrent runs cannot write the same workspace. Unknown or interrupted completion is blocked for inspection rather than silently rerunning side effects.

Implementation nodes require successful plan verification before editing and a later successful review by a different declared model family before completion. Generic research/test nodes do not require commits. Mandatory worker scope, evidence honesty, and tool/workspace boundaries are composed into every node. Runtime guards enforce orchestration and result rules; unrestricted native CLIs are not an OS sandbox.

ACP permissions and attached tools are explicit connection settings. Credentials use environment variable references and native CLI sign-in, never API-returned secret values. MCP and skills must be available to the chosen adapter; unsupported combinations fail clearly. Tools/check commands run locally with the user's authority.

## Validation seams

Use the repository's Bun test style at public boundaries: workflow store/validator, connection parser and subprocess adapter, workflow runner, authenticated routes, browser bundle, and actual Studio interactions. Use fake local agents for deterministic integration checks; never spend subscription credits or invoke live coding agents during automated tests. Live provider and Jev verification requires installed/configured tools and credentials and must be reported separately from simulated tests.

## Progress

- Implemented versioned blueprints and core prompt composition, with the existing worker implementation rules applied only to implementation nodes.
- Implemented ACP/OpenCode/custom CLI connections, native job and terminal integration, capability probing, and advertised session resume.
- Implemented sequential graph routing with bounded loops, pinned run settings, acceptance commands, workspace reservations, stop/retry, and restart recovery.
- Implemented Studio in an isolated React Flow island, including revision selection, node editing/wiring, connection setup, policy editing, prompt preview, and run evidence.
- Updated the linked dispatch entry to select server-owned versioned workflows while retaining its older-server fallback. No jobs were dispatched through that skill during this implementation.
- Added Bun integration tests, strict TypeScript checking for the new modules, and an isolated browser check. Browser checks exercised the four-node default and five-node custom Jev-shaped workflow with local fixture ACP agents, dragging, routing, save/reload, capability probing, prompt revisions, and mobile layout.
- Foundation verification: 845 tests passed across 60 files, strict Studio TypeScript check passed, browser check passed, and `git diff --check` passed. The legacy plan runner test now waits for its asynchronous plan-display update before asserting the displayed result.
- Live Grok/Qwen/OpenCode provider accounts and a live Jev harness were not invoked. These require the user's installed agents, eligible authentication, and tool setup.
- Foundation development preserved existing user-owned untracked files and did not restart the live server.

## Approved interface: A

The user selected Variant A: describe the workflow first, then edit it on the canvas. The production Studio now follows that design, preserving MC's theme, typography, spacing, and description box. The existing default, templates, blank canvas, editable presets, and custom instructions remain available together. Connections, rules, versions, and run evidence have secondary screens or panels. There is no Jev-specific preset.

AI creation and editing use the existing job manager and native/ACP connections in a temporary designer directory. Responses are parsed into validated drafts; generation does not save or run them. New executable attachments require manual setup. Draft jobs support cancellation, timeout, and reconnecting while running. Native tool restrictions and ACP permission denial are tested independently of real accounts.

The browser check exercises generation and edits through the actual API with fixture agents, default/custom execution, keyboard entry of acceptance-check arguments, dragging, save/reload, connections, prompt revisions, and mobile layout. It also caught an empty response from the idle draft endpoint that prevented Rules from loading; the endpoint now returns a JSON envelope, with a regression test.

Design explorations and reference screenshots remain local under `docs/design/workflow-studio/`; the browser check reproduces the production interface verification.

Final A verification: 854 tests passed across 62 files, strict Studio TypeScript checking passed, the desktop/mobile browser check passed, and `git diff --check` passed. Live provider accounts were not exercised, and the running MC server was not restarted.

## Follow-through

Terminal integration now selects **Default workflow** or a saved workflow before opening or resuming a session. Each terminal pins its own revision and displays its name/version under the header. The original MC workflow remains selectable when a custom workflow is the workspace default. Opening a terminal does not execute a workflow. Native instructions and optional custom CLI instruction slots pass the selection; terminal-originated runs enforce the pinned workflow and directory and associate child jobs with the terminal. The shared dispatch entry uses the terminal's own service URL/configuration, so 7778 does not dispatch to 7777.

The step AI picker now has one **Use default** entry and one entry per AI. Its helper text explains the current default assignment, removing the three duplicate role choices from the main list.

Terminal verification: 857 tests passed with no failures or unhandled errors; strict Studio and terminal-client TypeScript checks passed. The browser check covered independent Default/custom terminals, split headers, reload persistence, and selecting the original MC workflow after making a custom workflow the workspace default. Native launch arguments were checked without invoking live providers. The idle 7778 service was restarted and its authenticated terminal page verified. Port 7777 retained its original process and unchanged authentication, settings, and secrets.

See [the setup and behavior guide](../workflow-studio.md). Run `bun test`, `bun run typecheck:studio`, and `bun run check:studio` to reproduce verification. The application gains Studio when the updated server is started. The graph deliberately routes one active node at a time; parallel fan-out, custom-provider quota adapters, and closed cloud product APIs are not implemented.
