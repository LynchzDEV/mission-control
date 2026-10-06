import { errorText, getJson, type ApiResult } from './shared'
import { el } from './queue-view'

export const NO_REPOS_HERE = "This folder isn't a git repo and has no repos inside it."
export const TICK_A_REPO = 'Tick at least one repo this ticket touches'
export const NOT_A_REPO = 'cwd is not a git repository'
const CHECK_DELAY_MS = 300
const PLAIN: Record<string, string> = {
  [NOT_A_REPO]: NO_REPOS_HERE,
  'cwd does not exist': "This folder doesn't exist.",
  'cwd is not a directory': "This isn't a folder.",
  'cwd must be under $HOME': 'Pick a folder inside your home folder.',
}

export const plainFolderError = (text: string): string => PLAIN[text] ?? text

export type FolderState = ({ kind: 'repo' } | { kind: 'parent'; repos: string[] } | { kind: 'none'; error: string }) & { path: string; skipped: number }

export type FolderPicker = {
  note: HTMLElement
  slot: HTMLElement
  check(): Promise<FolderState | null>
  known(): FolderState | null
  checking(): boolean
  settling(): boolean
  ticked(): string[]
  reset(): void
}

type PickerHooks = { busy(on: boolean): void; problem(text: string): void }

function readFolder(path: string, result: ApiResult): FolderState {
  if (!result.ok) return { path, skipped: 0, kind: 'none', error: plainFolderError(errorText(result)) }
  const skipped = typeof result.data.skipped === 'number' ? result.data.skipped : 0
  if (result.data.isRepo === true) return { path, skipped, kind: 'repo' }
  const repos = Array.isArray(result.data.repos) ? result.data.repos.filter((name): name is string => typeof name === 'string') : []
  return repos.length > 0 ? { path, skipped, kind: 'parent', repos } : { path, skipped, kind: 'none', error: NO_REPOS_HERE }
}

const skippedNote = (count: number): HTMLElement =>
  el('small', { class: 'q-folder-skipped' }, count === 1 ? '1 folder took too long to check and was left out.' : `${count} folders took too long to check and were left out.`)

function repoList(repos: readonly string[]): HTMLElement {
  const only = repos.length === 1
  return el('fieldset', { class: 'q-repos' },
    el('legend', {}, 'Repos this ticket touches'),
    el('div', { class: 'q-repo-list' }, ...repos.map(name => el('label', { class: 'q-repo' }, el('input', { type: 'checkbox', name: 'repos', value: name, checked: only }), name))))
}

export function createFolderPicker(input: HTMLInputElement, hooks: PickerHooks): FolderPicker {
  const note = el('small', { class: 'q-folder-check', role: 'status', hidden: true }, 'Checking folder…')
  const slot = el('div', { class: 'q-repos-slot' })
  let known: FolderState | null = null
  let ticket = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let waiting = false
  let inflight: { path: string; result: Promise<FolderState | null> } | null = null

  const setBusy = (on: boolean): void => { note.hidden = !on; hooks.busy(on) }
  const show = (state: FolderState | null): void => {
    known = state
    slot.replaceChildren(...(state?.kind === 'parent' ? [repoList(state.repos)] : []), ...(state !== null && state.skipped > 0 ? [skippedNote(state.skipped)] : []))
    hooks.problem(state?.kind === 'none' ? state.error : '')
  }
  const stop = (): void => { clearTimeout(timer); waiting = false; ticket += 1; inflight = null; setBusy(false) }

  async function run(path: string): Promise<FolderState | null> {
    const mine = ++ticket
    setBusy(true)
    const state = readFolder(path, await getJson(`/api/queue/folder?path=${encodeURIComponent(path)}`))
    if (mine !== ticket) return null
    inflight = null
    setBusy(false)
    show(state)
    return state
  }

  function check(): Promise<FolderState | null> {
    clearTimeout(timer)
    waiting = false
    const path = input.value.trim()
    if (path === '') { stop(); show(null); return Promise.resolve(null) }
    if (known?.path === path) return Promise.resolve(known)
    if (inflight?.path === path) return inflight.result
    const result = run(path)
    inflight = { path, result }
    return result
  }

  input.addEventListener('input', () => { clearTimeout(timer); waiting = true; timer = setTimeout(() => { void check() }, CHECK_DELAY_MS) })
  input.addEventListener('blur', () => { void check() })

  return {
    note,
    slot,
    check,
    known: () => (known?.path === input.value.trim() ? known : null),
    checking: () => inflight !== null,
    settling: () => waiting || inflight !== null,
    ticked: () => [...slot.querySelectorAll<HTMLInputElement>('input[name="repos"]')].filter(box => box.checked).map(box => box.value),
    reset: () => { stop(); known = null; slot.replaceChildren() },
  }
}

