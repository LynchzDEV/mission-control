import { errorText, getJson, markFixture, postJson, readRecord } from './shared'

function say(element: HTMLElement | null, message: string, ok: boolean): void {
  if (element === null) return
  element.textContent = message
  element.classList.toggle('ok', ok)
}

function installGate(): void {
  const form = document.querySelector<HTMLFormElement>('#gate-form')
  if (form === null) return
  const message = document.querySelector<HTMLElement>('#gate-msg')
  const action = form.dataset.action ?? '/api/login'

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const field = form.querySelector<HTMLInputElement>('#password')
    const password = field?.value ?? ''
    say(message, 'CHECKING…', true)
    const result = await postJson(action, { password })
    if (!result.ok) {
      say(message, errorText(result).toUpperCase(), false)
      return
    }
    say(message, 'OK · ENTERING', true)
    location.assign('/lanes')
  })
}

function collect(button: HTMLElement): Record<string, string> {
  const payload: Record<string, string> = {}
  for (const key of (button.dataset.fields ?? '').split(',')) {
    const name = key.trim()
    if (name === '') continue
    const input = document.querySelector<HTMLInputElement>(`#${name}`)
    if (input === null || input.value === '') continue
    payload[name] = input.value
  }
  return payload
}

function installSecretRows(): void {
  document.querySelectorAll<HTMLElement>('[data-post]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault()
      const status = document.querySelector<HTMLElement>(`#${button.dataset.status ?? ''}`)
      const payload = collect(button)
      if (Object.keys(payload).length === 0) {
        say(status, 'NOTHING TO SAVE', false)
        return
      }
      const result = await postJson(button.dataset.post ?? '', payload)
      say(status, result.ok ? 'SAVED' : errorText(result).toUpperCase(), result.ok)
      if (result.ok) {
        for (const name of Object.keys(payload)) {
          const input = document.querySelector<HTMLInputElement>(`#${name}`)
          if (input !== null && input.type === 'password') input.value = ''
        }
      }
    })
  })
}

function installTodoRows(): void {
  document.querySelectorAll<HTMLElement>('[data-todo]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault()
      const status = document.querySelector<HTMLElement>(`#${button.dataset.status ?? ''}`)
      say(status, (button.dataset.todo ?? 'NOT WIRED YET').toUpperCase(), false)
    })
  })
}

function pill(selector: string, label: string, tone: 'ok' | 'bad' | 'setpill'): void {
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null) return
  element.textContent = label
  element.className = `pill ${tone}`
}

async function refreshEngineStatus(): Promise<void> {
  const quota = await getJson('/api/quota')
  if (!quota.ok) {
    markFixture(true)
    return
  }
  markFixture(false)
  const claude = readRecord(quota.data.claude)
  const glm = readRecord(quota.data.glm)
  const codex = readRecord(quota.data.codex)

  pill('#s-claude-auth', claude.available === false ? 'NO CCUSAGE' : 'LOGGED IN', claude.available === false ? 'bad' : 'ok')
  pill('#s-glm-conn', glm.available === false ? 'QUOTA API DOWN' : 'QUOTA API OK', glm.available === false ? 'bad' : 'ok')
  pill('#s-codex-oauth', codex.authed === true ? 'AUTHED' : 'EXPIRED · exit 1', codex.authed === true ? 'ok' : 'bad')
}

function installStatusProbes(): void {
  if (document.querySelector('#s-claude-auth') === null) return
  void refreshEngineStatus()
  document.querySelectorAll<HTMLElement>('[data-probe]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault()
      void refreshEngineStatus()
    })
  })
}

installGate()
installSecretRows()
installTodoRows()
installStatusProbes()
