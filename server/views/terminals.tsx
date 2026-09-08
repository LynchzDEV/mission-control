/** @jsxImportSource @kitajs/html */
import type { ModelLists } from '../models'
import { Layout } from './layout'
import { ModelListsScript, ModelPicker } from './model-picker'

export type EnginePageProps = {
  defaultEngine: string
  defaultModel: string | null
  models: ModelLists
}

const ENGINES = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'glm', label: 'GLM' },
]

const PLUS = <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
const CROSS = <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
const ARROW = <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5" /></svg>

function ComposerPopover(props: EnginePageProps): JSX.Element {
  return (
    <form class="composer composer-popover" id="term-form" hidden aria-label="New terminal">
      <div class="composer-head">
        <div class="composer-tabs" role="tablist" aria-label="New terminal mode">
          <button class="composer-tab" type="button" role="tab" aria-selected="true" data-tab="new" id="term-tab-new">New</button>
          <button class="composer-tab" type="button" role="tab" aria-selected="false" data-tab="resume" id="term-tab-resume">Resume</button>
        </div>
        <button class="composer-dismiss" type="button" id="term-cancel" aria-label="Dismiss">{CROSS}</button>
      </div>
      <div class="composer-panel composer-body" data-panel="new" id="term-panel-new">
        <div class="engine-choice" role="radiogroup" aria-label="Engine" id="term-engines">
          {ENGINES.map((engine) => (
            <button class={`engine ${engine.value}`} type="button" role="radio" aria-checked={engine.value === props.defaultEngine ? 'true' : 'false'} data-engine={engine.value}><span class="dot"></span>{engine.label}</button>
          ))}
        </div>
        <select id="term-engine" name="engine" hidden aria-hidden="true" tabindex="-1">
          {ENGINES.map((engine) => (
            <option value={engine.value} selected={engine.value === props.defaultEngine}>{engine.label}</option>
          ))}
        </select>
        <div class="field-row">
          <label class="field"><span class="field-label">Model</span><ModelPicker id="term-model" engineSelectId="term-engine" value={props.defaultModel} models={props.models} engine={props.defaultEngine} /></label>
          <label class="field"><span class="field-label">Directory</span><input id="term-cwd" name="cwd" required placeholder="~/code/some-repo" autocomplete="off" /></label>
        </div>
        {ModelListsScript(props.models)}
        <div><div class="list-label">Recent directories</div><div class="dir-list" id="term-directories"></div></div>
        <div class="composer-actions"><button class="composer-open" type="submit">{PLUS}Open terminal</button><button class="composer-cancel" type="button">Cancel</button><kbd>esc</kbd></div>
      </div>
      <div class="composer-panel composer-body" data-panel="resume" id="term-panel-resume" hidden>
        <label class="field"><span class="field-label">Claude history directory</span><input id="term-sessions-cwd" name="history" placeholder="~/code/some-repo" autocomplete="off" /></label>
        <div><div class="list-label">Claude history<em id="term-sessions-where"></em></div><div class="resume-list" id="term-sessions-list"></div></div>
        <div class="composer-actions"><button class="composer-open" type="button" id="term-sessions-load">{ARROW}Load history</button><button class="composer-cancel" type="button">Cancel</button></div>
      </div>
    </form>
  )
}

function AgentSidebar(): JSX.Element {
  return (
    <aside class="agent-sidebar" id="agent-sidebar" aria-label="Work flow and active agents">
      <header class="sidebar-head"><h2>Agents</h2><button type="button" class="panel-toggle" id="sidebar-toggle" aria-expanded="true" aria-controls="sidebar-body" title="Collapse sidebar"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button></header>
      <div class="sidebar-body" id="sidebar-body">
        <section id="active-agent-windows" aria-label="Active agents"><p id="active-agent-status" role="status">Select a terminal to see its active agents.</p><div id="active-agents-left" class="active-agent-rail"></div><div id="active-agents-right" class="active-agent-rail"></div></section>
      </div>
    </aside>
  )
}

export function TerminalsPage(props: EnginePageProps): string {
  return Layout({
    title: 'Mission Control — Terminals',
    page: 'app',
    tab: 'terminals',
    islands: ['nav', 'terminal', 'agents', 'awareness'],
    vendor: ['xterm.js', 'addon-fit.js', 'addon-web-links.js', 'addon-search.js'],
    styles: ['/vendor/xterm.css'],
    meta: 'Live workspace',
    children: (
      <div class="termgrid" id="termgrid">
        <div class="termmain"><div class="horizon"><canvas id="ascii-horizon" aria-hidden="true"></canvas></div>
          <div class="workspace-heading"><div><h1 id="workspace-name">Terminals</h1><p id="workspace-path">Open or resume a session in your directory.</p></div></div>
          <div class="terminal-tools"><div class="tool-group"><button class="btn" id="split-horizontal" type="button" title="Add an existing session side by side">Side by side</button><button class="btn" id="split-vertical" type="button" title="Stack existing sessions">Stacked</button></div><div class="tool-group"><button class="btn" id="activity-open" type="button" aria-expanded="true" aria-pressed="true">Agents</button></div></div>
          <section class="flow-overview" id="flow-overview" aria-label="Work flow"><header class="flow-summary"><button type="button" class="panel-toggle disclosure" id="flow-toggle" aria-expanded="true" aria-controls="awareness-flow" title="Collapse work flow"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button><select id="awareness-select" aria-label="Select work flow"></select><span id="awareness-status" role="status">Loading work…</span><a id="awareness-open" href="/lanes">Open work ↗</a></header><div class="flow-map" id="awareness-flow"></div></section><div class="terminal-content"><div class="terminal-stage">
          <div class="msg terminal-status" id="term-msg" role="status" aria-live="polite"></div>
          <div id="term-pane" class="terminal-deck"><div class="terminal-welcome welcome" id="terminal-welcome"><h2>Start a session</h2><p>Choose a directory and engine, or resume Claude history.</p><button class="composer-open" type="button" id="welcome-new">{PLUS}Open terminal</button></div></div>

          <div class="strip session-strip" id="term-strip"><span class="termnone" id="term-none">No live sessions</span><button type="button" class="add-session" id="term-new" aria-expanded="false">{PLUS}New terminal</button>{ComposerPopover(props)}</div>
          </div></div><footer class="footnote"><span>Live sessions · select a session to scope work</span><button type="button" id="motion-toggle" aria-pressed="false">Pause motion</button></footer>
        </div>
        {AgentSidebar()}
      </div>
    ),
  })
}
