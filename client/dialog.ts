type DialogOptions = { confirmLabel?: string; cancelLabel?: string; danger?: boolean }
type Parts = { dialog: HTMLDialogElement; form: HTMLFormElement; confirm: HTMLButtonElement; cancel: HTMLButtonElement }

export function splitMessage(message: string): { title: string; detail: string } {
  const at = message.indexOf('? ')
  if (at === -1) return { title: message, detail: '' }
  return { title: message.slice(0, at + 1), detail: message.slice(at + 2) }
}

function build(title: string, body: HTMLElement | null, options: DialogOptions): Parts {
  const dialog = document.createElement('dialog')
  dialog.className = 'mc-dialog'
  if (options.danger) dialog.dataset.tone = 'danger'
  const form = document.createElement('form')
  form.method = 'dialog'
  const heading = document.createElement('h2')
  heading.textContent = title
  const cancel = document.createElement('button')
  cancel.type = 'button'; cancel.className = 'mc-dialog-cancel'; cancel.textContent = options.cancelLabel ?? 'Cancel'
  const confirm = document.createElement('button')
  confirm.type = 'submit'; confirm.className = 'mc-dialog-confirm'; confirm.textContent = options.confirmLabel ?? 'Confirm'
  const actions = document.createElement('div')
  actions.className = 'mc-dialog-actions'
  actions.append(cancel, confirm)
  form.append(heading)
  if (body) form.append(body)
  form.append(actions)
  dialog.append(form)
  document.body.append(dialog)
  return { dialog, form, confirm, cancel }
}

function run<T>(parts: Parts, read: () => T): Promise<T | null> {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  return new Promise(resolve => {
    let settled = false
    const finish = (value: T | null) => {
      if (settled) return
      settled = true
      parts.dialog.close(); parts.dialog.remove(); opener?.focus(); resolve(value)
    }
    parts.cancel.onclick = () => finish(null)
    parts.dialog.oncancel = event => { event.preventDefault(); finish(null) }
    parts.dialog.onclick = event => { if (event.target === parts.dialog) finish(null) }
    parts.form.onsubmit = event => { event.preventDefault(); finish(read()) }
    parts.dialog.showModal()
  })
}

export async function confirmDialog(message: string, options: DialogOptions = {}): Promise<boolean> {
  const { title, detail } = splitMessage(message)
  let body: HTMLElement | null = null
  if (detail) { body = document.createElement('p'); body.textContent = detail }
  const parts = build(title, body, options)
  parts.confirm.focus()
  return (await run(parts, () => true)) === true
}

export function promptDialog(title: string, value: string, options: DialogOptions = {}): Promise<string | null> {
  const input = document.createElement('input')
  input.type = 'text'; input.value = value; input.maxLength = 60; input.className = 'mc-dialog-input'; input.setAttribute('aria-label', title)
  const parts = build(title, input, { confirmLabel: 'Save', ...options })
  queueMicrotask(() => { input.focus(); input.select() })
  return run(parts, () => input.value.trim())
}
