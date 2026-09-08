import { installModelPickers } from './model-picker'
import { paintOtherTokens } from './quota'
import { anime, errorText, getJson, markFixture, postJson, readNumber, readRecord, text } from './shared'

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
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')
    if (submit?.disabled) return
    if (submit) submit.disabled = true
    say(message, 'Signing in…', true)
    const result = await postJson(action, { password })
    if (submit) submit.disabled = false
    if (!result.ok) {
      say(message, errorText(result).toUpperCase(), false)
      return
    }
    say(message, 'OK · ENTERING', true)
    location.assign('/terminals')
  })
}

function collect(button: HTMLElement): Record<string, string> {
  const payload: Record<string, string> = {}
  for (const key of (button.dataset.fields ?? '').split(',')) {
    const name = key.trim()
    if (name === '') continue
    const input = document.querySelector<HTMLInputElement>(`#${name}`)
    if (input === null || (input.value === '' && !name.endsWith('_model'))) continue
    payload[name] = input.value
  }
  return payload
}

function reveal(button: HTMLElement): boolean {
  const id = button.dataset.reveal
  if (id === undefined) return false
  const input = document.querySelector<HTMLInputElement>(`#${id}`)
  if (input === null || !input.hidden) return false
  input.hidden = false
  input.focus()
  button.textContent = 'SAVE'
  return true
}

function installSecretRows(): void {
  document.querySelectorAll<HTMLElement>('[data-post]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault()
      if (reveal(button)) return
      const status = document.querySelector<HTMLElement>(`#${button.dataset.status ?? ''}`)
      const payload = collect(button)
      if (Object.keys(payload).length === 0) {
        say(status, 'NOTHING TO SAVE', false)
        return
      }
      if (button.hasAttribute('disabled')) return
      button.setAttribute('disabled', '')
      say(status, 'Saving…', true)
      const result = await postJson(button.dataset.post ?? '', payload)
      button.removeAttribute('disabled')
      say(status, result.ok ? 'SAVED' : errorText(result).toUpperCase(), result.ok)
      if (!result.ok) return
      dispatchEvent(new Event('mc:settings-refresh'))
      if (parent !== window) parent.postMessage({ type: 'mc:settings-saved' }, location.origin)
      for (const name of Object.keys(payload)) {
        const input = document.querySelector<HTMLInputElement>(`#${name}`)
        if (input === null || input.type !== 'password') continue
        input.value = ''
        input.hidden = true
        button.textContent = 'REPLACE'
      }
      if (result.data.zaiAuthTokenConfigured === true) {
        const pillEl = document.querySelector<HTMLElement>('#s-token')
        if (pillEl !== null) {
          pillEl.textContent = 'SET ●●●'
          pillEl.className = 'pill setpill'
        }
      }
    })
  })
}

function installApiTokenRow(): void {
  const revealButton = document.querySelector<HTMLElement>('[data-api-token-reveal]')
  const rotateButton = document.querySelector<HTMLElement>('[data-api-token-rotate]')
  const pillEl = document.querySelector<HTMLElement>('#s-api-token')

  function status(button: HTMLElement): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#${button.dataset.status ?? ''}`)
  }

  revealButton?.addEventListener('click', async (event) => {
    event.preventDefault()
    if (revealButton.hasAttribute('disabled')) return
    revealButton.setAttribute('disabled', '')
    say(status(revealButton), 'Copying token…', true)
    const result = await postJson('/api/secrets/api-token/reveal', {})
    revealButton.removeAttribute('disabled')
    if (!result.ok) {
      say(status(revealButton), errorText(result).toUpperCase(), false)
      return
    }
    const value = typeof result.data.apiToken === 'string' ? result.data.apiToken : ''
    try {
      await navigator.clipboard.writeText(value)
      say(status(revealButton), 'Token copied to clipboard', true)
    } catch {
      say(status(revealButton), 'Clipboard unavailable. Allow clipboard access and try again.', false)
    }
  })

  rotateButton?.addEventListener('click', async (event) => {
    event.preventDefault()
    if (rotateButton.hasAttribute('disabled')) return
    rotateButton.setAttribute('disabled', '')
    say(status(rotateButton), 'Rotating token…', true)
    const result = await postJson('/api/secrets/api-token/rotate', {})
    rotateButton.removeAttribute('disabled')
    if (!result.ok) {
      say(status(rotateButton), errorText(result).toUpperCase(), false)
      return
    }
    if (pillEl !== null) {
      pillEl.textContent = 'SET ●●●'
      pillEl.className = 'pill setpill'
    }
    say(status(rotateButton), 'ROTATED', true)
  })
}

