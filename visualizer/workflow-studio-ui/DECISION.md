# Decision: Workflow Studio

**Chosen:** Variant A — describe the workflow first, then edit it on the canvas.

**Why:** The user selected A explicitly: “A. go A all in A. that design take special place in my heart”. The starting screen makes the intended work the first input while keeping presets, templates, and custom instructions available together.

**Real files to touch:** `client/studio.tsx`, `public/studio.css`, `server/routes/studio.ts`, plus the existing job/agent execution seams for real workflow drafting.

**Implementation notes:**
- Keep A's typography, exact MC theme tokens, spacing, large description box, and three starting actions.
- All paths reach one editable canvas. AI changes produce drafts, never execute the proposed workflow.
- Step presets remain fully editable. A custom step is always available; Jev is a user-selected use case, not a special built-in action.
- Keep the AI panel beside the canvas, with clear progress and errors for real generation.
- Preserve versioned workflows, immutable default, prompt revisions, required core rules, custom connections, run evidence, stop, and retry. Move their controls to appropriate secondary views.
- Replace raw JSON in routine editing with labeled controls. Advanced connection details stay available on demand.

**Rejected:** B as the first screen — user chose A's description-led start; retain the shared canvas after creation. C as the first screen — user chose A; keep templates as a secondary entry.

The design session is complete. The user's “go A all in A” authorizes implementation of this selected direction. The standalone visualizer remains a static artifact with simulated interactions.
