const paths = {
  terminal: 'm4 6 4 4-4 4m7 0h5',
  focus: 'M7 3H3v4m10-4h4v4M3 13v4h4m6 0h4v-4',
  restore: 'M3 7h4V3m6 0v4h4M3 13h4v4m6 0v-4h4',
  horizontal: 'M3 4h14v12H3ZM10 4v12',
  vertical: 'M3 4h14v12H3ZM3 10h14',
  chat: 'M16 14H8l-4 3V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2ZM7 7h8M7 10h5',
  chevron: 'm5 12 5-5 5 5',
  add: 'M10 4v12M4 10h12',
  search: 'M9 4a5 5 0 1 0 0 10a5 5 0 1 0 0-10M13 13l4 4',
  reconnect: 'M16 5v4h-4M15.6 9a6 6 0 1 0-.4 4',
  close: 'M5 5l10 10M15 5L5 15',
  minus: 'M4 10h12',
} as const

export function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI!, 'path')
  path.setAttribute('d', paths[name]); svg.append(path)
  return svg
}

export function ui(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag); node.className = className; node.textContent = text
  return node
}

export function providerName(engine: string): string {
  return ({claude:'Claude',codex:'Codex',glm:'GLM'} as Record<string,string>)[engine] ?? engine
}

export function connectionLabel(state?: string): string {
  return ({live:'Connected',closed:'Disconnected',error:'Connection failed'} as Record<string,string>)[state ?? ''] ?? 'Connecting'
}

function collapsible(key: string, toggleId: string, apply: (open: boolean) => void): void {
  const toggle = document.getElementById(toggleId)
  if (!toggle) return
  let open = true
  try { open = localStorage.getItem(key) !== '0' } catch {}
  const sync = () => { apply(open); toggle.setAttribute('aria-expanded', String(open)); toggle.title = `${open ? 'Collapse' : 'Expand'} ${toggle.dataset.label ?? ''}`.trim(); dispatchEvent(new Event('resize')) }
  toggle.addEventListener('click', () => { open = !open; try { localStorage.setItem(key, open ? '1' : '0') } catch {}; sync() })
  sync()
}
function installPanels(root: HTMLElement, chat: HTMLElement): void {
  const sidebarToggle = document.getElementById('sidebar-toggle'), flowToggle = document.getElementById('flow-toggle')
  if (flowToggle) flowToggle.dataset.label = 'work flow'
  collapsible('mc.flow.open', 'flow-toggle', open => document.getElementById('flow-overview')?.classList.toggle('collapsed', !open))
  if (sidebarToggle) installSidebar(root, sidebarToggle, chat)
}
function installSidebar(root: HTMLElement, toggle: HTMLElement, chat: HTMLElement): void {
  const key = 'mc.sidebar.open'
  const manual = (): boolean | null => { try { const value = localStorage.getItem(key); return value === '1' ? true : value === '0' ? false : null } catch { return null } }
  const agentsActive = (): boolean => document.getElementById('active-agent-windows')?.dataset.active === 'true'
  const apply = (): void => {
    const open = manual() ?? agentsActive()
    root.classList.toggle('sidebar-collapsed', !open)
    for (const control of [toggle, chat]) control.setAttribute('aria-expanded', String(open))
    chat.setAttribute('aria-pressed', String(open))
    toggle.title = open ? 'Collapse agents' : 'Expand agents'
    dispatchEvent(new Event('resize'))
  }
  toggle.addEventListener('click', () => { const open = root.classList.contains('sidebar-collapsed'); try { localStorage.setItem(key, open ? '1' : '0') } catch {}; apply() })
  chat.addEventListener('click', () => toggle.click())
  addEventListener('mc:agents-active', () => { try { localStorage.removeItem(key) } catch {}; apply() })
  apply()
}
export function installTerminalShell(): void {
  const root = document.querySelector<HTMLElement>('#termgrid')
  if (!root || root.dataset.design === 'approved') return
  root.dataset.design = 'approved'; root.classList.add('terminal-workspace')
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'; stylesheet.href = '/terminal-design.css'; document.head.append(stylesheet)
  const heading = root.querySelector('.workspace-heading')!, tools = root.querySelector('.terminal-tools')!
  tools.className = 'terminal-tools view-controls'
  const arrangement = ui('div', 'arrangement')
  for (const [id, glyph, label] of [['split-horizontal','horizontal','Side by side'],['split-vertical','vertical','Stacked']] as const) {
    const button = document.getElementById(id)!
    button.replaceChildren(icon(glyph), document.createTextNode(label)); arrangement.append(button)
  }
  const chat = document.getElementById('activity-open')!
  chat.className = 'conversation-control'; chat.replaceChildren(icon('chat'), document.createTextNode('Agents'))
  tools.replaceChildren(arrangement, ui('span', 'control-divider'), chat); heading.append(tools)
  installPanels(root, chat)
}