function installTodoRows(): void {
  document.querySelectorAll<HTMLElement>('[data-todo]').forEach((button) => {
    button.setAttribute('aria-disabled', 'true')
    button.title = 'Unavailable: ' + (button.dataset.todo ?? 'Not implemented')
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
    markFixture('quota', true)
    throw new Error('Provider status unavailable')
  }
  markFixture('quota', false)
  const claude = readRecord(quota.data.claude)
  paintOtherTokens(document.getElementById('s-claude-other'), claude)
  const tokens = readNumber(claude.tokens)
  const cost = readNumber(claude.costUSD)
  const usage = claude.available === false || tokens === null
    ? '—'
    : `${tokens.toLocaleString('en-US')} TOK${cost === null ? '' : ` · $${cost.toFixed(2)}`}`
  text('#s-claude-usage', usage)
  const glm = readRecord(quota.data.glm)
  const codex = readRecord(quota.data.codex)

  pill('#s-claude-auth', claude.available === true ? 'Usage available' : 'Usage unavailable', claude.available === true ? 'ok' : 'bad')
  pill('#s-glm-conn', glm.available === true ? 'Quota available' : 'Quota unavailable', glm.available === true ? 'ok' : 'bad')
  pill('#s-codex-oauth', codex.authed === true ? 'Authenticated' : codex.authed === false ? 'Sign-in needed' : 'Authentication unavailable', codex.authed === true ? 'ok' : 'bad')
}

function installStatusProbes(): void {
  if (document.querySelector('#s-claude-auth') === null) return
  void refreshEngineStatus().catch(() => text('#s-msg', 'Provider status unavailable. Use Test to retry.'))
  document.querySelectorAll<HTMLElement>('[data-probe]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault()
      const output = document.querySelector<HTMLElement>(`#${button.dataset.status ?? 's-msg'}`)
      say(output, 'Checking provider…', true)
      button.setAttribute('disabled', '')
      void refreshEngineStatus().then(() => { button.removeAttribute('disabled'); say(output, 'Provider status refreshed', true) }).catch(() => { button.removeAttribute('disabled'); say(output, 'Provider status unavailable', false) })
    })
  })
}

function installColumnEntrance(): void {
  const A = anime()
  if (A === null || document.querySelector('.cols') === null) {
    document.querySelectorAll<HTMLElement>('.col').forEach((el) => (el.style.opacity = '1'))
    return
  }
  A.animate('.col', {
    opacity: [0, 1],
    translateY: [14, 0],
    delay: A.stagger(120),
    duration: 550,
    ease: 'outExpo',
  })
  A.animate('.app .frow', {
    opacity: [0, 1],
    delay: A.stagger(90, { start: 450 }),
    duration: 400,
    ease: 'outQuad',
  })
}

installGate()
if (document.body.dataset.previewReadonly === 'true') {
  document.querySelectorAll<HTMLButtonElement>('[data-post],[data-api-token-reveal],[data-api-token-rotate]').forEach(button => { button.disabled = true; button.title = 'Settings writes unavailable in preview' })
  text('#s-msg', 'Preview only. Settings writes are unavailable; displayed defaults are placeholders.')
} else { installSecretRows(); installApiTokenRow() }
installTodoRows()
installStatusProbes()
installModelPickers()
installColumnEntrance()
