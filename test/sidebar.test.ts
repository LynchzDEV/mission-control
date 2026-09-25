import { describe, expect, test } from 'bun:test'
import { sidebarGroups, withLiveTerminals } from '../client/sidebar'
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

describe('withLiveTerminals', () => {
  const session = (id: string, title = id) => ({ id, engine: 'codex', cwd: '/work', title })

  test('history is used as is until the live terminal list arrives', () => {
    const items = [chat('c1', now), terminal('t1', now - DAY)]
    expect(withLiveTerminals(items, null, now)).toEqual(items)
  })

  test('a live terminal the history poll has not seen yet appears at the top', () => {
    const merged = withLiveTerminals([chat('c1', now - 60_000)], [session('fresh')], now)
    expect(merged.map(item => [item.kind, item.id, item.updatedAt])).toEqual([['terminal', 'fresh', now], ['chat', 'c1', now - 60_000]])
  })

  test('live sessions keep their history time and take the renamed title', () => {
    const merged = withLiveTerminals([terminal('t1', now - DAY)], [session('t1', 'Renamed')], now)
    expect(merged).toEqual([{ kind: 'terminal', id: 't1', title: 'Renamed', updatedAt: now - DAY, cwd: '/work', engine: 'codex', sessionId: null }])
  })

  test('a terminal that ended drops out even while history still lists it', () => {
    expect(withLiveTerminals([terminal('gone', now), chat('c1', now)], [], now).map(item => item.id)).toEqual(['c1'])
  })
})
