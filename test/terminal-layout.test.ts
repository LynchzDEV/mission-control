import { describe, expect, test } from 'bun:test'
import { restoreLayout, selectSession, visibleSessions, MAX_PANES } from '../client/terminal-layout'

describe('persistent terminal layout', () => {
  test('empty and obsolete saved sessions never create a session', () => {
    expect(restoreLayout({ ids: ['gone'], active: 'gone' }, [])).toEqual({ ids: [], active: null, axis: 'horizontal', focused: false, ratio: 50 })
    expect(restoreLayout('broken', ['a']).ids).toEqual(['a'])
  })
  test('restores only existing unique peers and repairs the active session', () => {
    const layout = restoreLayout({ ids: ['a', 'a', 'gone', 'b'], active: 'gone', ratio: 100 }, ['a', 'b'])
    expect(layout.ids).toEqual(['a', 'b'])
    expect(layout.active).toBe('a')
    expect(layout.ratio).toBe(75)
  })
  test('switching replaces the active pane and split limits give explicit feedback', () => {
    const a = restoreLayout(null, ['a', 'b', 'c', 'd', 'e'])
    const b = selectSession(a, 'b', true).layout
    expect(b.ids).toEqual(['a', 'b'])
    expect(selectSession(b, 'c', false).layout.ids).toEqual(['a', 'c'])
    const full = restoreLayout({ ids: ['a', 'b', 'c', 'd'] }, ['a', 'b', 'c', 'd', 'e'])
    expect(full.ids.length).toBe(MAX_PANES)
    expect(selectSession(full, 'e', true).limited).toBe(true)
    expect(selectSession(full, 'e', true).layout).toEqual(full)
  })
  test('focus and mobile show the active peer without discarding the split', () => {
    const layout = restoreLayout({ ids: ['a', 'b'], active: 'b' }, ['a', 'b'])
    expect(visibleSessions(layout, 320)).toEqual(['b'])
    expect(visibleSessions({ ...layout, focused: true }, 1200)).toEqual(['b'])
    expect(visibleSessions(layout, 1200)).toEqual(['a', 'b'])
    expect(layout.ids).toEqual(['a', 'b'])
  })
})
