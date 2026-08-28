/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'

export type GateProps = {
  minPasswordLength: number
}

function Gate(props: {
  page: 'setup' | 'login'
  title: string
  heading: string
  hint: string
  action: string
  submit: string
  autocomplete: string
  placeholder: string
}): string {
  return Layout({
    title: props.title,
    page: props.page,
    chrome: false,
    islands: ['forms'],
    meta: props.page === 'setup' ? 'FIRST RUN · NO PASSWORD SET' : 'LOCKED · SESSION REQUIRED',
    children: (
      <div class="gate">
        <div class="gatebox">
          <h1>{props.heading}</h1>
          <div class="hint">{props.hint}</div>
          <form id="gate-form" data-action={props.action}>
            <div class="field">
              <label for="password">PASSWORD</label>
              <input
                type="password"
                id="password"
                name="password"
                autocomplete={props.autocomplete}
                placeholder={props.placeholder}
                autofocus
              />
            </div>
            <button class="btn go" type="submit">
              {props.submit}
            </button>
            <div class="msg" id="gate-msg"></div>
          </form>
        </div>
      </div>
    ),
  })
}

export function SetupPage({ minPasswordLength }: GateProps): string {
  return Gate({
    page: 'setup',
    title: 'Mission Control — Setup',
    heading: 'MISSION CONTROL',
    hint: `First run. Choose a password (min ${minPasswordLength} characters). It is hashed with argon2id and stored under ~/.config/mission-control.`,
    action: '/api/setup',
    submit: 'CREATE',
    autocomplete: 'new-password',
    placeholder: `min ${minPasswordLength} characters`,
  })
}

export function LoginPage(): string {
  return Gate({
    page: 'login',
    title: 'Mission Control — Login',
    heading: 'MISSION CONTROL',
    hint: 'Three engines standing by. Sign in to take the console.',
    action: '/api/login',
    submit: 'LOG IN',
    autocomplete: 'current-password',
    placeholder: 'password',
  })
}
