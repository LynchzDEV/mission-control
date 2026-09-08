# Mission Control design preview

A disposable design study. Open the existing preview server at <http://127.0.0.1:47831/#a/terminals>.

| Direction | Lanes | Dispatch | Terminals | Review | Settings |
| --- | --- | --- | --- | --- | --- |
| A Workbench | [Lanes](#a/lanes) | [Dispatch](#a/dispatch) | [Terminals](#a/terminals) | [Review](#a/review) | [Settings](#a/settings) |
| B Studio | [Lanes](#b/lanes) | [Dispatch](#b/dispatch) | [Terminals](#b/terminals) | [Review](#b/review) | [Settings](#b/settings) |
| C Console | [Lanes](#c/lanes) | [Dispatch](#c/dispatch) | [Terminals](#c/terminals) | [Review](#c/review) | [Settings](#c/settings) |
| Current source snapshot | [Lanes](#current/lanes) | [Dispatch](#current/dispatch) | [Terminals](#current/terminals) | [Review](#current/review) | [Settings](#current/settings) |

The hash links above are routes for the preview index, not navigation within a Markdown viewer.

Workbench uses a persistent workspace sidebar and worker inspector. Studio uses horizontal navigation, a session index and a wider reading column with workers below. Console uses an icon rail, workspace tabs, terminal/log split and a worker dock. All share the same in-memory data and page renderers.

Everything is simulated: engine availability, model names, usage, timestamps, jobs, progress, code changes, test results, terminal responses and masked settings. No API calls, persistence, credentials, live execution or clipboard writes. Reload resets changes. The Current direction embeds the parent-owned `current/<page>.html` snapshots in a sandboxed iframe; those snapshots remain the original empty state regardless of the sample-state selector.

Implemented interactions:

- Hash navigation preserves the selected page across directions. Keys 1–5 navigate outside editable or interactive controls. Cmd/Ctrl+K opens the searchable command dialog; arrow keys select, Enter opens, Escape closes.
- New terminal and Resume dialogs create/select sample tabs. Thread messages receive a visibly simulated response. Worker selection opens details; Close restores the list.
- Lanes supports status and text filtering, no-results recovery and session selection.
- Dispatch validates title/prompt/custom model, resets model choices on engine change, and adds an in-memory queue item and session. Worktree selection affects the confirmation only.
- Review supports queue/file selection, diff/thread views, thread continuation, marking reviewed, all-clear and sample reset. Copy review command selects a read-only example for manual copying.
- Settings saves role assignments and auto-review in memory. Probe buttons display simulated results. Workspace selection changes preview context only.
- Empty states provide recovery actions. Connection lost displays an inline banner; Retry restores Active. Focus mode has an always-accessible restore control.

Browser rendering, responsive behavior and native-dialog verification are parent-owned. Syntax and the renderer/fixture self-check below can be checked locally without starting a service or installing dependencies. The self-check uses DOM stubs and does not establish visual or browser-interaction correctness.

Run from the repository root:

```sh
node --check visualizer/ui-overhaul/app.js
node <<'JS'
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const nodes = new Map();
const node = () => ({ innerHTML: '', classList: { contains: () => false } });
const document = {
  body: { dataset: {}, classList: { contains: () => false } },
  querySelector: key => { if (!nodes.has(key)) nodes.set(key, node()); return nodes.get(key); },
  querySelectorAll: () => [], addEventListener() {}
};
const context = vm.createContext({ document, location: { hash: '#a/terminals' },
  window: { addEventListener() {} }, structuredClone, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('visualizer/ui-overhaul/app.js', 'utf8'), context);
vm.runInContext(`
  for (const variant of Object.keys(variants)) for (const page of pages) {
    for (const sample of ['active', 'empty', 'lost']) {
      Object.assign(state, { variant, page, sample });
      render();
      if (!app.innerHTML.includes('<main')) throw Error('Missing main: ' + variant + '/' + page);
      if (variant === 'current' && !app.innerHTML.includes('current/' + page + '.html')) throw Error('Wrong snapshot');
    }
  }
  if (new Set(initialSessions.map(s => s.id)).size !== initialSessions.length) throw Error('Duplicate session');
  if (reviewSeeds.some(r => !r.files.length)) throw Error('Empty review fixture');
`, context);
assert.equal(vm.runInContext('escapeHtml("<script>")', context), '&lt;script&gt;');
assert.ok(vm.runInContext('modelOptions("GLM").includes("glm-4.5")', context));
assert.ok(!vm.runInContext('modelOptions("GLM").includes("claude-opus")', context));
console.log('PASS: 60 route/state renders, fixture invariants, escaping and model separation');
JS
```
