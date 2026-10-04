import { errorText, getJson, postJson, readArray } from '../shared'
import { launchChoice, readRecentDirectories, type LaunchProvider } from '../shell-launch'
import type { SessionKind, SessionRequest } from './types'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const dialog = $('plugin-launch') as HTMLDialogElement
const title = $('plugin-launch-title')
const sub = $('plugin-launch-sub')
const errorLine = $('plugin-launch-error')
const ctxNote = $('plugin-launch-ctx')
const ctxName = $('plugin-launch-ctx-name')
const ctxSize = $('plugin-launch-ctx-size')
const form = $('plugin-launch-form') as HTMLFormElement
const engineSelect = $('plugin-launch-engine') as HTMLSelectElement
const modelInput = $('plugin-launch-model') as HTMLInputElement
const modelChoices = $('plugin-launch-models') as HTMLDataListElement
const cwdInput = $('plugin-launch-cwd') as HTMLInputElement
const cwdChoices = $('plugin-launch-recents') as HTMLDataListElement
const messageInput = $('plugin-launch-message') as HTMLInputElement
const messageHint = $('plugin-launch-message-hint')
const start = $('plugin-launch-start') as HTMLButtonElement

const RECENT_CWD_KEY = 'mc.term.recentCwd', ENGINE_KEY = 'mc.shell.engine', MODEL_KEY = 'mc.shell.model'
const CONTEXT_NOTE = 'Read the task context in'

const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const keep = (key: string, value: string | null): void => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch {} }

function launchPrompt(contextPath: string | null, firstMessage: string): string {
  const note = contextPath === null ? '' : `${CONTEXT_NOTE} ${contextPath} before anything else.`
  if (note === '') return firstMessage
  return firstMessage === '' ? note : `${note}\n\n${firstMessage}`
}

type OpenState = { kind: SessionKind; plugin: { id: string; name: string }; request: SessionRequest; done: () => void }

let state: OpenState | null = null

function updateStart(): void {
  if (state === null) return
  const needsMessage = state.kind === 'chat' && messageInput.value.trim() === '' && state.request.context === undefined
  start.disabled = needsMessage
  messageHint.hidden = !needsMessage
}

function paintContext(request: SessionRequest): void {
  if (request.context === undefined) { ctxNote.hidden = true; return }
  ctxNote.hidden = false
  ctxName.textContent = request.context.name
  const bytes = new TextEncoder().encode(request.context.markdown).length
  ctxSize.textContent = `${Math.max(1, Math.ceil(bytes / 1024))} KB. The AI reads it before your first message.`
}

async function fillEngines(): Promise<void> {
  const result = await getJson('/api/providers')
  if (!result.ok) { errorLine.textContent = `Could not load AIs: ${errorText(result)}`; return }
  const providers = readArray(result.data.providers) as unknown as LaunchProvider[]
  if (providers.length === 0) { errorLine.textContent = 'No AI is connected yet. Add one in Studio → Manage AIs.'; return }
  const models: Record<string, string[]> = Object.fromEntries(providers.map(provider => [provider.id, provider.models]))
  engineSelect.replaceChildren(...providers.map(provider => new Option(provider.name, provider.id)))
  const choice = launchChoice(providers, stored(ENGINE_KEY), stored(MODEL_KEY))
  engineSelect.value = choice.engine
  modelInput.value = choice.model
  const paintModels = (): void => { modelChoices.replaceChildren(...(models[engineSelect.value] ?? []).map(model => new Option(model, model))) }
  paintModels()
  engineSelect.onchange = () => { modelInput.value = ''; paintModels() }
}

export function openPluginLaunch(kind: SessionKind, plugin: { id: string; name: string }, request: SessionRequest): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const done = (): void => { if (settled) return; settled = true; if (state !== null && state.done === done) state = null; resolve() }
    const onClose = (): void => { dialog.removeEventListener('close', onClose); done() }
    if (dialog.open) dialog.close()
    state?.done()
    state = { kind, plugin, request, done }
    dialog.addEventListener('close', onClose)
    title.textContent = kind === 'chat' ? 'Start chat' : 'Start terminal'
    sub.textContent = request.title
    errorLine.textContent = ''
    start.textContent = kind === 'chat' ? 'Start chat' : 'Start terminal'
    start.disabled = false
    paintContext(request)
    cwdInput.value = request.cwd
    cwdChoices.replaceChildren(...readRecentDirectories(stored(RECENT_CWD_KEY)).map(cwd => new Option(cwd, cwd)))
    messageInput.value = request.prompt ?? ''
    updateStart()
    void fillEngines()
    dialog.showModal()
  })
}

messageInput.oninput = updateStart

form.onsubmit = (event: SubmitEvent): void => {
  event.preventDefault()
  if (state === null || start.disabled) return
  const open = state
  const engine = engineSelect.value
  const model = modelInput.value.trim()
  const cwd = cwdInput.value.trim()
  if (engine === '') { errorLine.textContent = 'No AI is connected yet. Add one in Studio → Manage AIs.'; return }
  if (cwd === '') { errorLine.textContent = 'Choose a working directory.'; return }
  start.disabled = true
  start.textContent = 'Starting…'
  void beginLaunch(open, { engine, ...(model === '' ? {} : { model }), cwd, firstMessage: messageInput.value.trim() })
}

async function beginLaunch(open: OpenState, choice: { engine: string; model?: string; cwd: string; firstMessage: string }): Promise<void> {
  try {
    let contextPath: string | null = null
    if (open.request.context !== undefined) {
      const written = await postJson(`/api/plugins/${encodeURIComponent(open.plugin.id)}/context`, { name: open.request.context.name, markdown: open.request.context.markdown })
      if (!written.ok) { errorLine.textContent = `Could not attach the task context: ${errorText(written)}`; start.disabled = false; start.textContent = open.kind === 'chat' ? 'Start chat' : 'Start terminal'; updateStart(); return }
      contextPath = typeof written.data.path === 'string' ? written.data.path : null
    }
    const prompt = launchPrompt(contextPath, choice.firstMessage)
    keep(ENGINE_KEY, choice.engine)
    keep(MODEL_KEY, choice.model ?? null)
    if (open.kind === 'chat') {
      dispatchEvent(new CustomEvent('quiet:start-chat', { detail: { engine: choice.engine, ...(choice.model === undefined ? {} : { model: choice.model }), cwd: choice.cwd, prompt } }))
    } else {
      dispatchEvent(new CustomEvent('quiet:open-terminal', {
        detail: { launch: { engine: choice.engine, ...(choice.model === undefined ? {} : { model: choice.model }), cwd: choice.cwd, title: open.request.title, ...(prompt === '' ? {} : { initialPrompt: prompt }) } },
      }))
    }
    dialog.close()
    open.done()
  } catch {
    errorLine.textContent = 'Could not start the session. Try again.'
    start.disabled = false
    start.textContent = open.kind === 'chat' ? 'Start chat' : 'Start terminal'
    updateStart()
  }
}
