/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'

export type SettingsProps = {
  zaiBaseUrl: string
  zaiAuthTokenConfigured: boolean
  apiTokenConfigured: boolean
  bind: string
  minPasswordLength: number
}

type RowProps = {
  label: string
  value: JSX.Element | string
  action?: JSX.Element | string
}

function Row(props: RowProps): JSX.Element {
  return (
    <div class="frow">
      <div class="k">{props.label}</div>
      <div class="v">{props.value}</div>
      <div class="a">{props.action ?? ''}</div>
    </div>
  )
}

function Head(name: string, tone: string, role: string): JSX.Element {
  return (
    <div class="chead">
      <div class={`nm ${tone}`}>{name}</div>
      <div class="role">{role}</div>
    </div>
  )
}

function ClaudeColumn(): JSX.Element {
  return (
    <div class="col">
      {Head('CLAUDE', 'c-claude', 'TECH LEAD · ANTHROPIC SUB')}
      {Row({
        label: 'AUTH',
        value: (
          <>
            <span class="pill ok" id="s-claude-auth">
              LOGGED IN
            </span>
            <span class="fixture" data-src="quota">
              FIXTURE
            </span>
          </>
        ),
        action: (
          <button type="button" data-probe="claude" data-status="s-msg">
            TEST
          </button>
        ),
      })}
      {Row({
        label: 'BINARY',
        value: 'claude 2.1.34',
        action: (
          <button type="button" data-todo="binary check lands with P2 engines.ts" data-status="s-msg">
            CHECK
          </button>
        ),
      })}
      {Row({
        label: 'QUOTA SRC',
        value: 'ccusage blocks --json',
        action: (
          <button type="button" data-probe="claude" data-status="s-msg">
            RUN
          </button>
        ),
      })}
      {Row({ label: 'ROLE', value: 'spec · review · verify · merge' })}
    </div>
  )
}

function GlmColumn(props: SettingsProps): JSX.Element {
  return (
    <div class="col">
      {Head('GLM', 'c-glm', 'JUNIOR FLEET · Z.AI CODING PLAN')}
      {Row({
        label: 'API TOKEN',
        value: (
          <>
            <span class={`pill ${props.zaiAuthTokenConfigured ? 'setpill' : 'bad'}`} id="s-token">
              {props.zaiAuthTokenConfigured ? 'SET ●●●' : 'UNSET'}
            </span>
            <input
              type="password"
              id="zaiAuthToken"
              name="zaiAuthToken"
              placeholder="paste new token"
              autocomplete="off"
              hidden
            />
          </>
        ),
        action: (
          <button
            type="button"
            id="token-action"
            data-post="/api/secrets"
            data-fields="zaiAuthToken"
            data-status="s-msg"
            data-reveal="zaiAuthToken"
          >
            REPLACE
          </button>
        ),
      })}
      {Row({
        label: 'BASE URL',
        value: <input id="zaiBaseUrl" name="zaiBaseUrl" value={props.zaiBaseUrl} />,
        action: (
          <button type="button" data-post="/api/secrets" data-fields="zaiBaseUrl" data-status="s-msg">
            SAVE
          </button>
        ),
      })}
      {Row({
        label: 'MODEL MAP',
        value: 'opus/sonnet/haiku → glm-5.3-flash',
        action: (
          <button type="button" data-todo="model map is fixed in engines.ts (P2)" data-status="s-msg">
            EDIT
          </button>
        ),
      })}
      {Row({
        label: 'CONNECTION',
        value: (
          <>
            <span class="pill ok" id="s-glm-conn">
              QUOTA API OK
            </span>
            <span class="fixture" data-src="quota">
              FIXTURE
            </span>
          </>
        ),
        action: (
          <button type="button" data-probe="glm" data-status="s-msg">
            TEST
          </button>
        ),
      })}
    </div>
  )
}

function CodexColumn(): JSX.Element {
  return (
    <div class="col">
      {Head('CODEX', 'c-white', 'OUTSIDE CRITIC · CHATGPT PRO')}
      {Row({
        label: 'OAUTH',
        value: (
          <>
            <span class="pill bad" id="s-codex-oauth">
              EXPIRED · exit 1
            </span>
            <span class="fixture" data-src="quota">
              FIXTURE
            </span>
          </>
        ),
        action: (
          <button
            type="button"
            class="c-red"
            data-todo="re-auth runs codex login in a terminal (P4)"
            data-status="s-msg"
          >
            RE-AUTH
          </button>
        ),
      })}
      {Row({
        label: 'BINARY',
        value: 'codex 0.29.0',
        action: (
          <button type="button" data-todo="binary check lands with P2 engines.ts" data-status="s-msg">
            CHECK
          </button>
        ),
      })}
      {Row({ label: 'QUOTA SRC', value: 'none · login status only' })}
      {Row({ label: 'ROLE', value: 'cross-review · overflow impl' })}
    </div>
  )
}

function AppBand(props: SettingsProps): JSX.Element {
  return (
    <div class="app">
      {Row({
        label: 'PASSWORD',
        value: (
          <input
            type="password"
            id="password"
            placeholder={`new password (min ${props.minPasswordLength})`}
            autocomplete="new-password"
          />
        ),
        action: (
          <button type="button" data-todo="password change needs an auth route (not in P5)" data-status="s-msg">
            CHANGE
          </button>
        ),
      })}
      {Row({
        label: 'BIND',
        value: <input id="bind" name="bind" value={props.bind} />,
        action: (
          <button type="button" data-post="/api/secrets" data-fields="bind" data-status="s-msg">
            SAVE
          </button>
        ),
      })}
      {Row({
        label: 'GLM PEAK',
        value: 'warn before dispatch in peak window',
        action: <span class="pill ok">ON</span>,
      })}
      {Row({
        label: 'API TOKEN',
        value: (
          <span class={`pill ${props.apiTokenConfigured ? 'setpill' : 'bad'}`} id="s-api-token">
            {props.apiTokenConfigured ? 'SET ●●●' : 'UNSET'}
          </span>
        ),
        action: (
          <>
            <button type="button" data-api-token-reveal="reveal" data-status="s-msg">
              REVEAL
            </button>
            <button type="button" data-api-token-rotate="rotate" data-status="s-msg">
              ROTATE
            </button>
          </>
        ),
      })}
    </div>
  )
}

export function SettingsPage(props: SettingsProps): string {
  return Layout({
    title: 'Mission Control — Settings',
    page: 'app',
    tab: 'settings',
    islands: ['nav', 'forms'],
    vendor: ['anime.umd.min.js'],
    meta: 'SETTINGS · all values stored server-side · tokens never echoed',
    children: (
      <>
        <div class="scroll">
          <div class="cols">
            {ClaudeColumn()}
            {GlmColumn(props)}
            {CodexColumn()}
          </div>
          <div class="applab">APP</div>
          {AppBand(props)}
        </div>
        <div class="foot">
          <div>
            <span class="msg" id="s-msg"></span>
          </div>
          <div>SETTINGS · symmetric 3-col, mirrors lanes racks</div>
        </div>
      </>
    ),
  })
}
