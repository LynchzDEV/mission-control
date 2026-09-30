# Chat Agent SDK spike — verdicts

Ran for real on 2026-09-30 against `@anthropic-ai/claude-agent-sdk@0.3.285` with the installed `claude` at `/Users/lynchz/.local/bin/claude`. Reproduce with `env -u CLAUDE_CONFIG_DIR -u MISSION_CONTROL_CONFIG_DIR -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN bun scripts/sdk-spike.ts` (the unset keeps the worker session's env from redirecting the child; scratch state lives in `.spike/`, deleted after the run). Check (f) has its own faithful re-run: `bun scripts/sdk-spike-settings-mode.ts`.

## Verdict table

| Check | Verdict | Evidence |
|---|---|---|
| (a) real image input | PASS | 16x16 solid red PNG as a base64 `image` block, prompt "What colour is this square? One word." → answer "Red." |
| (b) CLI session + two SDK resumes | PASS on answers, **cost verdict: session-cumulative** | cli `total_cost_usd` 0.6945436; first resume "I replied \"ready\"." cost 1.3964142; second resume cost 2.1037688. 2.1037688 ≥ 0.6945436 + 1.3964142 × 0.9 = 1.9513 — the stop threshold tripped |
| (c) GLM through the SDK | PASS | z.ai token configured; chat profile created under `.spike/glm-profile`; prompt "Reply with the word ready" → "ready" |
| (d) forkSession + resumeSessionAt | PASS | fork point = last assistant uuid `35b78635-…`; fork answered "My first reply was \"ready\"." with a new session id `a81545d2-…` ≠ the original `a695d585-…` |
| (e) ask-rule denial | PASS | inline `settings: { permissions: { ask: ['Bash(touch:*)'] } }` + `settingSources: []` + `permissionMode: 'default'` → canUseTool fired for Bash; deny → `.spike/e-marker` absent and the tool_result `is_error` true |
| (f) 'settings' permission mode | PASS when the derived mode is passed | `~/.claude/settings.json` defaultMode `auto`; passing `permissionMode: 'auto'` (what `settingsPermissionMode` returns) → system/init reported `permissionMode: 'auto'`. Omitting `permissionMode` instead reports `default` — confirming the SDK fact that sdk.mjs always forces `--permission-mode default` unless the option is set, so the bridge must always pass an explicit mode (D2) |
| (g) Bash allow-rule persistence | PASS | process 1 (no ask rule, `settings: {}`): canUseTool fired, answered allow; process 2 resumed with `allowedTools: ['Bash(touch …/.spike/g1)']` → canUseTool did NOT fire and the marker reappeared. Suggestion set observed: `addRules` (destination `localSettings`) + `addDirectories` + `setMode` |
| (h) file-rule persistence | PASS | process 2 resumed with `allowedTools: ['Edit(//…/.spike/h1.txt)']` → canUseTool did NOT fire and the file contained "two" |

## Consequences

- **BRIDGE_ENGINES = ['claude', 'glm']** — GLM answered correctly through the SDK, so both chat engines take the bridge.
- **total_cost_usd is session-cumulative, not per-process.** Each resume continues the transcript's running total (sdk.d.ts documents this: "a resumed or forked session continues from the total its transcript saved, so the first result already carries the earlier turns"). The plan's step-3 D19 rule — costUsd as the *sum* of `total_cost_usd` over every result line in the chat — would double-count every resumed turn; the correct per-chat figure is the *newest* result line's `total_cost_usd`. The plan's task-1 stop condition ("STOP when second ≥ cli + first × 0.9") tripped on this measurement, so the run stops here for a D19 revision instead of building 12 more tasks on the wrong cost rule.
- **The 'Use my settings' mode deviation stands**: the SDK never defers to the settings file's defaultMode on its own, so mode `'settings'` reads `permissions.defaultMode` from the claude config dir server-side and passes it explicitly (missing file / bad JSON / unknown value → `'default'`; `'bypassPermissions'` also sets `allowDangerouslySkipPermissions: true`).
- Spike numbers for the record: cli 0.6945436, first 1.3964142, second 2.1037688 USD (estimates, tiny single-turn prompts).
