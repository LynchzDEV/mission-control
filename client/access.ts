import { errorText, getJson, postJson } from './shared'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const MASK = '••••••••••••'
const dialog = $('access') as HTMLDialogElement
const token = $('access-token') as HTMLInputElement
const reveal = $('access-reveal') as HTMLButtonElement
const copy = $('access-copy') as HTMLButtonElement
const rotate = $('access-rotate') as HTMLButtonElement
const rotateDialog = $('access-rotate-confirm') as HTMLDialogElement
const home = $('access-home') as HTMLInputElement
const homeForm = $('access-home-form') as HTMLFormElement
const homeNote = $('access-home-note')
const tokenNote = $('access-token-note')

function hideToken(): void {
  token.value = MASK
  copy.hidden = true
  reveal.hidden = false
}

function showToken(value: string): void {
  token.value = value
  copy.hidden = false
  reveal.hidden = true
}

async function loadHome(): Promise<void> {
  const result = await getJson('/api/chat/home')
  if (!result.ok) { homeNote.textContent = errorText(result); return }
  if (result.data.ok === true) { home.value = String(result.data.path); homeNote.textContent = result.data.source === 'config' ? 'Set by you.' : 'Worked out from your projects.'; return }
  home.value = ''
  homeNote.textContent = result.data.reason === 'home' ? 'Your projects share only your home folder. Pick the folder that holds them.' : 'Not set yet. The first chat asks for it.'
}

reveal.onclick = async () => {
  tokenNote.textContent = ''
  const result = await postJson('/api/secrets/api-token/reveal', {})
  if (!result.ok) { tokenNote.textContent = errorText(result); return }
  showToken(String(result.data.apiToken))
}

copy.onclick = async () => {
  try { await navigator.clipboard.writeText(token.value); tokenNote.textContent = 'Copied.' } catch { token.select(); tokenNote.textContent = 'Press ⌘C to copy.' }
}

rotate.onclick = () => rotateDialog.showModal()
$('access-rotate-cancel').onclick = () => rotateDialog.close()
$('access-rotate-yes').onclick = async () => {
  rotateDialog.close()
  const result = await postJson('/api/secrets/api-token/rotate', {})
  if (!result.ok) { tokenNote.textContent = errorText(result); return }
  showToken(String(result.data.apiToken))
  tokenNote.textContent = 'New token. Scripts using the old one stop working.'
}

homeForm.onsubmit = async (event) => {
  event.preventDefault()
  const response = await fetch('/api/chat/home', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: home.value.trim() }) })
  const payload = (await response.json().catch(() => ({}))) as { path?: string; error?: string }
  if (!response.ok || typeof payload.path !== 'string') { homeNote.textContent = payload.error ?? 'That folder cannot be used.'; return }
  home.value = payload.path
  homeNote.textContent = 'Saved.'
}

dialog.addEventListener('close', () => { hideToken(); tokenNote.textContent = '' })
new MutationObserver(() => { if (dialog.open) void loadHome() }).observe(dialog, { attributes: true, attributeFilter: ['open'] })
hideToken()

export {}
