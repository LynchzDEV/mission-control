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
  { value: 'glm', label: 'GLM' },
  { value: 'codex', label: 'Codex' },
]

function NewTerminalForm(props: EnginePageProps): JSX.Element {
  return (
    <form class="termbar" id="term-form" hidden>
      <select id="term-engine" name="engine" aria-label="Engine">
        {ENGINES.map((engine) => (
          <option value={engine.value} selected={engine.value === props.defaultEngine}>
            {engine.label}
          </option>
        ))}
      </select>
      <ModelPicker
        id="term-model"
        engineSelectId="term-engine"
        value={props.defaultModel}
        models={props.models}
        engine={props.defaultEngine}
      />
      {ModelListsScript(props.models)}
      <input id="term-cwd" name="cwd" aria-label="Working directory" required placeholder="~/code/some-repo" list="term-recent-cwd" />
      <datalist id="term-recent-cwd"></datalist>
      <button class="btn go" type="submit">
        Open
      </button>
      <button class="btn" type="button" id="term-cancel">
        Cancel
      </button>

    </form>
  )
}

function AgentsPanel(): JSX.Element {
  return (
    <aside class="agents" id="agents-panel">
      <div class="phead ahead">
        <button type="button" class="atoggle" id="agents-toggle" title="collapse the agents panel">
          Activity ←
        </button>
      </div>
      <button type="button" class="ascope" id="agents-scope" hidden></button>
      <div id="agents-message" role="status" aria-live="polite"></div>
      <div class="ascroll" id="agents-scroll">
        <div class="alab">Running</div>
        <div id="agents-running"></div>
        <button type="button" class="alab arecent-toggle" id="agents-recent-toggle" hidden>RECENT 0 ▸</button>
        <div id="agents-recent" hidden></div>
        <div class="aempty" id="agents-empty">
          No active jobs. Start a job from Dispatch.
        </div>
      </div>
      <div class="afoot">Dispatched jobs appear here. Terminal subprocesses are separate.</div>
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
      <div class="termgrid agents-off" id="termgrid">
        <div class="termmain"><div class="horizon"><canvas id="ascii-horizon" aria-hidden="true"></canvas></div>
          <div class="workspace-heading"><div><h1 id="workspace-name">Terminals</h1><p id="workspace-path">Open or resume a session in your directory.</p></div><button type="button" class="btn" id="directory-toggle" aria-expanded="false">Directories</button></div>
          <div class="terminal-tools"><div class="tool-group"><button class="btn" id="split-horizontal" type="button" title="Add an existing session side by side">Side by side</button><button class="btn" id="split-vertical" type="button" title="Stack existing sessions">Stacked</button><button class="btn" id="term-focus" type="button" aria-pressed="false">Focus</button></div><div class="tool-group"><button class="btn" id="term-find" type="button">Find</button><button class="btn" id="term-reconnect" type="button">Reconnect</button><button class="btn" id="activity-open" type="button" aria-expanded="false">Agent chat</button></div></div>
          <div class="awareness-row"><section class="flow-overview" aria-label="Work flow"><header class="flow-summary"><select id="awareness-select" aria-label="Select work flow"></select><span id="awareness-status" role="status">Loading work…</span><a id="awareness-open" href="/lanes">Open work ↗</a></header><div class="flow-map" id="awareness-flow"></div></section></div><section id="active-agent-windows" aria-label="Active agents"><p id="active-agent-status" role="status">Select a terminal to see its active agents.</p><div id="active-agents-left" class="active-agent-rail"></div><div id="active-agents-right" class="active-agent-rail"></div></section><div class="terminal-content"><aside class="directory-nav" id="directory-nav" hidden aria-label="Directories and sessions"><strong>Directories</strong><div id="directory-list"></div></aside><div class="terminal-stage">
          {NewTerminalForm(props)}
          <div class="termbar sessions" id="term-sessions" hidden>
            <input id="term-sessions-cwd" name="cwd" aria-label="Claude history directory" placeholder="~/code/some-repo" list="term-recent-cwd" />
            <button class="btn go" type="button" id="term-sessions-load">
              Load
            </button>
            <button class="btn" type="button" id="term-sessions-close">
              Close
            </button>
            <div class="slist" id="term-sessions-list"></div>
          </div>
          <div class="msg terminal-status" id="term-msg" role="status" aria-live="polite"></div>
          <div id="term-pane" class="terminal-deck"><div class="terminal-welcome" id="terminal-welcome"><h2>Start a session</h2><p>Choose a directory and engine, or resume Claude history.</p><button class="btn go" type="button" id="welcome-new">Open a terminal</button></div></div>

          <div class="strip" id="term-strip">
            <span class="termnone" id="term-none">
              No live sessions
            </span>
            <button type="button" id="term-new">
              + New terminal
            </button>
            <button type="button" class="btn" id="term-resume" title="Resume Claude history for a directory">
              Resume
            </button>
          </div>
          </div></div><footer class="footnote"><span>Live sessions · select a session to scope work</span><button type="button" id="motion-toggle" aria-pressed="false">Pause motion</button></footer>
        </div>
        {AgentsPanel()}
      </div>
    ),
  })
}
