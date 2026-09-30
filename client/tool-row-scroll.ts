export type RowState = { open: boolean; scrollTop: number }

export function trackRowScroll(row: HTMLDetailsElement): void {
  const out = row.querySelector<HTMLElement>('.term-out')
  if (out === null) return
  out.addEventListener('scroll', () => { row.dataset.scroll = String(out.scrollTop) }, { passive: true })
}

export function rowScrollOf(row: HTMLDetailsElement): number {
  const steps = row.closest<HTMLDetailsElement>('details.turn-steps')
  const out = row.querySelector<HTMLElement>('.term-out')
  return row.open && (steps === null || steps.open) && out !== null ? out.scrollTop : Number(row.dataset.scroll ?? 0)
}

export function setRowScroll(row: HTMLDetailsElement, scrollTop: number): void {
  const out = row.querySelector<HTMLElement>('.term-out')
  if (out === null || scrollTop === 0) return
  const steps = row.closest<HTMLDetailsElement>('details.turn-steps')
  if (row.open && (steps === null || steps.open)) {
    out.scrollTop = scrollTop
    return
  }
  row.dataset.scroll = String(scrollTop)
  const host = row.open && steps !== null ? steps : row
  host.addEventListener('toggle', () => {
    if (!host.open) return
    const saved = row.dataset.scroll ?? '0'
    delete row.dataset.scroll
    requestAnimationFrame(() => { out.scrollTop = Number(saved) })
  }, { once: true })
}

export function collectRowStates(reply: HTMLElement): Map<string, RowState> {
  const states = new Map<string, RowState>()
  for (const row of reply.querySelectorAll<HTMLDetailsElement>('.tool-row')) {
    states.set(row.dataset.key ?? '', { open: row.open, scrollTop: rowScrollOf(row) })
  }
  return states
}
