export type ShellProps = { workspaceDir: string }

const BODY = `
  <svg class="symbols" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <symbol id="search-icon" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.7"/><path d="m13 13 4 4"/></symbol>
    <symbol id="plus-icon" viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></symbol>
    <symbol id="history-icon" viewBox="0 0 20 20"><path d="M3 7a7 7 0 1 1-1 5M3 3v4h4M10 6v4l3 2"/></symbol>
    <symbol id="arrow-icon" viewBox="0 0 20 20"><path d="M10 16V4M5 9l5-5 5 5"/></symbol>
    <symbol id="agents-icon" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M11 4v12M6 8h2M6 11h2"/></symbol>
    <symbol id="flow-icon" viewBox="0 0 20 20"><rect x="2" y="7" width="5" height="6" rx="1.5"/><rect x="13" y="2" width="5" height="6" rx="1.5"/><rect x="13" y="12" width="5" height="6" rx="1.5"/><path d="M7 10h3V5h3M10 10v5h3"/></symbol>
    <symbol id="close-icon" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></symbol>
    <symbol id="spark-icon" viewBox="0 0 24 24"><path d="m14 3 2.4 6.6L23 12l-6.6 2.4L14 21l-2.4-6.6L5 12l6.6-2.4L14 3ZM5 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"/></symbol>
    <symbol id="lock-icon" viewBox="0 0 20 20"><rect x="4" y="8" width="12" height="9" rx="2"/><path d="M7 8V6a3 3 0 0 1 6 0v2M10 11v3"/></symbol>
    <symbol id="back-icon" viewBox="0 0 20 20"><path d="M16 10H4m5-5-5 5 5 5"/></symbol>
    <symbol id="folder-icon" viewBox="0 0 20 20"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.5 2h6A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5Z"/></symbol>
    <symbol id="check-icon" viewBox="0 0 20 20"><path d="m5 10.5 3.2 3L15 6.5"/></symbol>
    <symbol id="pencil-icon" viewBox="0 0 20 20"><path d="M12.5 4.5 15.5 7.5 7.5 15.5H4.5v-3Z"/></symbol>
    <symbol id="auto-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.5"/></symbol>
    <symbol id="terminal-icon" viewBox="0 0 20 20"><rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="m6 8 2.5 2L6 12M10.5 12H14"/></symbol>
    <symbol id="file-icon" viewBox="0 0 20 20"><path d="M5 2.5h6.5L15 6v11.5H5Z"/><path d="M11.5 2.5V6H15"/></symbol>
    <symbol id="up-icon" viewBox="0 0 20 20"><path d="m5 12 5-5 5 5"/></symbol>
    <symbol id="down-icon" viewBox="0 0 20 20"><path d="m5 8 5 5 5-5"/></symbol>
    <symbol id="pause-icon" viewBox="0 0 20 20"><path d="M7 5v10M13 5v10"/></symbol>
    <symbol id="play-icon" viewBox="0 0 20 20"><path d="M7 4.5v11l9-5.5Z"/></symbol>
    <symbol id="chevron-icon" viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"/></symbol>
    <symbol id="open-icon" viewBox="0 0 20 20"><path d="M11 4h5v5M16 4l-7 7M14 12v3.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H8"/></symbol>
  </svg>
  <canvas id="backdrop" class="backdrop" aria-hidden="true"></canvas>
  <main class="canvas">
    <header class="toolbar">
      <nav aria-label="Chats">
        <button id="search" class="round" aria-pressed="false" aria-label="Search chats" title="Search chats"><svg><use href="#search-icon"/></svg></button>
        <span class="split"><button id="new-chat" class="pill"><svg><use href="#plus-icon"/></svg>New chat</button><button id="new-chat-more" class="caret" popovertarget="new-chat-menu" aria-label="More ways to start" aria-expanded="false"><svg><use href="#chevron-icon"/></svg></button></span>
        <div id="new-chat-menu" popover aria-label="More ways to start"><button class="row" data-live><svg><use href="#terminal-icon"/></svg><span>Terminal<small>Live session with any connected AI</small></span></button></div>
      </nav>
      <nav aria-label="Session activity">
        <section class="usage-card" aria-label="Provider usage">
          <div class="usage-track" id="usage-track"></div>
        </section>
        <button id="open-studio" class="pill" type="button" aria-pressed="false">Studio</button>
        <button id="open-agents" class="round quiet-control" aria-expanded="false" aria-controls="agents" aria-label="Agents" title="Agents"><svg><use href="#agents-icon"/></svg><span id="agents-count" class="count" hidden></span></button>
        <button id="toggle-flow" class="round quiet-control" aria-label="Flow" title="Flow" aria-expanded="false" aria-controls="flow"><svg><use href="#flow-icon"/></svg></button>
        <button id="motion" class="round quiet-control" type="button" aria-pressed="false" aria-label="Pause motion" title="Pause motion"><svg><use id="motion-icon" href="#pause-icon"/></svg></button>
        <button class="round quiet-control" data-dialog="access" aria-label="Access" title="Access"><svg><use href="#lock-icon"/></svg></button>
      </nav>
    </header>

    <div class="workspace">
    <div class="chat-container">
    <section id="flow" class="inline-flow" aria-labelledby="flow-title" aria-hidden="true" inert>
      <div class="flow-inner"><div class="flow-panel content-width">
        <header class="inline-flow-heading"><h2 id="flow-title">Session flow</h2><button id="close-flow" class="round" aria-label="Collapse flow"><svg><use href="#close-icon"/></svg></button></header>
        <div id="live-flow" hidden><p id="live-flow-status" class="muted" role="status"></p><select id="live-flow-select" aria-label="Session work flow" hidden></select><div id="live-flow-steps" class="live-flow-steps" role="list" aria-label="Live session progress"></div></div>
        <div class="activity-empty"><p>Your session’s flow will appear here.</p></div>
        <div class="activity-filled" hidden><ol class="flow-steps" aria-label="Session progress"><li><span class="step-mark">✓</span><strong>Direction</strong><small>Decided</small></li><li class="active-step"><span class="step-mark">•</span><strong>Builder</strong><small>Working</small></li><li><span class="step-mark">○</span><strong>Your review</strong><small>Up next</small></li></ol></div>
      </div></div>
    </section>

    <section id="live" class="live-workspace" aria-label="Live terminals" hidden>
      <div class="with-rail">
        <aside class="rail" id="rail" aria-label="Terminals"><div class="rail-head"><button type="button" class="round rail-toggle" id="rail-toggle" aria-expanded="true" aria-controls="rail" aria-label="Hide the session list" title="Hide the session list"><svg><use href="#back-icon"/></svg></button><span id="rail-count">Terminals</span><button type="button" class="round" id="rail-new" aria-label="New terminal" title="New terminal"><svg><use href="#plus-icon"/></svg></button></div><div id="rail-cards" class="rail-cards"></div><p id="rail-empty" class="muted rail-empty">No terminals yet. Open one with +.</p></aside>
        <div class="live-main" id="live-main">
          <header class="live-heading"><div><h1 id="live-name">Terminal</h1><p id="live-directory" class="muted"></p></div><div class="live-actions"><button id="find-open" class="pill find-open" type="button"><svg aria-hidden="true"><use href="#search-icon"/></svg>Find <kbd id="find-key">⌘F</kbd></button><div class="find" id="find" hidden><input id="find-input" type="text" placeholder="Find" aria-label="Find in this terminal" autocomplete="off"><span id="find-count" role="status"></span><button class="round" id="find-prev" type="button" aria-label="Previous match"><svg><use href="#up-icon"/></svg></button><button class="round" id="find-next" type="button" aria-label="Next match"><svg><use href="#down-icon"/></svg></button><button class="round" id="find-close" type="button" aria-label="Close find"><svg><use href="#close-icon"/></svg></button></div><span id="live-status" role="status">Connecting…</span><button id="live-reconnect" class="text-button" hidden disabled>Reconnect</button></div></header>
          <div class="drop-stage" id="drop-stage" data-dragging="false"><div id="live-stage" class="live-stage"></div><div class="drop-zone right" id="drop-right" data-hot="false">Drop to open beside</div><div class="drop-zone bottom" id="drop-bottom" data-hot="false">Drop to open below</div><div class="drop-over" id="drop-over" hidden><svg class="drop-over-icon"><use href="#file-icon"/></svg><strong id="drop-over-title">Drop to add files</strong><small>Their paths are typed at the prompt · up to 100 MB each</small></div></div>
          <div id="term-park" hidden></div>
          <div class="toast" id="toast" role="status" hidden></div>
        </div>
      </div>
    </section>

    <div class="stage">
      <section id="welcome" class="welcome" aria-labelledby="welcome-title">
        <span class="welcome-mark"><svg><use href="#spark-icon"/></svg></span>
        <h1 id="welcome-title">A little space to build.</h1>
        <p>What would you like to work on?</p>
      </section>

      <section id="history" class="history content-width" aria-labelledby="history-title" hidden>
        <header class="history-heading"><h1 id="history-title">Chats <span id="history-count"></span></h1><label class="search-field"><svg aria-hidden="true"><use href="#search-icon"/></svg><input id="chat-search" type="search" placeholder="Search for chats" aria-label="Search chat history"></label></header>
        <div class="history-list" id="history-list"></div>
        <p id="no-results" class="muted" hidden>No chats found. Try another search.</p>
      </section>

      <section id="conversation" class="conversation content-width" aria-label="Conversation" hidden>
        <div id="messages" class="chat" role="log" aria-live="polite"></div>
      </section>
      <section id="studio" class="studio" aria-label="Workflow Studio" hidden>
        <header class="studio-heading"><div><h1>Studio</h1><p class="muted">Give your AI team a way to work.</p></div><nav id="studio-nav" aria-label="Studio sections"></nav></header>
        <div id="studio-root"></div>
      </section>
    </div>

    <div class="composer-area content-width">
      <div class="popover chip-menu" id="project-menu" role="menu" hidden></div>
      <div class="popover chip-menu model-menu" id="model-menu" role="menu" hidden></div>
      <form id="composer" class="composer nui-neuromorphic-inset">
        <span class="chip-group" id="chip-group" data-expanded="false">
          <button type="button" class="chip" id="project-chip" aria-expanded="false" aria-controls="project-menu" title="Project for this chat"><svg><use href="#folder-icon"/></svg><span id="project-name">Project</span></button>
          <span class="chip-extra" id="chip-extra" inert>
            <button type="button" class="chip" id="model-chip" aria-expanded="false" aria-controls="model-menu" title="AI for this chat"><img id="model-logo" src="/providers/claude.svg" alt=""><span id="model-name">Chat default</span><svg class="caret-sm"><use href="#chevron-icon"/></svg></button>
            <button type="button" class="chip off" id="edit-chip" aria-pressed="false" title="Let the chat edit directly"><svg><use href="#pencil-icon"/></svg></button>
          </span>
        </span>
        <textarea id="message" rows="1" placeholder="Write a message here…" aria-label="Message" required></textarea>
        <button type="submit" class="round send" aria-label="Send message" title="Send message"><svg><use href="#arrow-icon"/></svg></button>
      </form>
    </div>
    </div>

  <dialog id="agents" class="drawer" aria-labelledby="agents-title">
    <header class="dialog-heading"><h2 id="agents-title">Agents</h2><form method="dialog"><button class="round" aria-label="Close agents" autofocus><svg><use href="#close-icon"/></svg></button></form></header>
    <div id="live-agents" hidden><p id="live-agents-status" class="muted" role="status"></p><div id="live-agents-list"></div></div>
    <div class="activity-empty"><p>No agents yet.</p><p class="muted">They’ll appear here when a session starts.</p></div>
    <form id="agent-reply" class="agent-reply" hidden><label for="reply" id="agent-reply-label">Message</label><div class="reply-line"><textarea id="reply" rows="2" placeholder="Add a direction…" required></textarea><button class="round" type="submit" aria-label="Send to this agent"><svg><use href="#arrow-icon"/></svg></button></div></form>
  </dialog>

    </div>
  </main>

  <dialog id="access" class="access-dialog" aria-labelledby="access-title"><header class="dialog-heading"><h2 id="access-title">Access</h2><form method="dialog"><button class="round" aria-label="Close access" autofocus><svg><use href="#close-icon"/></svg></button></form></header><p class="muted">This app answers only on this machine.</p><div class="field-stack"><label>Address<input id="access-host" value="" readonly></label><p class="muted">The API token for scripts and the dispatch skill lives in <a href="/settings">Settings</a>.</p></div></dialog>

  <dialog id="end-session" class="access-dialog confirm-dialog" aria-labelledby="end-session-title">
    <header class="dialog-heading"><h2 id="end-session-title">End this terminal?</h2><form method="dialog"><button class="round" aria-label="Cancel"><svg><use href="#close-icon"/></svg></button></form></header>
    <p id="end-session-text" class="muted">This stops its running process. Its history stays in History.</p>
    <div class="editor-actions dialog-actions"><button type="button" class="pill" id="end-session-cancel">Cancel</button><button type="button" class="pill danger" id="end-session-confirm">End session</button></div>
  </dialog>

  <dialog id="live-launch" class="access-dialog flat" aria-labelledby="live-launch-title">
    <header class="dialog-heading"><h2 id="live-launch-title">Open terminal</h2><form method="dialog"><button class="round" aria-label="Close terminal launcher"><svg><use href="#close-icon"/></svg></button></form></header>
    <p id="live-error" role="status"></p>
    <form id="live-create" class="field-stack" hidden>
      <label>Workflow<select id="live-workflow" disabled></select></label>
      <div id="live-engine-fields" class="launcher-fields"><label>Engine<select id="live-engine"></select></label><label>Model<input id="live-model" list="live-models" placeholder="Engine default" maxlength="100" autocomplete="off"><datalist id="live-models"></datalist></label></div>
      <label>Working directory<input id="live-cwd" placeholder="/path/to/your/project" required autocomplete="off"></label>
      <button id="live-submit" class="pill">Open terminal</button>
    </form>

  </dialog>


  <template id="assistant-row">
    <div class="msg assistant"><span class="avatar"><svg><use href="#spark-icon"/></svg></span><div class="msg-body"><div class="msg-meta"><strong>Mission Control</strong><time>now</time></div></div></div>
  </template>
  <template id="team-card">
    <article class="team-card"><header><strong>Team for this task</strong><span class="muted"></span><button type="button" class="text-button" data-open-agents>Open in Agents <svg><use href="#open-icon"/></svg></button></header><ol></ol><div class="team-progress" hidden><span></span></div></article>
  </template>
  <dialog id="chat-home" class="access-dialog flat" aria-labelledby="chat-home-title">
    <header class="dialog-heading"><h2 id="chat-home-title">Where do your projects live?</h2><form method="dialog"><button class="round" aria-label="Close" type="submit"><svg><use href="#close-icon"/></svg></button></form></header>
    <p class="muted" id="chat-home-why">The chat runs in one folder that holds your projects. It is never your home folder.</p>
    <form id="chat-home-form" class="field-stack"><label>Folder<input id="chat-home-path" type="text" autocomplete="off" spellcheck="false" required></label><div id="chat-home-candidates" class="home-candidates"></div><p id="chat-home-error" class="muted" role="alert"></p><button class="pill" type="submit">Use this folder</button></form>
  </dialog>
`

export function ShellPage(props: ShellProps): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mission Control</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/vendor/xterm.css">
  <link rel="stylesheet" href="/quiet.css">
  <link rel="stylesheet" href="/js/studio.css">
  <script>window.MC_WORKSPACE_DIR=${JSON.stringify(props.workspaceDir)}</script>
  <script src="/js/shell.js" type="module" defer></script>
  <script src="/js/shell-composer.js" type="module" defer></script>
  <script src="/js/chat.js" type="module" defer></script>
  <script src="/js/studio.js" type="module" defer></script>
  <script src="/js/terminals.js" type="module" defer></script>
  <script src="/js/shell-activity.js" type="module" defer></script>
  <script src="/js/usage-card.js" type="module" defer></script>
  <script src="/js/backdrop.js" type="module" defer></script>
</head>
<body>${BODY}</body>
</html>`
}
