import { getJson, readArray } from './shared'
import { launchChoice, readRecentDirectories, type LaunchProvider } from './shell-launch'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const engineKey = 'mc.shell.engine', modelKey = 'mc.shell.model', editKey = 'mc.shell.edit', projectKey = 'mc.shell.project', recentKey = 'mc.term.recentCwd'
const group = $('chip-group')
const projectChip = $('project-chip') as HTMLButtonElement
const modelChip = $('model-chip') as HTMLButtonElement
const editChip = $('edit-chip') as HTMLButtonElement
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
  $('project-name').textContent = project ? basename(project) : 'Auto'
  projectChip.title = project ? `Project for this chat: ${project}` : 'Project for this chat: detected from your message'
}

function paintModel(): void {
  const choice = launchChoice(providers, stored(engineKey), stored(modelKey))
  const provider = providers.find(item => item.id === choice.engine)
  ;($('model-logo') as HTMLImageElement).src = `/providers/${choice.engine || 'claude'}.svg`
  $('model-name').textContent = provider ? choice.model || provider.name : 'Chat default'
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
    const models = provider.models.length ? provider.models : ['']
    for (const model of models) nodes.push(row(model || `${provider.name} default`, '', null, null, provider.id === choice.engine && model === choice.model, () => { store(engineKey, provider.id); store(modelKey, model || null); paintModel() }))
  }
  const divider = document.createElement('div'); divider.className = 'divider'
  nodes.push(divider, row('Custom model…', '', null, null, false, () => {
    const custom = prompt('Model ID', choice.model)
    if (custom && custom.trim()) { store(modelKey, custom.trim()); paintModel() }
  }))
  modelMenu.replaceChildren(...nodes)
}

function closeMenus(): void {
  for (const [menu, chip] of [[projectMenu, projectChip], [modelMenu, modelChip]] as const) { menu.hidden = true; chip.setAttribute('aria-expanded', 'false') }
}

function toggleMenu(menu: HTMLElement, chip: HTMLButtonElement, fill: () => void): void {
  const open = menu.hidden
  closeMenus()
  if (!open) return
  fill()
  menu.hidden = false
  chip.setAttribute('aria-expanded', 'true')
}

projectChip.onclick = () => {
  const expand = group.dataset.expanded !== 'true'
  group.dataset.expanded = String(expand)
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

paintProject()
paintEdit()
paintModel()
void getJson('/api/providers').then(result => {
  if (!result.ok) return
  providers = (readArray(result.data.providers) as LaunchProvider[]).filter(item => typeof item.id === 'string' && typeof item.name === 'string')
  paintModel()
})

export {}
