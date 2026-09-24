'use strict';

const pages = ['lanes', 'dispatch', 'terminals', 'review', 'settings'];
const variants = { current: 'Current', a: 'A Workbench', b: 'B Studio', c: 'C Console' };
const models = { Claude: ['claude-opus-4-1', 'claude-sonnet-4'], GLM: ['glm-4.5', 'glm-4.5-air'], Codex: ['gpt-6-astra', 'gpt-5.6-terra'] };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const title = value => value[0].toUpperCase() + value.slice(1);
const initialSessions = [
  { id: 'models', name: 'Live model lists', engine: 'Claude', model: 'claude-opus-4-1', repo: 'mission-control', step: 'Implement', status: 'Running', prompt: 'Replace hardcoded model lists with a shared model picker. Keep the default model option and preserve custom model input.', reply: 'The shared picker now owns engine-specific options. Changing engines clears the previous model, and custom input stays explicit.' },
  { id: 'profiles', name: 'Worker profile isolation', engine: 'Codex', model: 'gpt-6-astra', repo: 'mission-control', step: 'Review', status: 'Running', prompt: 'Check worker profile isolation and the auto-review opt-in behavior.', reply: 'The sample review follows the environment boundary into the worker launcher. Auto-review remains off unless explicitly enabled.' },
  { id: 'drop', name: 'Terminal file paths', engine: 'GLM', model: 'glm-4.5', repo: 'mission-control', step: 'Verify', status: 'Done', prompt: 'Verify that dropped file paths remain correctly quoted in the terminal composer.', reply: 'Paths with spaces and apostrophes are covered by the sample verification. The composer retains the original path.' }
];
const reviewSeeds = [
  { id: 'picker', name: 'Shared model picker', engine: 'Claude', files: ['client/model-picker.ts', 'test/views.test.ts'] },
  { id: 'isolation', name: 'Worker profile isolation', engine: 'Codex', files: ['server/engines.ts', 'test/engines.test.ts'] },
  { id: 'paths', name: 'Terminal drop paths', engine: 'GLM', files: ['client/terminal.ts', 'test/terminal.test.ts'] }
];
const state = { variant: 'a', page: 'terminals', sample: 'active', sessions: structuredClone(initialSessions), session: 'models', worker: null, queue: [], reviews: structuredClone(reviewSeeds), review: 'picker', file: 0, reviewTab: 'diff', query: '', filter: 'all', workspace: 'main', roles: { Plan: { engine: 'Claude', model: '' }, Execute: { engine: 'Codex', model: 'gpt-6-astra' }, Review: { engine: 'Codex', model: '' } }, autoReview: false, messages: {}, reviewMessages: {} };
const app = document.querySelector('#app');
const toolbar = document.querySelector('#preview-toolbar');
const iconPaths = { lanes: 'M3 5h18M3 12h18M3 19h18M8 3v4M16 10v4M10 17v4', dispatch: 'm4 4 17 8-17 8 4-8-4-8Zm4 8h13', terminals: 'm4 6 6 6-6 6M13 18h7', review: 'm5 12 4 4L19 6M4 3h16v18H4z', settings: 'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4' };
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.terminals}"/></svg>`;
const button = (label, action, extra = '') => `<button type="button" data-action="${action}" ${extra}>${label}</button>`;
const currentSessions = () => state.sample === 'empty' ? [] : state.sessions;
const selectedSession = () => state.sessions.find(session => session.id === state.session) || state.sessions[0];
const selectedReview = () => state.reviews.find(review => review.id === state.review) || state.reviews[0];
function notify(message) {
  const feedback = document.querySelector('#feedback');
  feedback.textContent = message;
  feedback.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => feedback.classList.remove('visible'), 4500);
}
function navigate(page, variant = state.variant) {
  location.hash = `${variant}/${page}`;
}
function nav() {
  return `<nav class="nav" aria-label="Main navigation">${pages.map((page, i) => `<a href="#${state.variant}/${page}" title="${title(page)}" aria-label="${title(page)}" ${state.page === page ? 'aria-current="page"' : ''}>${icon(page)}<span>${title(page)}</span><kbd>${i + 1}</kbd></a>`).join('')}</nav>`;
}
function projectIndex() {
  return `<div class="project-index"><small>Sample sessions</small>${currentSessions().map(session => button(escapeHtml(session.name), 'session', `class="quiet" data-id="${session.id}"`)).join('') || '<small>No sessions yet</small>'}</div>`;
}
function renderToolbar() {
  toolbar.innerHTML = `<div class="preview-bar"><div class="preview-brand"><strong>Mission Control</strong><span class="muted">Design preview</span></div><nav class="variant-tabs" aria-label="Design direction">${Object.entries(variants).map(([key, label]) => `<a href="#${key}/${state.page}" ${state.variant === key ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav><div class="preview-options"><label><span>Sample state</span><select id="sample-state" aria-label="Sample state">${[['active', 'Active'], ['empty', 'Empty'], ['lost', 'Connection lost']].map(([value, label]) => `<option value="${value}" ${state.sample === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><details class="sample-details"><summary>Sample data</summary><p>All jobs, messages, credentials and connection results are simulated. Changes last only until reload.</p></details>${button('Focus', 'focus')}${button('Search', 'palette', 'aria-label="Open command palette"')}</div></div>${document.body.classList.contains('presentation') ? button('Restore preview toolbar', 'focus', 'class="focus-restore"') : ''}`;
}
function empty(heading, description, action = 'new-terminal', label = 'New sample terminal') {
  return `<section class="panel empty"><h2>${heading}</h2><p>${description}</p>${button(label, action, 'class="primary"')}</section>`;
}
function plan(session = selectedSession()) {
  return `<div class="plan"><h3>${escapeHtml(session?.name || 'Sample plan')}</h3><ol>${['Spec', 'Implement', 'Review', 'Verify'].map(step => `<li class="${step === session?.step ? 'current' : ''}">${step}${step === session?.step ? ' · current sample step' : ''}</li>`).join('')}</ol></div>`;
}
function inspector() {
  const worker = state.sessions.find(session => session.id === state.worker);
  if (worker) return `<aside class="panel inspector inspector-detail"><div class="panel-head"><h2>Job detail</h2>${button('Close', 'close-worker')}</div><div class="plan"><small>${worker.engine} · ${worker.status} · simulated</small><h3>${escapeHtml(worker.name)}</h3><p>${escapeHtml(worker.reply)}</p></div>${plan(worker)}</aside>`;
  return `<aside class="panel inspector"><div class="panel-head"><h2>Workers</h2><small>Sample</small></div>${state.sessions.slice(0, 3).map((session, i) => button(`<span class="worker-meta"><span class="${session.engine.toLowerCase()}">${session.engine} · ${session.status}</span><span>${['02:14', '04:38', '08:10'][i]}</span></span><strong>${escapeHtml(session.name)}</strong><small>${session.step} · ${i === 2 ? 'Checks passed' : 'Working through sample plan'}</small><span class="progress"><i style="width:${[65, 80, 100][i]}%"></i></span>`, 'worker', `class="worker" data-id="${session.id}"`)).join('')}${plan()}</aside>`;
}
function terminals() {
  if (!currentSessions().length) return empty('No sample terminals', 'Create a terminal or resume an existing sample session.') + `<div class="below">${button('Resume sample session', 'resume')}</div>`;
  const session = selectedSession();
  return `<div class="terminal-layout"><section class="panel"><div class="session-tabs" aria-label="Terminal sessions">${state.sessions.map(item => button(escapeHtml(item.name), 'session', `class="${item.id === session.id ? 'selected' : ''}" aria-pressed="${item.id === session.id}" data-id="${item.id}"`)).join('')}${button('+ New', 'new-terminal')}</div><div class="thread"><article class="message"><div class="avatar">You</div><div><div class="message-meta"><strong>You</strong><small>Sample prompt · 14:02</small></div><p>${escapeHtml(session.prompt)}</p></div></article><article class="message"><div class="avatar ${session.engine.toLowerCase()}">${session.engine[0]}</div><div><div class="message-meta"><strong class="${session.engine.toLowerCase()}">${session.engine}</strong><small>Simulated response</small></div><p>${escapeHtml(session.reply)}</p><div class="tools">${['Read · client/model-picker.ts', 'Edit · server/views/terminals.tsx', 'Check · test/views.test.ts'].map((tool, i) => `<details class="tool"><summary>${tool}</summary><code>${['Read 84 sample lines. Default and custom options share one renderer.', 'Replaced the sample datalist with the shared ModelPicker control.', 'Sample check completed: engine changes reset the model selection.'][i]}</code></details>`).join('')}</div><pre><code>const model = engineChanged ? '' : selectedModel;
renderModelPicker({ engine, model });</code></pre><p class="test-pass">✓ Sample checks · 14 passed · 0 failed</p></div></article>${(state.messages[session.id] || []).map(message => `<article class="message"><div class="avatar">You</div><div><small>Preview message</small><p>${escapeHtml(message)}</p><p class="muted">Sample reply: added to this preview thread. No engine was contacted.</p></div></article>`).join('')}</div><form class="composer" id="composer"><label class="field">Continue sample thread<textarea name="message" required placeholder="Describe the next change…"></textarea></label><div class="composer-footer"><small>${session.engine} / ${escapeHtml(session.model || 'Default')} · simulated</small><button class="primary">Send preview</button></div></form></section><aside class="panel console-log"><div class="panel-head"><h2>Sample log</h2></div><pre>14:02:11  session opened
14:02:12  ${session.engine} ready
14:02:18  reading model-picker.ts
14:03:02  patch prepared
14:03:45  checks passed
14:04:25  awaiting input

No live process connected.</pre></aside>${inspector()}</div>`;
}
function activity() {
  return `<section class="panel"><div class="panel-head"><h2>Sample activity</h2></div><div class="activity"><p><time>14:04</time><span>${escapeHtml(selectedSession()?.name || 'Session')} moved to ${selectedSession()?.step || 'Spec'}.</span></p><p><time>14:03</time><span>Shared picker checks passed.</span></p><p><time>14:02</time><span>Sample worker joined mission-control.</span></p></div></section>`;
}
function laneResults() {
  const sessions = currentSessions().filter(session => `${session.name} ${session.repo} ${session.engine}`.toLowerCase().includes(state.query.toLowerCase()) && (state.filter === 'all' || session.status === state.filter));
  return sessions.length ? `<div class="panel">${sessions.map(session => button(`<span><strong>${escapeHtml(session.name)}</strong><small>${session.repo}</small></span><span>${session.step}</span><span>${session.status}</span><span class="${session.engine.toLowerCase()}">${session.engine}</span>`, 'lane', `class="lane-row ${state.session === session.id ? 'selected' : ''}" aria-pressed="${state.session === session.id}" data-id="${session.id}"`)).join('')}<div class="flow" aria-label="Selected session progress">${['Spec', 'Implement', 'Review', 'Verify'].map((step, i) => `${i ? '<i aria-hidden="true"></i>' : ''}<span>${selectedSession().step === step ? `<b>${step} · now</b>` : step}</span>`).join('')}</div></div><div class="split below"><section class="panel">${plan()}</section>${activity()}</div>` : empty('No matching sessions', 'Try another name, engine or status.', 'clear-search', 'Clear filters');
}
function lanes() {
  if (!currentSessions().length) return empty('Your sample workspace is clear', 'Start a preview job to see its session move through the lanes.', 'dispatch', 'Create preview job');
  return `<p class="section-note">${state.sessions.filter(session => session.status === 'Running').length} sample sessions in progress. Follow the work from specification to verification.</p><div class="filters"><input id="lane-search" aria-label="Search sessions" placeholder="Search sessions or engines…" value="${escapeHtml(state.query)}"><select id="lane-filter" aria-label="Session status">${[['all', 'All sessions'], ['Running', 'Running'], ['Done', 'Done']].map(([value, label]) => `<option value="${value}" ${value === state.filter ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div id="lane-results">${laneResults()}</div><div class="quotas" aria-label="Simulated engine usage">${Object.keys(models).map((engine, i) => `<div class="quota"><span>${engine}</span><meter min="0" max="100" value="${[34, 12, 57][i]}" aria-label="${engine} sample quota used">${[34, 12, 57][i]}%</meter><span>${[34, 12, 57][i]}% used · sample quota</span></div>`).join('')}</div>`;
}
function modelOptions(engine, selected = '') {
  return [['', 'Default model'], ...models[engine].map(model => [model, model]), ['custom', 'Custom model…']].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}
function modelPair(prefix, engine = 'Claude', model = '') {
  const custom = model && !models[engine].includes(model);
  return `<div class="model-pair" data-pair="${prefix}"><label class="field">Engine<select name="${prefix}engine" data-engine>${Object.keys(models).map(value => `<option ${value === engine ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="field">Model<select name="${prefix}model" data-model>${modelOptions(engine, custom ? 'custom' : model)}</select></label><label class="field custom-field" ${custom ? '' : 'hidden'}>Custom model<input name="${prefix}custom" value="${custom ? escapeHtml(model) : ''}" ${custom ? 'required' : 'disabled'} placeholder="Sample model name"></label></div>`;
}
function jobQueue() {
  const jobs = state.sample === 'empty' ? [] : [...state.queue, ...initialSessions];
  return `<aside class="panel"><div class="panel-head"><h2>Queue & recent jobs</h2><small>Simulated</small></div>${jobs.map(job => `<div class="list-row"><div><strong>${escapeHtml(job.name)}</strong><small>${job.engine} · ${escapeHtml(job.repo)}</small></div><small>${job.status}</small></div>`).join('') || '<div class="empty"><h3>No sample jobs queued</h3><p>Your preview job will appear here.</p></div>'}</aside>`;
}
function dispatch() {
  return `<div class="split"><form id="dispatch-form" class="panel"><div class="panel-head"><h2>Job brief</h2><small>Preview only</small></div><div class="form-body"><label class="field">Title<input name="name" required placeholder="e.g. Simplify model selection"></label><label class="field">Prompt<textarea class="job-prompt" name="prompt" required placeholder="Describe the change and how you will know it works…"></textarea></label><label class="field">Repository<select name="repo"><option>mission-control</option><option>sample-api</option></select></label>${modelPair('job-')}<label class="check"><input type="checkbox" name="worktree" checked>Use isolated sample worktree</label><small>GLM · sample off-peak window available. No live availability check.</small><button class="primary">Launch preview job</button></div></form>${jobQueue()}</div>`;
}
function diffLines(review, file) {
  if (file.includes('test/')) return ['@@ sample check @@', ' describe("' + review.name + '", () => {', '-  expect(options).toContain(previousModel);', '+  expect(options).toContain("Default model");', '+  expect(selectedModel).toBe("");', ' });'];
  if (review.id === 'isolation') return ['@@ worker environment @@', ' const env = { ...process.env };', '- env.CLAUDE_SESSION_ID = parentSession;', '+ delete env.CLAUDE_SESSION_ID;', '+ env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";', ' return env;'];
  if (review.id === 'paths') return ['@@ dropped file paths @@', '- composer.value += file.path;', '+ const quotedPath = quoteShellPath(file.path);', '+ composer.value += quotedPath;', ' composer.focus();'];
  return ['@@ shared model selection @@', '- const options = hardcodedModels;', '+ const options = modelLists[engine] ?? [];', '+ const nextModel = engineChanged ? "" : model;', ' return ModelPicker({', '+   options, model: nextModel, allowCustom: true,', ' });'];
}
function reviewPage() {
  if (state.sample === 'empty' || !state.reviews.length) return empty('All clear', 'No sample changes are waiting for review.', 'reset-reviews', 'Reset sample reviews');
  const review = selectedReview();
  const file = review.files[state.file] || review.files[0];
  return `<div class="review-layout"><aside class="panel review-list" aria-label="Sample review queue">${state.reviews.map(item => button(`<strong>${item.name}</strong><small>${item.engine} · ${item.files.length} files</small><small>Awaiting sample review</small>`, 'select-review', `data-id="${item.id}" class="${review.id === item.id ? 'selected' : ''}" aria-pressed="${review.id === item.id}"`)).join('')}</aside><section class="panel"><div class="panel-head"><div><h2>${review.name}</h2><small>Sample diff · mission-control / preview-${review.id}</small></div></div><div class="session-tabs">${['diff', 'thread'].map(tab => button(title(tab), 'review-tab', `data-tab="${tab}" class="${state.reviewTab === tab ? 'selected' : ''}" aria-pressed="${state.reviewTab === tab}"`)).join('')}</div>${state.reviewTab === 'diff' ? `<div class="diff-layout"><nav class="file-tree" aria-label="Changed files">${review.files.map((name, i) => button(escapeHtml(name), 'review-file', `data-index="${i}" class="${name === file ? 'selected' : ''}" aria-pressed="${name === file}"`)).join('')}</nav><pre class="diff" aria-label="Sample changes to ${escapeHtml(file)}"><code>${diffLines(review, file).map(line => `<span class="${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : ''}">${escapeHtml(line)}</span>`).join('')}</code></pre></div>` : `<div class="thread"><p><strong>${review.engine}</strong> · Simulated review thread</p><p>Prepared ${review.name.toLowerCase()} for review. Check the changed behavior and the matching regression case.</p>${(state.reviewMessages[review.id] || []).map(message => `<p><strong>You · sample</strong><br>${escapeHtml(message)}</p>`).join('')}</div><form id="review-thread" class="composer"><label class="field">Continue sample review<textarea name="message" required></textarea></label><div class="composer-footer"><small>No reviewer is contacted.</small><button>Send preview</button></div></form>`}<div class="review-actions">${button('Copy review command', 'copy-command')}${button('Mark reviewed · preview', 'mark-reviewed', 'class="primary"')}</div><div id="command-example" class="command-example" hidden></div></section></div>`;
}
function settings() {
  return `<form id="settings-form" class="settings"><section class="settings-section"><h2>Role assignments</h2><div class="panel">${Object.entries(state.roles).map(([role, value]) => `<div class="setting-row"><div><strong>${role}</strong><small>Sample engine and model</small></div>${modelPair(role + '-', value.engine, value.model)}</div>`).join('')}<div class="setting-row"><div><strong>Auto-review</strong><small>Off by default</small></div><label class="check"><input name="autoReview" type="checkbox" ${state.autoReview ? 'checked' : ''}>Review completed sample jobs automatically</label></div></div></section><section class="settings-section"><h2>Connections</h2><div class="panel">${Object.keys(models).map(engine => `<div class="setting-row"><strong>${engine}</strong><div class="connection"><span>${state.sample === 'empty' ? 'Not configured' : state.sample === 'lost' ? 'Unavailable' : 'Ready'} · simulated</span>${button('Probe preview', 'probe', `data-engine-name="${engine}"`)}</div></div>`).join('')}</div></section><section class="settings-section"><h2>Workspace settings</h2><div class="panel"><div class="setting-row"><strong>Endpoint</strong><code>local-preview.invalid</code></div><div class="setting-row"><strong>Credential</strong><div><code>•••• •••• ••••</code><small>Illustrative mask. No credential stored or requested.</small></div></div></div></section><button class="primary">Save changes · preview</button><p class="muted below">Assignments stay in memory until this preview is reloaded.</p></form>`;
}
function render() {
  document.body.dataset.variant = state.variant === 'current' ? 'a' : state.variant;
  renderToolbar();
  const renderers = { terminals, lanes, dispatch, review: reviewPage, settings };
  const source = state.page === 'lanes' ? 'lanes' : state.page;
  const content = state.variant === 'current' ? `<p class="section-note">Current UI · source snapshot / empty state. Original server-rendered markup; client behavior disabled. Sample state controls apply to the design directions.</p><iframe class="current-frame" title="Current ${title(state.page)} UI source snapshot, empty state" src="current/${state.page}.html" sandbox></iframe>` : renderers[state.page]();
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><svg class="mark" viewBox="0 0 28 28" aria-hidden="true"><path d="M3 23V5l11 12L25 5v18M8 23v-7l6 6 6-6v7"/></svg><span>Mission Control</span></div><label class="field workspace"><span class="muted">Workspace</span><select id="workspace"><option value="main" ${state.workspace === 'main' ? 'selected' : ''}>mission-control / main</option><option value="preview" ${state.workspace === 'preview' ? 'selected' : ''}>mission-control / preview</option></select></label>${nav()}${projectIndex()}<div class="engine-health">${Object.keys(models).map(engine => `<div class="engine-row"><span>${engine}</span><span>${state.sample === 'lost' ? 'Offline' : state.sample === 'empty' ? 'Idle' : '● Ready'}</span></div>`).join('')}</div><div class="operator">Palm <span class="muted">/ sample workspace</span></div></aside><main class="main"><div class="console-workspaces" aria-label="Sample workspaces">${['main', 'preview'].map(name => button(`mission-control / ${name}`, 'workspace', `data-name="${name}" aria-pressed="${state.workspace === name}"`)).join('')}</div><header class="topbar"><div><div class="breadcrumb">mission-control / ${state.workspace} · Sample data</div><h1>${title(state.page)}</h1></div><div class="actions">${button('Search ⌘K', 'palette', 'class="quiet search-button"')}${state.page === 'terminals' ? button('New terminal', 'new-terminal', 'class="primary"') : state.page === 'lanes' ? button('New preview job', 'dispatch', 'class="primary"') : ''}</div></header>${state.sample === 'lost' && state.variant !== 'current' ? `<div class="banner" role="status"><span>Sample connection lost. Displaying simulated last-known content.</span>${button('Retry', 'retry')}</div>` : ''}<div class="content ${['terminals', 'lanes'].includes(state.page) && state.variant !== 'current' ? 'studio-content' : ''}">${['terminals', 'lanes'].includes(state.page) && state.variant !== 'current' ? `<aside class="studio-index">${projectIndex()}</aside>` : ''}<div class="page-content">${content}</div></div><div class="status-strip"><span>${state.sample === 'lost' ? 'Offline' : 'Connected'} · simulated connection</span><span>${state.workspace} · Claude 34% / GLM 12% / Codex 57% · sample usage</span></div><footer class="source-footer"><details><summary>Workflow source references</summary><code>server/views/${source}.tsx · server/views/layout.tsx · public/theme-tokens.css</code><p>Design study with illustrative fixtures. Current embeds parent-provided source snapshots.</p></details></footer></main></div>`;
}
function readRoute() {
  const [variant, page] = location.hash.slice(1).split('/');
  state.variant = Object.hasOwn(variants, variant) ? variant : 'a';
  state.page = pages.includes(page) ? page : 'terminals';
  render();
}
window.addEventListener('hashchange', readRoute);
readRoute();

const dialogOpeners = new WeakMap();
function openDialog(dialog) {
  dialogOpeners.set(dialog, document.activeElement);
  dialog.showModal();
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => {
    if (document.querySelector('dialog[open]')) return;
    const dialogOpener = dialogOpeners.get(dialog);
    if (dialogOpener?.isConnected) dialogOpener.focus();
    else document.querySelector('.topbar button')?.focus();
  });
}
function terminalDialog(resume = false) {
  const dialog = document.querySelector('#terminal-dialog');
  dialog.innerHTML = `<div class="panel-head"><h2 id="terminal-dialog-title">${resume ? 'Resume sample session' : 'New sample terminal'}</h2>${button('Close', 'close-dialog')}</div><form id="terminal-form" class="form-body" data-resume="${resume}">${resume ? `<label class="field">Existing sample session<select name="resumeId">${initialSessions.map(session => `<option value="${session.id}">${session.name}</option>`).join('')}</select></label>` : `<label class="field">Session name<input name="name" required maxlength="80" autofocus placeholder="e.g. Review model picker"></label><label class="field">Repository<select name="repo"><option>mission-control</option><option>sample-api</option></select></label>${modelPair('terminal-')}`}<small>Creates an in-memory preview tab. No process starts.</small><button class="primary">${resume ? 'Resume sample' : 'Create sample terminal'}</button>${button(resume ? 'Create new instead' : 'Resume existing sample', resume ? 'new-terminal' : 'resume')}</form>`;
  if (!dialog.open) openDialog(dialog);
}
const commands = [...pages.map(page => ({ label: `Go to ${title(page)}`, page })), { label: 'New terminal', action: 'new-terminal' }, { label: 'Resume sample session', action: 'resume' }, { label: 'Dispatch preview job', page: 'dispatch' }];
let commandIndex = 0;
let filteredCommands = commands;
function commandResults(query = '') {
  filteredCommands = commands.filter(command => command.label.toLowerCase().includes(query.toLowerCase()));
  commandIndex = Math.min(commandIndex, Math.max(0, filteredCommands.length - 1));
  document.querySelector('#command-results').innerHTML = filteredCommands.length ? filteredCommands.map((command, index) => button(escapeHtml(command.label), 'command', `data-index="${index}" class="${index === commandIndex ? 'selected' : ''}" ${index === commandIndex ? 'aria-current="true"' : ''}`)).join('') : `<p class="muted">No commands match.</p>${button('Clear search', 'clear-commands')}`;
}
function palette() {
  const dialog = document.querySelector('#palette');
  dialog.innerHTML = `<div class="panel-head"><h2 id="palette-title">Go anywhere</h2>${button('Close', 'close-dialog')}</div><div class="palette-body"><label class="field">Search pages and actions<input id="command-search" autocomplete="off" placeholder="Try terminals or new…" aria-describedby="command-help"></label><small id="command-help">↑ ↓ to choose · Enter to open · Escape to close</small><div id="command-results" class="command-list"></div></div>`;
  commandIndex = 0;
  commandResults();
  openDialog(dialog);
  document.querySelector('#command-search').focus();
}
function runCommand(index) {
  const command = filteredCommands[index];
  if (!command) return;
  document.querySelector('#palette').close();
  if (command.page) navigate(command.page, state.variant === 'current' ? 'a' : state.variant);
  else terminalDialog(command.action === 'resume');
}
function formModel(data, prefix) {
  return data.get(prefix + 'model') === 'custom' ? data.get(prefix + 'custom').trim() : data.get(prefix + 'model');
}
function activeDesign() {
  state.sample = 'active';
  if (state.variant === 'current') state.variant = 'a';
}
function refreshAt(page) {
  navigate(page);
  state.page = page;
  render();
}
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  switch (action) {
    case 'palette': palette(); break;
    case 'command': runCommand(Number(target.dataset.index)); break;
    case 'clear-commands':
      document.querySelector('#command-search').value = '';
      commandResults();
      document.querySelector('#command-search').focus();
      break;
    case 'close-dialog': target.closest('dialog').close(); break;
    case 'new-terminal': terminalDialog(); break;
    case 'resume': terminalDialog(true); break;
    case 'focus':
      document.body.classList.toggle('presentation');
      renderToolbar();
      document.querySelector('[data-action="focus"]').focus();
      break;
    case 'session':
      state.session = target.dataset.id;
      refreshAt('terminals');
      break;
    case 'lane': state.session = target.dataset.id; render(); break;
    case 'worker': state.worker = target.dataset.id; render(); break;
    case 'close-worker': state.worker = null; render(); break;
    case 'dispatch': navigate('dispatch', state.variant === 'current' ? 'a' : state.variant); break;
    case 'retry': state.sample = 'active'; render(); notify('Sample connection restored. No network request was made.'); break;
    case 'clear-search': state.query = ''; state.filter = 'all'; render(); document.querySelector('#lane-search')?.focus(); break;
    case 'select-review': state.review = target.dataset.id; state.file = 0; render(); break;
    case 'review-tab': state.reviewTab = target.dataset.tab; render(); break;
    case 'review-file': state.file = Number(target.dataset.index); render(); break;
    case 'mark-reviewed': {
      const review = selectedReview();
      state.reviews = state.reviews.filter(item => item.id !== review.id);
      state.review = state.reviews[0]?.id;
      state.file = 0;
      render();
      notify(`${review.name} marked reviewed in this preview.`);
      break;
    }
    case 'reset-reviews': activeDesign(); state.reviews = structuredClone(reviewSeeds); state.review = 'picker'; state.file = 0; render(); break;
    case 'copy-command': {
      const example = document.querySelector('#command-example');
      example.hidden = false;
      example.innerHTML = `<label class="field">Read-only example · copy manually<input readonly value="git diff main...preview-${selectedReview().id}" aria-label="Example review command"></label><small>This preview does not execute commands or access your clipboard.</small>`;
      example.querySelector('input').focus();
      example.querySelector('input').select();
      notify('Example selected. Use your browser’s copy command.');
      break;
    }
    case 'probe':
      target.parentElement.querySelector('span').textContent = 'Probe passed · simulated';
      notify(`${target.dataset.engineName}: sample probe passed. No connection attempted.`);
      break;
    case 'workspace': state.workspace = target.dataset.name; render(); notify('Sample workspace changed.'); break;
  }
});
document.addEventListener('input', event => {
  if (event.target.id === 'lane-search') {
    state.query = event.target.value;
    document.querySelector('#lane-results').innerHTML = laneResults();
  }
  if (event.target.id === 'command-search') {
    commandIndex = 0;
    commandResults(event.target.value);
  }
});
document.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'sample-state') {
    state.sample = target.value;
    render();
  }
  if (target.id === 'workspace') { state.workspace = target.value; render(); notify('Sample workspace changed.'); }
  if (target.id === 'lane-filter') {
    state.filter = target.value;
    document.querySelector('#lane-results').innerHTML = laneResults();
  }
  if (target.matches('[data-engine]')) {
    const pair = target.closest('[data-pair]');
    pair.querySelector('[data-model]').innerHTML = modelOptions(target.value);
    pair.querySelector('.custom-field').hidden = true;
    const custom = pair.querySelector('input');
    custom.value = '';
    custom.disabled = true;
    custom.required = false;
  }
  if (target.matches('[data-model]')) {
    const field = target.closest('[data-pair]').querySelector('.custom-field');
    field.hidden = target.value !== 'custom';
    field.querySelector('input').disabled = field.hidden;
    field.querySelector('input').required = !field.hidden;
    if (!field.hidden) field.querySelector('input').focus();
  }
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (!['dispatch-form', 'terminal-form', 'composer', 'review-thread', 'settings-form'].includes(form.id)) return;
  event.preventDefault();
  for (const input of form.querySelectorAll('input[required], textarea[required]')) {
    if (!input.disabled && !input.value.trim()) {
      input.setCustomValidity('Enter text, not only spaces.');
      input.reportValidity();
      input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
      return;
    }
  }
  const data = new FormData(form);
  if (form.id === 'terminal-form') {
    if (form.dataset.resume === 'true') {
      const original = initialSessions.find(session => session.id === data.get('resumeId'));
      if (!state.sessions.some(session => session.id === original.id)) state.sessions.push(structuredClone(original));
      state.session = original.id;
    } else {
      const id = `session-${Date.now()}`;
      state.sessions.push({ id, name: data.get('name').trim(), engine: data.get('terminal-engine'), model: formModel(data, 'terminal-'), repo: data.get('repo'), step: 'Spec', status: 'Running', prompt: 'A new sample terminal is ready for your brief.', reply: 'Describe a change below to add it to this in-memory preview thread.' });
      state.session = id;
    }
    document.querySelector('#terminal-dialog').close();
    activeDesign();
    refreshAt('terminals');
    notify('Sample terminal opened. No process started.');
  }
  if (form.id === 'dispatch-form') {
    const id = `job-${Date.now()}`;
    const job = { id, name: data.get('name').trim(), prompt: data.get('prompt').trim(), engine: data.get('job-engine'), model: formModel(data, 'job-'), repo: data.get('repo'), status: 'Queued', step: 'Spec', worktree: data.has('worktree'), reply: 'This preview job is queued in memory. No worker will execute it.' };
    state.queue.unshift(job);
    state.sessions.push(job);
    activeDesign();
    render();
    notify(`Preview job “${job.name}” queued${job.worktree ? ' with a simulated worktree' : ''}.`);
  }
  if (form.id === 'composer') {
    (state.messages[state.session] ||= []).push(data.get('message').trim());
    render();
    document.querySelector('#composer textarea').focus();
    notify('Message added to the sample thread.');
  }
  if (form.id === 'review-thread') {
    (state.reviewMessages[selectedReview().id] ||= []).push(data.get('message').trim());
    render();
    document.querySelector('#review-thread textarea').focus();
    notify('Review continuation saved in memory.');
  }
  if (form.id === 'settings-form') {
    for (const role of Object.keys(state.roles)) state.roles[role] = { engine: data.get(role + '-engine'), model: formModel(data, role + '-') };
    state.autoReview = data.has('autoReview');
    notify('Settings captured for this preview only. Reload resets them.');
  }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (!document.querySelector('dialog[open]')) palette();
    return;
  }
  const paletteOpen = document.querySelector('#palette').open;
  if (paletteOpen && event.target.id === 'command-search' && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'Enter') runCommand(commandIndex);
    else {
      const count = filteredCommands.length;
      commandIndex = count ? (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count : 0;
      commandResults(event.target.value);
      document.querySelector('#command-results .selected')?.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (document.querySelector('dialog[open]') || event.target.closest('input, textarea, select, button, a, summary, [contenteditable]') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (/^[1-5]$/.test(event.key)) navigate(pages[Number(event.key) - 1]);
});
