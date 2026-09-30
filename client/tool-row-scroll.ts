export type RowState = { open: boolean; scrollTop: number }

const wiredRows = new WeakSet<HTMLDetailsElement>()
const wiredSteps = new WeakSet<HTMLDetailsElement>()

function applyPendingScroll(row: HTMLDetailsElement): void {
  const saved = row.dataset.scroll
  const out = row.querySelector<HTMLElement>('.term-out')
  if (saved === undefined || out === null) return
  delete row.dataset.scroll
  requestAnimationFrame(() => { out.scrollTop = Number(saved) })
}

function wireRowToggle(row: HTMLDetailsElement): void {
  if (wiredRows.has(row)) return
  wiredRows.add(row)
  row.addEventListener('toggle', () => {
    if (!row.open) return
    const steps = row.closest<HTMLDetailsElement>('details.turn-steps')
    if (steps !== null && !steps.open) return
    applyPendingScroll(row)
  })
}

function wireStepsToggle(steps: HTMLDetailsElement): void {
  if (wiredSteps.has(steps)) return
  wiredSteps.add(steps)
  steps.addEventListener('toggle', () => {
    if (!steps.open) return
    for (const row of steps.querySelectorAll<HTMLDetailsElement>('.tool-row[data-scroll]')) {
      if (row.open) applyPendingScroll(row)
    }
  })
}

export function trackRowScroll(row: HTMLDetailsElement): void {
  const out = row.querySelector<HTMLElement>('.term-out')
  if (out !== null) out.addEventListener('scroll', () => { row.dataset.scroll = String(out.scrollTop) }, { passive: true })
  wireRowToggle(row)
}

export function rowScrollOf(row: HTMLDetailsElement): number {
  const steps = row.closest<HTMLDetailsElement>('details.turn-steps')
  const out = row.querySelector<HTMLElement>('.term-out')
  return row.open && (steps === null || steps.open) && out !== null ? out.scrollTop : Number(row.dataset.scroll ?? 0)
}

export function setRowScroll(row: HTMLDetailsElement, scrollTop: number): void {
  if (scrollTop === 0) return
  const steps = row.closest<HTMLDetailsElement>('details.turn-steps')
  if (row.open && (steps === null || steps.open)) {
    const out = row.querySelector<HTMLElement>('.term-out')
    if (out !== null) out.scrollTop = scrollTop
    return
  }
  row.dataset.scroll = String(scrollTop)
  if (steps !== null && !steps.open) wireStepsToggle(steps)
}

export function collectRowStates(reply: HTMLElement): Map<string, RowState> {
  const states = new Map<string, RowState>()
  for (const row of reply.querySelectorAll<HTMLDetailsElement>('.tool-row')) {
    states.set(row.dataset.key ?? '', { open: row.open, scrollTop: rowScrollOf(row) })
  }
  return states
}
