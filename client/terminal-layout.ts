export const MAX_PANES = 4
export type TerminalLayout = { ids: string[]; active: string | null; axis: 'horizontal' | 'vertical'; focused: boolean; ratio: number }

export function restoreLayout(raw: unknown, existing: string[]): TerminalLayout {
  const value = raw !== null && typeof raw === 'object' ? raw as Partial<TerminalLayout> : {}
  const ids = Array.isArray(value.ids) ? [...new Set(value.ids.filter((id) => existing.includes(id)))].slice(0, MAX_PANES) : []
  if (ids.length === 0 && existing[0]) ids.push(existing[0])
  return {
    ids,
    active: value.active && ids.includes(value.active) ? value.active : ids[0] ?? null,
    axis: value.axis === 'vertical' ? 'vertical' : 'horizontal',
    focused: value.focused === true,
    ratio: typeof value.ratio === 'number' && Number.isFinite(value.ratio) ? Math.max(25, Math.min(75, value.ratio)) : 50,
  }
}

export function selectSession(layout: TerminalLayout, id: string, split: boolean): { layout: TerminalLayout; limited: boolean } {
  if (layout.ids.includes(id)) return { layout: { ...layout, active: id }, limited: false }
  if (split && layout.ids.length >= MAX_PANES) return { layout, limited: true }
  const ids = [...layout.ids]
  if (split || ids.length === 0) ids.push(id)
  else ids[Math.max(0, ids.indexOf(layout.active ?? ''))] = id
  return { layout: { ...layout, ids, active: id, focused: false }, limited: false }
}

export function visibleSessions(layout: TerminalLayout, width: number): string[] {
  return width <= 760 || layout.focused ? layout.active ? [layout.active] : [] : layout.ids
}
