/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'

export function TerminalsPage(): string {
  return Layout({
    title: 'Mission Control — Terminals',
    page: 'app',
    tab: 'terminals',
    islands: ['nav'],
    meta: 'TERMINALS · live pty sessions · persist while the server runs',
    children: (
      <>
        <div class="strip" id="term-strip">
          <a href="#" class="on" data-term="">
            NO SESSIONS
          </a>
          <button type="button" id="term-new" disabled>
            + NEW TERMINAL
          </button>
        </div>
        <div class="empty-pane" id="term-pane">
          XTERM PANE LANDS WITH P4
          <br />
          bun-pty bridge · ws /ws/terminal/:id
        </div>
      </>
    ),
  })
}
