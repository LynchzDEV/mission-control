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

function LauncherPane(props: EnginePageProps): JSX.Element {
  return (
    <div class="pane">
      <div class="phead">LAUNCH HEADLESS JOB</div>
      <form class="form" id="dispatch-form">
        <div class="field">
          <label for="engine">ENGINE</label>
          <select id="engine" name="engine">
            {ENGINES.map((engine) => (
              <option value={engine.value} selected={engine.value === props.defaultEngine}>
                {engine.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="model">MODEL · blank = engine default</label>
          <ModelPicker
            id="model"
            engineSelectId="engine"
            value={props.defaultModel}
            models={props.models}
            engine={props.defaultEngine}
          />
          {ModelListsScript(props.models)}
        </div>
        <div class="field">
          <label for="cwd">CWD · must be a git repo under $HOME</label>
          <input id="cwd" name="cwd" placeholder="~/code/some-repo" list="recent-cwd" />
          <datalist id="recent-cwd"></datalist>
        </div>
        <div class="field">
          <label for="label">LABEL</label>
          <input id="label" name="label" placeholder="orders-export-fix" />
        </div>
        <div class="field">
          <label for="prompt">PROMPT</label>
          <textarea id="prompt" name="prompt" placeholder="say hi and exit"></textarea>
        </div>
        <div class="field">
          <label for="worktree"><input type="checkbox" id="worktree" name="worktree" checked /> run in its own worktree</label>
        </div>
        <button class="btn go" type="submit">
          DISPATCH
        </button>
        <div class="msg" id="dispatch-msg"></div>
      </form>
    </div>
  )
}

function JobsPane(): JSX.Element {
  return (
    <div class="pane">
      <div class="phead">
        JOBS
        <span class="fixture" data-src="jobs">
          FIXTURE
        </span>
      </div>
      <div class="scroll">
        <table class="grid">
          <thead>
            <tr>
              <th>STATUS</th>
              <th>ENGINE</th>
              <th>LABEL</th>
              <th>ELAPSED</th>
              <th>DIFF</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="jobs-body">
            <tr class="empty">
              <td colspan="6">NO JOBS YET</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="drawer" id="log-drawer">
        <div class="phead">
          LOG TAIL · <span id="log-job">no job selected</span>
        </div>
        <pre id="log-body"></pre>
      </div>
    </div>
  )
}

export function DispatchPage(props: EnginePageProps): string {
  return Layout({
    title: 'Mission Control — Dispatch',
    page: 'app',
    tab: 'dispatch',
    islands: ['nav', 'dispatch'],
    meta: 'DISPATCH · headless jobs · stdout streams over SSE',
    children: (
      <div class="panes">
        {LauncherPane(props)}
        {JobsPane()}
      </div>
    ),
  })
}
