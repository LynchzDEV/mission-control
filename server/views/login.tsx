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
    children: (
      <div class="gate">
        <div class="gatebox">
          <h1>{props.heading}</h1>
          <div class="hint">{props.hint}</div>
          <form id="gate-form" data-action={props.action}>
            <div class="field">
              <label for="password">Password</label>
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
            <div class="msg" id="gate-msg" role="status" aria-live="polite"></div>
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
    heading: 'Set up your workspace',
    hint: `First run. Choose a password (min ${minPasswordLength} characters). Use this password to access your workspace.`,
    action: '/api/setup',
    submit: 'Create workspace',
    autocomplete: 'new-password',
    placeholder: `min ${minPasswordLength} characters`,
  })
}

export function LoginPage(): string {
  return Gate({
    page: 'login',
    title: 'Mission Control — Login',
    heading: 'Sign in',
    hint: 'Sign in to return to your terminals, jobs, and conversations.',
    action: '/api/login',
    submit: 'Sign in',
    autocomplete: 'current-password',
    placeholder: 'password',
  })
}
