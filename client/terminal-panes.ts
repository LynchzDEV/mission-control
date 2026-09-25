import type { DockviewApi, GroupPanelPartInitParameters, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core'
import { createDockview, themeLight } from 'dockview-core/dist/dockview-core.js'

export type PaneHeader = { logo: string; title: string; caption: string }
export type PaneDirection = 'right' | 'below'
export type Panes = {
  show(id: string, host: HTMLElement, header: PaneHeader): void
  split(id: string, host: HTMLElement, header: PaneHeader, direction: PaneDirection): void
  hide(id: string): void
  retitle(id: string, header: PaneHeader): void
  shown(): string[]
  active(): string | null
  onHide(callback: (id: string) => void): void
  onActive(callback: (id: string) => void): void
}
type PaneParams = { host: HTMLElement; header: PaneHeader }

class Content implements IContentRenderer {
  readonly element = document.createElement('div')
  constructor() { this.element.className = 'pane-content' }
  init(parameters: GroupPanelPartInitParameters): void {
    this.element.append((parameters.params as PaneParams).host)
  }
}

class Tab implements ITabRenderer {
  readonly element = document.createElement('div')
  private readonly logo = document.createElement('img')
  private readonly title = document.createElement('span')
  private readonly caption = document.createElement('small')
  constructor() {
    this.element.className = 'pane-head'
    this.logo.className = 'logo'
    this.logo.alt = ''
    this.title.className = 'pane-title'
    this.element.append(this.logo, this.title, this.caption)
  }
  init(parameters: TabPartInitParameters): void {
    this.paint((parameters.params as PaneParams).header)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'round close-split'
    close.setAttribute('aria-label', 'Close this pane')
    close.insertAdjacentHTML('afterbegin', '<svg><use href="#close-icon"/></svg>')
    close.onclick = (event) => { event.stopPropagation(); parameters.api.close() }
    this.element.append(close)
  }
  paint(header: PaneHeader): void {
    this.logo.src = header.logo
    this.title.textContent = header.title
    this.caption.textContent = header.caption
  }
}

export function createPanes(root: HTMLElement): Panes {
  const tabs = new Map<string, Tab>()
  const api: DockviewApi = createDockview(root, {
    className: 'mc-panes',
    theme: themeLight,
    disableDnd: true,
    hideBorders: true,
    singleTabMode: 'fullwidth',
    createComponent: () => new Content(),
    createTabComponent: () => new Tab(),
  })
  const layout = (): void => { if (root.clientWidth > 0 && root.clientHeight > 0) api.layout(root.clientWidth, root.clientHeight) }
  new ResizeObserver(layout).observe(root)
  layout()
  const params = (host: HTMLElement, header: PaneHeader): PaneParams => ({ host, header })
  const add = (id: string, host: HTMLElement, header: PaneHeader, position?: { referencePanel: string; direction: PaneDirection | 'within' }) => {
    const panel = api.addPanel<PaneParams>({ id, component: 'terminal', tabComponent: 'terminal', title: header.title, params: params(host, header), ...(position ? { position } : {}) })
    tabs.set(id, panel.view.tab as unknown as Tab)
    panel.api.setActive()
  }
  return {
    show(id, host, header) {
      const existing = api.getPanel(id)
      if (existing) { existing.api.setActive(); return }
      const current = api.activePanel
      if (!current || api.panels.length <= 1) { api.closeAllGroups(); add(id, host, header); return }
      add(id, host, header, { referencePanel: current.id, direction: 'within' })
      current.api.close()
    },
    split(id, host, header, direction) {
      if (api.getPanel(id)) return
      const reference = api.activePanel ?? api.panels[0]
      if (!reference) { add(id, host, header); return }
      add(id, host, header, { referencePanel: reference.id, direction })
    },
    hide(id) { api.getPanel(id)?.api.close() },
    retitle(id, header) { api.getPanel(id)?.api.setTitle(header.title); tabs.get(id)?.paint(header) },
    shown: () => api.panels.map(panel => panel.id),
    active: () => api.activePanel?.id ?? null,
    onHide(callback) { api.onDidRemovePanel(panel => { tabs.delete(panel.id); callback(panel.id) }) },
    onActive(callback) { api.onDidActivePanelChange(event => { if (event.panel) callback(event.panel.id) }) },
  }
}
