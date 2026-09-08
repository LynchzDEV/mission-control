/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'
import { WorkView } from './work'
export function LanesPage(embedded = false): string {
  return Layout({ embedded, title: 'Mission Control — Overview', page: 'app', tab: 'lanes', islands: ['nav', 'work', 'lanes'], children: <>{WorkView()}<main id="usage-view" class="usage-page" hidden><h1>Usage</h1><p>Each provider reports its own measures.</p><div id="usage-status" role="status"></div><section><h2>Claude</h2><dl id="usage-claude"></dl></section><section><h2>GLM</h2><dl id="usage-glm"></dl></section><section><h2>Codex</h2><dl id="usage-codex"></dl></section><a href="/lanes">Open work</a></main></> })
}
