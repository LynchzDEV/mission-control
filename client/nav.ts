const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (EDITABLE.has(target.tagName)) return true
  return target.isContentEditable
}

function destinationFor(key: string): string | null {
  const link = document.querySelector<HTMLAnchorElement>(`#tabs a[data-key="${key}"]`)
  return link === null ? null : link.getAttribute('href')
}

export function installTabShortcuts(): void {
  addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
    const href = destinationFor(event.key)
    if (href === null) return
    event.preventDefault()
    location.assign(href)
  })
}

installTabShortcuts()
