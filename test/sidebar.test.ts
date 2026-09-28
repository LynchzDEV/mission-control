import { describe, expect, test } from 'bun:test'
import { numberedKeys, sidebarGroups, withLiveTerminals } from '../client/sidebar'
import type { HistoryItem } from '../client/chat-view'

const DAY = 86_400_000
const now = new Date(2026, 8, 25, 15, 0).getTime()
const chat = (id: string, updatedAt: number): HistoryItem => ({ kind: 'chat', id, title: id, updatedAt, project: null, running: false, agents: [] })
const terminal = (id: string, updatedAt: number, live = true): HistoryItem => ({ kind: 'terminal', id, title: id, updatedAt, cwd: '/tmp', engine: 'claude', sessionId: null, live })
const session = (id: string, updatedAt: number): HistoryItem => ({ kind: 'claude-history', id, title: id, updatedAt, cwd: '/Users/x', bytes: 10 })

describe('sidebarGroups', () => {
  test('items updated today, yesterday and 5 days ago land in Today, Yesterday and Earlier', () => {
    const groups = sidebarGroups([chat('today', now - 60_000), terminal('yesterday', now - DAY), chat('older', now - 5 * DAY)], now)
    expect(groups.map(group => [group.day, group.items.map(item => item.id)])).toEqual([['Today', ['today']], ['Yesterday', ['yesterday']], ['Earlier', ['older']]])
  })

  test('chats, live and ended terminals and the Claude Code sessions a person started are all listed', () => {
    const items = [chat('c1', now), session('h1', now - 1), terminal('t1', now - 2), terminal('old', now - 3, false)]
    expect(sidebarGroups(items, now)).toEqual([{ day: 'Today', items }])
  })

  test('empty groups are omitted', () => {
    expect(sidebarGroups([chat('older', now - 5 * DAY)], now).map(group => group.day)).toEqual(['Earlier'])
    expect(sidebarGroups([], now)).toEqual([])
  })
})

describe('withLiveTerminals', () => {
  const live = (id: string, title = id) => ({ id, engine: 'codex', cwd: '/work', title })

  test('history is used as is until the live terminal list arrives', () => {
    const items = [chat('c1', now), terminal('t1', now - DAY)]
    expect(withLiveTerminals(items, null, now)).toEqual(items)
  })

  test('a live terminal the history poll has not seen yet appears at the top', () => {
    const merged = withLiveTerminals([chat('c1', now - 60_000)], [live('fresh')], now)
    expect(merged.map(item => [item.kind, item.id, item.updatedAt])).toEqual([['terminal', 'fresh', now], ['chat', 'c1', now - 60_000]])
  })

  test('live sessions keep their history time and take the renamed title', () => {
    const merged = withLiveTerminals([terminal('t1', now - DAY)], [live('t1', 'Renamed')], now)
    expect(merged).toEqual([{ kind: 'terminal', id: 't1', title: 'Renamed', updatedAt: now - DAY, cwd: '/work', engine: 'codex', sessionId: null, live: true }])
  })

  test('a terminal that ended drops out even while history still lists it as live; ended ones and sessions stay', () => {
    expect(withLiveTerminals([terminal('gone', now), chat('c1', now), terminal('old', now, false), session('h1', now)], [], now).map(item => item.id)).toEqual(['c1', 'old', 'h1'])
  })
})

describe('numberedKeys', () => {
  test('numbers chats and live terminals in list order, skipping sessions and ended terminals, at most nine', () => {
    const items = [session('h1', 9), chat('c1', 8), terminal('old', 7, false), terminal('t1', 6), ...Array.from({ length: 10 }, (_, index) => chat(`x${index}`, 5 - index))]
    expect(numberedKeys(items)).toEqual(['chat:c1', 'terminal:t1', 'chat:x0', 'chat:x1', 'chat:x2', 'chat:x3', 'chat:x4', 'chat:x5', 'chat:x6'])
  })
})
