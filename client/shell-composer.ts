import { getJson, pathsFromUriList, readArray, shellQuote, uploadDrop } from './shared'
import { morph, reveal } from './morph'
import { attachmentChip, type AttachmentChip } from './attachments'
import { customModelChoice, launchChoice, readRecentDirectories, type LaunchProvider } from './shell-launch'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const engineKey = 'mc.shell.engine', modelKey = 'mc.shell.model', editKey = 'mc.shell.edit', projectKey = 'mc.shell.project', recentKey = 'mc.term.recentCwd'
const group = $('chip-group')
const projectChip = $('project-chip') as HTMLButtonElement
const modelChip = $('model-chip') as HTMLButtonElement
const editChip = $('edit-chip') as HTMLButtonElement
const chipExtra = $('chip-extra')
const projectMenu = $('project-menu')
const modelMenu = $('model-menu')
let providers: LaunchProvider[] = []

const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string | null): void => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key) } catch {} }
const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

function row(label: string, detail: string, iconId: string | null, logo: string | null, current: boolean, action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `row${current ? ' current' : ''}`
  if (logo) { const img = document.createElement('img'); img.src = logo; img.alt = ''; button.append(img) }
  else if (iconId) button.insertAdjacentHTML('afterbegin', `<svg><use href="#${iconId}"/></svg>`)
  const text = document.createElement('span'); text.textContent = label
  if (detail) { const small = document.createElement('small'); small.textContent = detail; text.append(small) }
  button.append(text)
  if (current) button.insertAdjacentHTML('beforeend', '<svg class="check"><use href="#check-icon"/></svg>')
  button.onclick = () => { action(); closeMenus() }
  return button
}

function paintProject(): void {
  const project = stored(projectKey)
  morph(projectChip, () => { $('project-name').textContent = project ? basename(project) : 'Auto' })
  projectChip.title = project ? `Project for this chat: ${project}` : 'Project for this chat: detected from your message'
}

function paintModel(): void {
  const choice = launchChoice(providers, stored(engineKey), stored(modelKey))
  const provider = providers.find(item => item.id === choice.engine)
  morph(modelChip, () => {
    ;($('model-logo') as HTMLImageElement).src = `/providers/${choice.engine || 'claude'}.svg`
    $('model-name').textContent = provider ? choice.model || provider.name : 'Chat default'
  })
}

function paintEdit(): void {
  editChip.setAttribute('aria-pressed', String(stored(editKey) === '1'))
}

function fillProjectMenu(): void {
  const current = stored(projectKey)
  const recents = readRecentDirectories(stored(recentKey))
  projectMenu.replaceChildren(
    ...recents.map(cwd => row(basename(cwd), cwd, 'folder-icon', null, cwd === current, () => { store(projectKey, cwd); paintProject() })),
    row('Detect from my message', '', 'auto-icon', null, current === null, () => { store(projectKey, null); paintProject() }),
  )
}

function fillModelMenu(): void {
  const choice = launchChoice(providers, stored(engineKey), stored(modelKey))
  const nodes: HTMLElement[] = []
  for (const provider of providers) {
    const head = document.createElement('div'); head.className = 'group-label engine-head'
    const logo = document.createElement('img'); logo.src = `/providers/${provider.id}.svg`; logo.alt = ''
    head.append(logo, document.createTextNode(provider.name))
    nodes.push(head)
    const listed = provider.models.length ? provider.models : ['']
    const models = provider.id === choice.engine && choice.model && !listed.includes(choice.model) ? [...listed, choice.model] : listed
    for (const model of models) nodes.push(row(model || `${provider.name} default`, '', null, null, provider.id === choice.engine && model === choice.model, () => { store(engineKey, provider.id); store(modelKey, model || null); paintModel() }))
  }
  if (!providers.length) { modelMenu.replaceChildren(row('No AI providers available', '', null, null, false, () => {})); return }
  const divider = document.createElement('div'); divider.className = 'divider'
  const customRow = row('Custom model…', '', null, null, false, () => {
    const custom = customModelChoice(providers, stored(engineKey), prompt('Model ID', choice.model) ?? '')
    if (custom) { store(engineKey, custom.engine); store(modelKey, custom.model); paintModel() }
  })
  customRow.classList.add('muted')
  nodes.push(divider, customRow)
  modelMenu.replaceChildren(...nodes)
}

function closeMenus(): void {
  for (const [menu, chip] of [[projectMenu, projectChip], [modelMenu, modelChip]] as const) { reveal(menu, false, 'left bottom'); chip.setAttribute('aria-expanded', 'false') }
}

function toggleMenu(menu: HTMLElement, chip: HTMLButtonElement, fill: () => void): void {
  const open = menu.hidden
  closeMenus()
  if (!open) return
  paintModel()
  fill()
  reveal(menu, true, 'left bottom')
  chip.setAttribute('aria-expanded', 'true')
}

