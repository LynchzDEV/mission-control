const paths = {
  terminal: 'm4 6 4 4-4 4m7 0h5',
  focus: 'M7 3H3v4m10-4h4v4M3 13v4h4m6 0h4v-4',
  restore: 'M3 7h4V3m6 0v4h4M3 13h4v4m6 0v-4h4',
  horizontal: 'M3 4h14v12H3ZM10 4v12',
  vertical: 'M3 4h14v12H3ZM3 10h14',
  chat: 'M16 14H8l-4 3V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2ZM7 7h8M7 10h5',
  chevron: 'm5 12 5-5 5 5',
  add: 'M10 4v12M4 10h12',
  more: 'M4 10h.01M10 10h.01M16 10h.01',
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

export function installTerminalShell(): void {
  const root = document.querySelector<HTMLElement>('#termgrid')
  if (!root || root.dataset.design === 'approved') return
  root.dataset.design = 'approved'; root.classList.add('terminal-workspace')
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'; stylesheet.href = '/terminal-design.css'; document.head.append(stylesheet)
  const heading = root.querySelector('.workspace-heading')!, tools = root.querySelector('.terminal-tools')!
  tools.className = 'terminal-tools view-controls'
  const arrangement = ui('div', 'arrangement'), utilities = document.createElement('details')
  utilities.className = 'terminal-utilities'
  const summary = ui('summary'); summary.setAttribute('aria-label', 'Terminal actions'); summary.title = 'Terminal actions'; summary.append(icon('more'))
  const menu = ui('div', 'terminal-actions'); utilities.append(summary, menu)
  for (const [id, glyph, label] of [['split-horizontal','horizontal','Side by side'],['split-vertical','vertical','Stacked']] as const) {
    const button = document.getElementById(id)!
    button.replaceChildren(icon(glyph), document.createTextNode(label)); arrangement.append(button)
  }
  const chat = document.getElementById('activity-open')!
  chat.className = 'conversation-control'; chat.replaceChildren(icon('chat'), document.createTextNode('Agent chat'))
  for (const id of ['term-focus','term-find','term-reconnect','directory-toggle']) {
    const button = document.getElementById(id)
    if (button) menu.append(button)
  }
  menu.addEventListener('click', event => { if ((event.target as HTMLElement).closest('button')) utilities.open = false })
  tools.replaceChildren(arrangement, ui('span', 'control-divider'), chat, utilities); heading.append(tools)
  const newTerminal = document.getElementById('term-new')!
  newTerminal.className = 'add-session'; newTerminal.replaceChildren(icon('add'), document.createTextNode('New terminal'))
  document.getElementById('term-strip')?.classList.add('session-strip')
}
