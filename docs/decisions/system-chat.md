# System chat

The quiet-chat landing page becomes a real chat: you talk to whichever AI is connected, there is no
plan step, and the chat spawns agents on its own when the work needs them. It replaces the old
"switch a terminal to a chat transcript" feature. Decided in a grilling session on 2026-09-24; the
visual decisions are in `docs/design/chat-agent-cards/DECISION.md`.

## Engine

- A chat is a Mission Control job thread (`server/threads.ts`). Each message you send is a reply
  that resumes the same CLI session (`POST /api/jobs/:id/reply`). Only connections that can resume
  can run a chat: built-in Claude/Codex/GLM, CLI connections with a `{{session}}` slot, ACP agents
  with `loadSession`.
- The chat is a new job purpose with no workflow and no git requirement on its folder.
- No role default: the composer's AI chip picks the chat's AI, and a new chat starts with the AI
  used last. (The planned Chat role and all Work defaults were dropped.)

## Folders

- The chat always runs in **Chat home** and never moves; Claude sessions are stored per folder, so
  moving would lose the conversation.
- Chat home defaults to the deepest folder shared by every known project (job, terminal and recent
  directories). It is never `~`: when the shared folder is `~` or there is no history, the first
  chat asks where projects live. Editable in Settings; must stay under `$HOME`.
- The chat detects the project from your message and shows it as the composer's folder chip.
  When unsure it asks rather than guessing. Spawned agents run in that project in isolated
  worktrees; Agents and Flow link them to the chat by thread, not by folder.

## Autonomy

- **Without asking:** read, search, answer, spawn agents, reply to and stop its own agents, and
  retry a failed step, each time on a different AI — 3 attempts per step in total (the server refuses a 4th).
- **Landing is automatic:** once the cross-family review passes, the chat cherry-picks the work onto
  the branch itself (`POST /api/jobs/:id/land`), exactly as mc-dispatch does from a terminal.
- **Always your click:** pushing, deploying, anything touching production, deleting outside a
  worktree.
- **Direct edits:** read-only by default. A per-chat toggle (pencil chip) lets the chat edit
  directly, only inside the chosen project, never elsewhere in Chat home. Each edit appears as an
  "Edited directly" card with its diff and Undo. These edits skip review and landing by design.
  Direct-edit off is enforced by the tool deny list on Claude and GLM and by the rules text only on Codex and shell writes.
- **No spawn limit.** The chat still avoids providers close to their 5-hour or weekly limit
  (`/api/quota`).

## Team

- The chat composes the team per task. Fixed rule: any code change gets a review from a different
  AI family before it can land. Naming a Studio workflow makes the chat follow it instead.
- Engine choice per agent is the chat's, guided by one-line strengths per connection and live
  usage. Every spawn states its reason ("GLM · glm-5.3 — many small edits"); you can override in
  chat.

## Conversation

- Spawned work appears as one team card per reply (see the visual decision).
- While replying: one quiet activity line updates in place, the answer streams, then the line
  collapses to "Worked 18s · read 4 files" and expands on click. Data comes from
  `/api/jobs/:id/stream`.
- An agent's question, blocker or failure is relayed as a chat message and its row shows
  **Needs you**. Answer in the chat or in the Agents drawer; both forward to the same job.
- Shared memory: each chat receives a running summary of recent chats and agents in the **same
  project** only.
- Title: taken from the first message, then renamed once automatically after 5-6 messages. A title
  you set yourself is never replaced.

## Around the chat

- **History** is one list: chats, live terminals, resumable Claude history and outside sessions,
  each labelled. Sessions started by Mission Control's own agents are excluded from outside
  sessions (fixes the current bug where spawned agents appear there).
- **Composer:** folder chip, text, send. No + button, no history icon. The folder chip is
  collapsible; opening it reveals the AI/model chip and the pencil chip.
- **New chat** is a split button: click starts a chat, the arrow offers Terminal, which opens the
  launcher.
- **Notifications:** History dots (running / needs you or landed, with a count) and a count
  on the Agents button. A macOS notification (`server/notify.ts`) only for "needs you" and
  "landed".
