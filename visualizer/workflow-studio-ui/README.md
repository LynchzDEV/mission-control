# Workflow Studio design comparison

Unapproved design exploration using the visualize-me skill. This is a standalone Vite/React preview, not a change to Mission Control's running UI.

`npm run dev` serves the preview at http://localhost:51943 with live reload. Run this command from `visualizer/workflow-studio-ui`.

Compare the current Studio with three entry points into the same workflow editor:

- NOW: the current `client/studio.tsx`, copied with static data replacing network access.
- A — Describe: a prominent description field, followed by templates and a blank workflow option.
- B — Canvas: the workflow fills the screen, with optional AI assistance alongside it.
- C — Templates: choose a starting workflow, inspect its steps, and customize it.

All options support searchable step presets, custom instructions, drag/connect, and an optional AI panel. Jev is an example of a user-selected capability, not a built-in task category. Required core rules remain outside workflow editing. History lives behind a secondary control.

All workflow generation, connections, run results, and saved states are illustrative fixtures kept in memory. Nothing invokes an AI, connects an account, writes a workflow, or starts a job. The preview labels this boundary persistently.

## Visual source

- `client/studio.tsx`: current Studio components and existing React Flow integration.
- `public/studio.css`: current Studio layout, fields, task cards, and controls.
- `public/theme-tokens.css`: exact colors, fonts, radius, and spacing tokens.
- `public/theme.css`, `public/terminal-design.css`: actual app chrome and controls.
- `server/views/layout.tsx`: global navigation layout.

## Reference

- https://docs.n8n.io/build/understand-workflows/workflow-components/work-with-nodes
- https://support.n8n.io/article/accessing-the-workflow-builder-with-natural-language-features-in-gshi00exc41aycstsxdbbwz3

No variant has been selected. Record the user's choice and reasons in DECISION.md after design feedback; implementation is a separate task.
