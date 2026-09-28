import { confirmButton } from './confirm-button'
import { morph, rollText } from './morph'
import { errorText, getJson, postJson } from './shared'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const MASK = '••••••••••••'
const COPIED_MS = 1600
const dialog = $('access') as HTMLDialogElement
const token = $('access-token') as HTMLInputElement
const tokenButton = $('access-reveal') as HTMLButtonElement
const rotate = $('access-rotate') as HTMLButtonElement
const home = $('access-home') as HTMLInputElement
const homeForm = $('access-home-form') as HTMLFormElement
const homeNote = $('access-home-note')
const tokenNote = $('access-token-note')
let copiedTimer = 0

function label(text: string, copied = false): void {
  morph(tokenButton, () => { tokenButton.textContent = text; tokenButton.classList.toggle('copied', copied) })
}

function hideToken(): void {
  clearTimeout(copiedTimer)
  token.value = MASK
  tokenButton.dataset.mode = 'reveal'
  tokenButton.textContent = 'Reveal'
  tokenButton.classList.remove('copied')
}

function showToken(value: string): void {
  token.value = value
  token.animate?.([{ opacity: .2, filter: 'blur(2px)' }, { opacity: 1, filter: 'none' }], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' })
  tokenButton.dataset.mode = 'copy'
  label('Copy')
}

async function loadHome(): Promise<void> {
  const result = await getJson('/api/chat/home')
  if (!result.ok) { rollText(homeNote, errorText(result)); return }
  if (result.data.ok === true) { home.value = String(result.data.path); rollText(homeNote, result.data.source === 'config' ? 'Set by you.' : 'Worked out from your projects.'); return }
  home.value = ''
  rollText(homeNote, result.data.reason === 'home' ? 'Your projects share only your home folder. Pick the folder that holds them.' : 'Not set yet. The first chat asks for it.')
}

async function revealToken(): Promise<void> {
  rollText(tokenNote, '')
  const result = await postJson('/api/secrets/api-token/reveal', {})
  if (!result.ok) { rollText(tokenNote, errorText(result)); return }
  showToken(String(result.data.apiToken))
}

async function copyToken(): Promise<void> {
  try { await navigator.clipboard.writeText(token.value) } catch { token.select(); rollText(tokenNote, 'Press ⌘C to copy.'); return }
  clearTimeout(copiedTimer)
  label('✓ Copied', true)
  copiedTimer = window.setTimeout(() => label('Copy'), COPIED_MS)
}

tokenButton.onclick = () => void (tokenButton.dataset.mode === 'copy' ? copyToken() : revealToken())

confirmButton(rotate, 'Make new token', async () => {
  const result = await postJson('/api/secrets/api-token/rotate', {})
  if (!result.ok) { rollText(tokenNote, errorText(result)); return }
  showToken(String(result.data.apiToken))
  rollText(tokenNote, 'New token. Scripts using the old one stop working.')
})

homeForm.onsubmit = async (event) => {
  event.preventDefault()
  const response = await fetch('/api/chat/home', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: home.value.trim() }) })
  const payload = (await response.json().catch(() => ({}))) as { path?: string; error?: string }
  if (!response.ok || typeof payload.path !== 'string') { rollText(homeNote, payload.error ?? 'That folder cannot be used.'); return }
  home.value = payload.path
  rollText(homeNote, 'Saved.')
}

dialog.addEventListener('close', () => { hideToken(); tokenNote.textContent = '' })
new MutationObserver(() => { if (dialog.open) void loadHome() }).observe(dialog, { attributes: true, attributeFilter: ['open'] })
hideToken()

export {}
