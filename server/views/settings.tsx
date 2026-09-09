/** @jsxImportSource @kitajs/html */
import { ENGINE_NAMES } from '../engines'
import type { ModelLists } from '../models'
import type { EngineRoles } from '../secrets'
import { Layout } from './layout'
import { ModelListsScript, ModelPicker } from './model-picker'

export type SettingsProps = { embedded?: boolean; zaiBaseUrl: string; zaiAuthTokenConfigured: boolean; apiTokenConfigured: boolean; bind: string; roles: EngineRoles; autoReview: boolean; models: ModelLists; minPasswordLength: number }

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', glm: 'GLM' }
const ROLES = [
  { role: 'plan', title: 'Plan', caption: 'New terminals' },
  { role: 'execute', title: 'Execute', caption: 'New jobs' },
  { role: 'review', title: 'Review', caption: 'Automatic review' },
] as const

function Row(props: { title: string; caption: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return <div class="settings-row"><div class="row-label"><strong>{props.title}</strong><small>{props.caption}</small></div><div class="row-body">{props.children}</div></div>
}

function RoleRow(props: SettingsProps & { role: 'plan' | 'execute' | 'review'; title: string; caption: string }): JSX.Element {
  const current = props.roles[props.role]
  return (
    <Row title={props.title} caption={props.caption}>
      <div class="engine-choice" role="radiogroup" aria-label={`${props.title} engine`} data-engine-for={props.role}>
        {ENGINE_NAMES.map((engine) => <button class={`engine ${engine}`} type="button" role="radio" aria-checked={engine === current.engine ? 'true' : 'false'} data-engine={engine}><span class="dot"></span>{ENGINE_LABEL[engine] ?? engine}</button>)}
      </div>
      <select id={props.role} name={props.role} hidden aria-hidden="true" tabindex="-1">{ENGINE_NAMES.map((engine) => <option value={engine} selected={engine === current.engine}>{engine}</option>)}</select>
      <div class="field-row"><label class="field"><span class="field-label">Model</span><ModelPicker id={`${props.role}_model`} engineSelectId={props.role} value={current.model} models={props.models} engine={current.engine} /></label></div>
    </Row>
  )
}

export function SettingsPage(props: SettingsProps): string {
  return Layout({ embedded: props.embedded, title: 'Mission Control — Settings', page: 'app', tab: 'settings', islands: ['nav', 'forms'], children: (
    <main class="settings-page mc-forms">
      <header class="settings-head"><h1>Settings</h1><p>Changes apply to future work.</p></header>

      <section class="settings-section" aria-labelledby="work-defaults">
        <div class="section-head"><h2 id="work-defaults">Work defaults</h2><p>Which engine takes each role. A blank model uses the engine default.</p></div>
        <div class="settings-rows">
          {ROLES.map((entry) => <RoleRow {...props} role={entry.role} title={entry.title} caption={entry.caption} />)}
          <Row title="Automatic review" caption="Cross-family review after each finished job">
            <div class="row-inline">
              <button type="button" class="switch" role="switch" aria-checked={props.autoReview ? 'true' : 'false'} aria-labelledby="autoReview-label" data-switch-for="autoReview"><span class="knob"></span></button>
              <span class="switch-state" id="autoReview-state">{props.autoReview ? 'On' : 'Off'}</span>
              <span id="autoReview-label" hidden>Automatic review</span>
              <select id="autoReview" name="autoReview" hidden aria-hidden="true" tabindex="-1"><option value="off" selected={!props.autoReview}>Off</option><option value="on" selected={props.autoReview}>On</option></select>
            </div>
          </Row>
        </div>
        <div class="settings-actions"><button type="button" class="composer-open" data-post="/api/roles" data-fields="plan,execute,review,plan_model,execute_model,review_model,autoReview" data-status="s-msg">Save defaults</button></div>
        {ModelListsScript(props.models)}
      </section>

      <section class="settings-section" aria-labelledby="connections">
        <div class="section-head"><h2 id="connections">Connections</h2><p>Provider access for this workspace.</p></div>
        <div class="settings-rows">
          <Row title="Claude" caption="Claude Code CLI">
            <div class="row-inline"><span class="pill" id="s-claude-auth">Usage status not loaded</span><button type="button" class="composer-cancel" data-probe="claude" data-status="s-msg">Refresh status</button></div>
          </Row>
          <Row title="Codex" caption="Codex CLI">
            <div class="row-inline"><span class="pill" id="s-codex-oauth">Authentication not checked</span><small class="row-note">Sign in with the codex CLI; this page cannot start an interactive login.</small></div>
          </Row>
          <Row title="GLM" caption="Claude Code through z.ai">
            <div class="field-row"><label class="field"><span class="field-label">Z.ai base URL</span><input id="zaiBaseUrl" name="zaiBaseUrl" value={props.zaiBaseUrl} autocomplete="off" /></label></div>
            <div class="row-inline"><span class="pill" id="s-token">{props.zaiAuthTokenConfigured ? 'Token configured' : 'No token'}</span><input type="password" id="zaiAuthToken" name="zaiAuthToken" class="secret-input" placeholder="New z.ai token" autocomplete="off" hidden /><button type="button" class="composer-cancel" data-post="/api/secrets" data-fields="zaiAuthToken" data-reveal="zaiAuthToken" data-status="s-msg">Replace token</button><span class="pill" id="s-glm-conn">Quota status not loaded</span></div>
          </Row>
        </div>
        <div class="settings-actions"><button type="button" class="composer-open" data-post="/api/secrets" data-fields="zaiBaseUrl" data-status="s-msg">Save connection</button></div>
      </section>

      <section class="settings-section" aria-labelledby="access">
        <div class="section-head"><h2 id="access">Access</h2><p>Workspace network and API access.</p></div>
        <div class="settings-rows">
          <Row title="Bind address" caption="Takes effect on the next start">
            <div class="field-row"><label class="field"><span class="field-label">Host and port</span><input id="bind" name="bind" value={props.bind} autocomplete="off" /></label></div>
          </Row>
          <Row title="API token" caption="Bearer token for scripts and the dispatch skill">
            <div class="row-inline"><span class="pill" id="s-api-token">{props.apiTokenConfigured ? 'Configured' : 'Not configured'}</span><button type="button" class="composer-cancel" data-api-token-reveal="reveal" data-status="s-msg">Copy token</button><button type="button" class="composer-cancel" data-api-token-rotate="rotate" data-status="s-msg">Rotate token</button></div>
          </Row>
          <Row title="Password" caption="Workspace sign-in">
            <small class="row-note">Password changes are unavailable in this interface.</small>
          </Row>
        </div>
        <div class="settings-actions"><button type="button" class="composer-open" data-post="/api/secrets" data-fields="bind" data-status="s-msg">Save address</button></div>
      </section>

      <p class="settings-feedback" id="s-msg" role="status" aria-live="polite"></p>
    </main>
  ) })
}