projectChip.onclick = () => {
  const expand = group.dataset.expanded !== 'true'
  group.dataset.expanded = String(expand)
  chipExtra.inert = !expand
  if (expand) toggleMenu(projectMenu, projectChip, fillProjectMenu)
  else closeMenus()
}
modelChip.onclick = () => toggleMenu(modelMenu, modelChip, fillModelMenu)
editChip.onclick = () => { store(editKey, stored(editKey) === '1' ? null : '1'); paintEdit() }
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Node) || group.contains(event.target) || projectMenu.contains(event.target) || modelMenu.contains(event.target)) return
  closeMenus()
})
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenus() })

const composer = $('composer')
const message = $('message') as HTMLTextAreaElement
const tray = $('attach-tray')
const toast = (text: string): void => { dispatchEvent(new CustomEvent('quiet:toast', { detail: text })) }
const hasFiles = (transfer: DataTransfer | null): boolean => !!transfer && (transfer.types.includes('Files') || transfer.types.includes('text/uri-list'))
const fileCount = (count: number): string => `${count} file${count === 1 ? '' : 's'}`

type Attachment = AttachmentChip
const attachments: Attachment[] = []

function paintTray(): void {
  tray.replaceChildren(...attachments.map(entry => entry.chip))
  tray.hidden = attachments.length === 0
  composer.classList.toggle('has-tray', attachments.length > 0)
}

function detach(entry: Attachment, removeFromMessage: boolean): void {
  if (removeFromMessage) message.value = message.value.replace(entry.token, '')
  if (entry.url !== null) URL.revokeObjectURL(entry.url)
  attachments.splice(attachments.indexOf(entry), 1)
  paintTray()
}

function attachChips(paths: string[], files: File[]): void {
  paths.forEach((path, index) => {
    const entry = attachmentChip(path, files[index] ?? null, shellQuote)
    entry.chip.querySelector('.attach-remove')?.addEventListener('click', () => {
      detach(entry, true)
      message.dispatchEvent(new Event('input', { bubbles: true }))
    })
    attachments.push(entry)
  })
  paintTray()
}

async function attach(files: File[], dropped: string[]): Promise<void> {
  if (files.length === 0 && dropped.length === 0) { toast('Nothing to add'); return }
  let paths = dropped
  let uploaded = false
  if (paths.length === 0) {
    toast(`Adding ${fileCount(files.length)}…`)
    try { paths = await Promise.all(files.map(uploadDrop)); uploaded = true }
    catch (error) { toast(error instanceof Error ? error.message : 'Upload failed'); return }
  }
  message.focus()
  message.setRangeText(`${paths.map(shellQuote).join(' ')} `, message.selectionStart, message.selectionEnd, 'end')
  attachChips(paths, uploaded ? files : [])
  message.dispatchEvent(new Event('input', { bubbles: true }))
  toast(`Added ${fileCount(paths.length)}`)
}

message.addEventListener('input', () => {
  const stale = attachments.filter(entry => !message.value.includes(entry.token))
  if (stale.length === 0) return
  for (const entry of stale) detach(entry, false)
})

addEventListener('quiet:message-sent', () => {
  for (const entry of [...attachments]) detach(entry, false)
})

addEventListener('quiet:collect-images', (event) => {
  const detail = (event as CustomEvent<{ images: string[] }>).detail
  for (const entry of attachments) if (entry.kind === 'image') detail.images.push(entry.path)
})

addEventListener('quiet:message-restore', (event) => {
  const { text, images } = (event as CustomEvent<{ text: string; images: string[] }>).detail
  message.value = text
  attachChips(images, [])
  message.dispatchEvent(new Event('input', { bubbles: true }))
})

message.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length === 0) return
  event.preventDefault()
  void attach(files, [])
})
composer.addEventListener('dragover', (event) => {
  if (!hasFiles(event.dataTransfer)) return
  event.preventDefault()
  composer.dataset.drop = 'true'
})
composer.addEventListener('dragleave', (event) => { if (!composer.contains(event.relatedTarget as Node | null)) delete composer.dataset.drop })
composer.addEventListener('drop', (event) => {
  if (!hasFiles(event.dataTransfer)) return
  event.preventDefault()
  delete composer.dataset.drop
  void attach(Array.from(event.dataTransfer?.files ?? []), pathsFromUriList(event.dataTransfer?.getData('text/uri-list') ?? ''))
})

paintProject()
paintEdit()
paintModel()
void getJson('/api/providers').then(result => {
  if (!result.ok) return
  providers = (readArray(result.data.providers) as LaunchProvider[]).filter(item => typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.models))
  paintModel()
})

export {}
