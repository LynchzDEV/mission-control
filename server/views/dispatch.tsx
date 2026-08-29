/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'

const ENGINES = [
  { value: 'claude', label: 'CLAUDE · tech lead' },
  { value: 'glm', label: 'GLM · junior fleet' },
  { value: 'codex', label: 'CODEX · outside critic' },
]

function LauncherPane(): JSX.Element {
  return (
    <div class="pane">
      <div class="phead">LAUNCH HEADLESS JOB</div>
      <form class="form" id="dispatch-form">
        <div class="field">
          <label for="engine">ENGINE</label>
          <select id="engine" name="engine">
            {ENGINES.map((engine) => (
              <option value={engine.value}>{engine.label}</option>
            ))}
          </select>
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

export function DispatchPage(): string {
  return Layout({
    title: 'Mission Control — Dispatch',
    page: 'app',
    tab: 'dispatch',
    islands: ['nav', 'dispatch'],
    meta: 'DISPATCH · headless jobs · stdout streams over SSE',
    children: (
      <div class="panes">
        {LauncherPane()}
        {JobsPane()}
      </div>
    ),
  })
}
