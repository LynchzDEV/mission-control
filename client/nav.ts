const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (EDITABLE.has(target.tagName)) return true
  return target.isContentEditable
}

function destinationFor(key: string): string | null {
  const link = document.querySelector<HTMLAnchorElement>(`#tabs a[data-key="${key}"]`)
  const routes: Record<string, string> = { '1': '/lanes', '2': '/dispatch', '3': '/terminals', '4': '/review', '5': '/settings' }
  return link?.getAttribute('href') ?? routes[key] ?? null
}

export function installTabShortcuts(): void {
  addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
    const href = destinationFor(event.key)
    if (href === null) return
    event.preventDefault()
    dispatchEvent(new CustomEvent('mc:navigate', { detail: href }))
  })
}

installTabShortcuts()
