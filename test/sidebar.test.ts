import { describe, expect, test } from 'bun:test'
import { sidebarGroups } from '../client/sidebar'
import type { HistoryItem } from '../client/chat-view'

const DAY = 86_400_000
const now = new Date(2026, 8, 25, 15, 0).getTime()
const chat = (id: string, updatedAt: number): HistoryItem => ({ kind: 'chat', id, title: id, updatedAt, project: null, running: false, agents: [] })
const terminal = (id: string, updatedAt: number): HistoryItem => ({ kind: 'terminal', id, title: id, updatedAt, cwd: '/tmp', engine: 'claude', sessionId: null })

describe('sidebarGroups', () => {
  test('items updated today, yesterday and 5 days ago land in Today, Yesterday and Earlier', () => {
    const groups = sidebarGroups([chat('today', now - 60_000), terminal('yesterday', now - DAY), chat('older', now - 5 * DAY)], now)
    expect(groups.map(group => [group.day, group.items.map(item => item.id)])).toEqual([['Today', ['today']], ['Yesterday', ['yesterday']], ['Earlier', ['older']]])
  })

  test('claude-history and outside items are dropped', () => {
    const groups = sidebarGroups([
      chat('c1', now),
      { kind: 'claude-history', id: 'h1', title: 'h1', updatedAt: now, cwd: '/tmp', bytes: 10 },
      { kind: 'outside', id: 'o1', title: 'o1', updatedAt: now, engine: 'claude', pid: 1, cwdHint: null, etime: '01:00' },
      terminal('t1', now),
    ], now)
    expect(groups).toEqual([{ day: 'Today', items: [chat('c1', now), terminal('t1', now)] }])
  })

  test('empty groups are omitted', () => {
    expect(sidebarGroups([chat('older', now - 5 * DAY)], now).map(group => group.day)).toEqual(['Earlier'])
    expect(sidebarGroups([], now)).toEqual([])
  })
})
