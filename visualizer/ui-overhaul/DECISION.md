# Mission Control design approval

Approved on 2026-09-08: `terminal-components.html`, including the uniform provider usage revision. The user said the design was good and the remaining work was implementation compatible with the real functionality.

Keep the dark background and original moving ASCII wave, compact masthead, open two-terminal composition, bottom session strip, flow visualization, and visible sub-agent mini window. Lime identifies the selected/Codex work, coral Claude, and blue sub-agent activity/GLM. Keep the new component structure and restrained colored details; do not transplant old screens into this background.

Usage has three equal provider summaries: prominent 5-hour usage and smaller weekly usage below. All percentages in the mockup are sample data. Real implementation must distinguish estimates, unavailable values, and actual provider reporting; monthly usage must never be labelled weekly.

The visual source is `visualizer/ui-overhaul/terminal-components.html`. Earlier component snapshots are comparison history. Earlier mineral/light application briefs and unfinished application changes are superseded visually. Terminal output and activity samples are replaced by live data; controls must use the existing backend actions.

Real implementation starts at `server/views/layout.tsx`, `server/views/terminals.tsx`, `client/terminal.ts`, `client/agents.ts`, `client/workspace.ts`, `client/flow.ts`, `client/plan-view.ts`, and the shared theme files. Secondary routes must share this identity and preserve their supported actions.
