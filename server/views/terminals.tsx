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
  { value: 'claude', label: 'CLAUDE · tech lead' },
  { value: 'glm', label: 'GLM · junior fleet' },
  { value: 'codex', label: 'CODEX · outside critic' },
]

function NewTerminalForm(props: EnginePageProps): JSX.Element {
  return (
    <form class="termbar" id="term-form" hidden>
      <select id="term-engine" name="engine">
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
      <input id="term-cwd" name="cwd" placeholder="~/code/some-repo" list="term-recent-cwd" />
      <datalist id="term-recent-cwd"></datalist>
      <button class="btn go" type="submit">
        OPEN
      </button>
      <button class="btn" type="button" id="term-cancel">
        CANCEL
      </button>
      <span class="msg" id="term-msg"></span>
    </form>
  )
}

function AgentsPanel(): JSX.Element {
  return (
    <aside class="agents" id="agents-panel">
      <div class="phead ahead">
        <button type="button" class="atoggle" id="agents-toggle" title="collapse the agents panel">
          AGENTS ◂
        </button>
      </div>
      <button type="button" class="ascope" id="agents-scope" hidden></button>
      <div id="agents-message" role="status" aria-live="polite"></div>
      <div class="ascroll" id="agents-scroll">
        <div class="alab">RUNNING</div>
        <div id="agents-running"></div>
        <button type="button" class="alab arecent-toggle" id="agents-recent-toggle" hidden>RECENT 0 ▸</button>
        <div id="agents-recent" hidden></div>
        <div class="aempty" id="agents-empty">
          NO AGENTS RUNNING · dispatch from /dispatch or via mc-dispatch
        </div>
      </div>
      <div class="afoot">shows cockpit-dispatched jobs · in-terminal subagents are not observable</div>
    </aside>
  )
}

export function TerminalsPage(props: EnginePageProps): string {
  return Layout({
    title: 'Mission Control — Terminals',
    page: 'app',
    tab: 'terminals',
    islands: ['nav', 'terminal', 'agents'],
    vendor: ['xterm.js', 'addon-fit.js', 'addon-web-links.js', 'addon-search.js'],
    styles: ['/vendor/xterm.css'],
    meta: 'TERMINALS · live pty sessions · persist while the server runs',
    children: (
      <div class="termgrid" id="termgrid">
        <div class="termmain">
          <div class="strip" id="term-strip">
            <span class="termnone" id="term-none">
              NO SESSIONS
            </span>
            <button type="button" id="term-new">
              + NEW TERMINAL
            </button>
            <button type="button" class="btn" id="term-resume" title="re-open an old session">
              RESUME
            </button>
          </div>
          {NewTerminalForm(props)}
          <div class="termbar sessions" id="term-sessions" hidden>
            <input id="term-sessions-cwd" name="cwd" placeholder="~/code/some-repo" list="term-recent-cwd" />
            <button class="btn go" type="button" id="term-sessions-load">
              LOAD
            </button>
            <button class="btn" type="button" id="term-sessions-close">
              CLOSE
            </button>
            <div class="slist" id="term-sessions-list"></div>
          </div>
          <div class="empty-pane" id="term-pane">
            NO SESSION ATTACHED
            <br />
            bun-pty bridge · ws /ws/terminal/:id
          </div>
        </div>
        {AgentsPanel()}
      </div>
    ),
  })
}
