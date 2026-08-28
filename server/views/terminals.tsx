/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'

const ENGINES = [
  { value: 'claude', label: 'CLAUDE · tech lead' },
  { value: 'glm', label: 'GLM · junior fleet' },
  { value: 'codex', label: 'CODEX · outside critic' },
]

function NewTerminalForm(): JSX.Element {
  return (
    <form class="termbar" id="term-form" hidden>
      <select id="term-engine" name="engine">
        {ENGINES.map((engine) => (
          <option value={engine.value}>{engine.label}</option>
        ))}
      </select>
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

export function TerminalsPage(): string {
  return Layout({
    title: 'Mission Control — Terminals',
    page: 'app',
    tab: 'terminals',
    islands: ['nav', 'terminal'],
    vendor: ['xterm.js', 'addon-fit.js'],
    styles: ['/vendor/xterm.css'],
    meta: 'TERMINALS · live pty sessions · persist while the server runs',
    children: (
      <>
        <div class="strip" id="term-strip">
          <span class="termnone" id="term-none">
            NO SESSIONS
          </span>
          <button type="button" id="term-new">
            + NEW TERMINAL
          </button>
        </div>
        {NewTerminalForm()}
        <div class="empty-pane" id="term-pane">
          NO SESSION ATTACHED
          <br />
          bun-pty bridge · ws /ws/terminal/:id
        </div>
      </>
    ),
  })
}
