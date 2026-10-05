import { errorText, postJson, readRecord, type JsonRecord } from './shared'
import { readRecentDirectories } from './shell-launch'
import { el, icon, lineText, type QueueFlow, type QueueItemView, type QueuePlugin } from './queue-view'

export type AddDialogSource = { plugins: QueuePlugin[]; flows: QueueFlow[]; items: QueueItemView[] }
export type AddDialog = { open(): void }

const RECENT_CWD_KEY = 'mc.term.recentCwd'
type Position = 'end' | 'next'

export function parseItemRef(text: string): string {
  const trimmed = text.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  try {
    return new URL(trimmed).pathname.split('/').filter(segment => segment !== '').at(-1) ?? ''
  } catch {
    return ''
  }
}

function storedRecents(): string[] {
  try { return readRecentDirectories(localStorage.getItem(RECENT_CWD_KEY)) } catch { return [] }
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

function positionNote(position: Position, items: readonly QueueItemView[]): string {
  const queued = items.filter(item => item.state === 'queued').length
  const place = position === 'next' ? 'Next up' : lineText(items, queued)
  return `${place}. Replies from requesters still jump ahead.`
}

export function createAddDialog(source: () => AddDialogSource, toast: (text: string) => void): AddDialog {
  const sourceSelect = el('select', { name: 'source' }) as HTMLSelectElement
  const refInput = el('input', { name: 'ref', placeholder: 'Paste a task link or id', autocomplete: 'off', spellcheck: 'false', required: true }) as HTMLInputElement
  const recents = el('datalist', { id: 'queue-add-recents' }) as HTMLDataListElement
  const repoInput = el('input', { name: 'repo', list: 'queue-add-recents', placeholder: '/path/to/your/repo', autocomplete: 'off', spellcheck: 'false', required: true }) as HTMLInputElement
  const flowSelect = el('select', { name: 'flow' }) as HTMLSelectElement
  const endButton = el('button', { type: 'button', 'data-position': 'end', 'aria-pressed': 'true' }, 'End of queue')
  const nextButton = el('button', { type: 'button', 'data-position': 'next', 'aria-pressed': 'false' }, 'Next up')
  const note = el('small', {})
  const error = el('p', { class: 'q-add-error', role: 'alert', hidden: true })
  const submit = el('button', { type: 'submit', class: 'connection-button primary' }, 'Add') as HTMLButtonElement
  const cancel = el('button', { type: 'button', class: 'connection-button' }, 'Cancel')
  const form = el('form', { class: 'field-stack q-add-form' },
    el('label', { class: 'mk-field' }, 'Source', sourceSelect),
    el('label', { class: 'mk-field' }, 'Task link or id', refInput),
    el('label', { class: 'mk-field' }, 'Build in', repoInput, recents, el('small', {}, 'A git folder in your home folder. The item gets its own worktree there.')),
    el('label', { class: 'mk-field' }, 'Flow', flowSelect),
    el('div', { class: 'mk-field' }, 'Position', el('div', { class: 'mk-seg' }, endButton, nextButton), note),
    error,
    el('footer', { class: 'q-add-foot' }, cancel, submit)) as HTMLFormElement
  const close = el('button', { type: 'submit', class: 'round', 'aria-label': 'Close' }, icon('close-icon'))
  const dialog = el('dialog', { class: 'access-dialog flat q-add', 'aria-labelledby': 'queue-add-title' },
    el('header', { class: 'dialog-heading' },
      el('div', {}, el('h2', { id: 'queue-add-title' }, 'Add to queue'), el('p', { class: 'muted' }, 'Mission Control builds it in its own worktree.')),
      el('form', { method: 'dialog' }, close)),
    form) as HTMLDialogElement
  let position: Position = 'end'

  const showError = (text: string): void => { error.textContent = text; error.hidden = text === '' }
  const setPosition = (next: Position): void => {
    position = next
    endButton.setAttribute('aria-pressed', String(next === 'end'))
    nextButton.setAttribute('aria-pressed', String(next === 'next'))
    note.textContent = positionNote(next, source().items)
  }
  endButton.addEventListener('click', () => setPosition('end'))
  nextButton.addEventListener('click', () => setPosition('next'))
  cancel.addEventListener('click', () => dialog.close())

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const externalId = parseItemRef(refInput.value)
    const repo = repoInput.value.trim()
    if (sourceSelect.value === '') { showError('Turn on a source plugin in Marketplace first'); return }
    if (externalId === '') { showError('Paste a task link or id'); return }
    if (repo === '') { showError('Choose the folder to build in'); return }
    const body: JsonRecord = { source: sourceSelect.value, externalId, repo, ...(flowSelect.value === '' ? {} : { flowId: flowSelect.value }), position }
    showError('')
    submit.disabled = true
    submit.textContent = 'Adding…'
    void postJson('/api/queue', body).then((result) => {
      submit.disabled = false
      submit.textContent = 'Add'
      if (!result.ok) { showError(errorText(result)); return }
      const title = readRecord(result.data.item).title
      dialog.close()
      toast(typeof title === 'string' && title !== '' ? `Added ${title}` : 'Added to the queue')
    })
  })

  return {
    open(): void {
      const { plugins, flows } = source()
      const enabled = plugins.filter(plugin => plugin.enabled)
      const chosen = sourceSelect.value
      sourceSelect.replaceChildren(...enabled.map(plugin => option(plugin.id, plugin.name)))
      if (enabled.some(plugin => plugin.id === chosen)) sourceSelect.value = chosen
      sourceSelect.disabled = enabled.length === 0
      flowSelect.replaceChildren(option('', 'Default flow'), ...flows.map(flow => option(flow.id, flow.name)))
      recents.replaceChildren(...storedRecents().map(path => option(path, path)))
      refInput.value = ''
      setPosition('end')
      showError(enabled.length === 0 ? 'Turn on a source plugin in Marketplace first' : '')
      submit.disabled = enabled.length === 0
      if (!dialog.isConnected) document.body.append(dialog)
      dialog.showModal()
      refInput.focus()
    },
  }
}
