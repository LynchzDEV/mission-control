import { describe, expect, test } from 'bun:test'
import { numberedKeys, sidebarGroups, visibleItems, withLiveTerminals } from '../client/sidebar'
import type { HistoryItem } from '../client/chat-view'

const DAY = 86_400_000
const now = new Date(2026, 8, 25, 15, 0).getTime()
const chat = (id: string, updatedAt: number): HistoryItem => ({ kind: 'chat', id, title: id, updatedAt, project: null, running: false, agents: [] })
const terminal = (id: string, updatedAt: number, live = true): HistoryItem => ({ kind: 'terminal', id, title: id, updatedAt, cwd: '/tmp', engine: 'claude', sessionId: null, live })
const session = (id: string, updatedAt: number): HistoryItem => ({ kind: 'claude-history', id, title: id, updatedAt, cwd: '/Users/x', bytes: 10 })

describe('sidebarGroups', () => {
  test('only today and yesterday are shown; older items stay in All history', () => {
    const groups = sidebarGroups([chat('today', now - 60_000), terminal('yesterday', now - DAY, false), chat('older', now - 5 * DAY), session('old-session', now - 3 * DAY)], now)
    expect(groups.map(group => [group.day, group.items.map(item => item.id)])).toEqual([['Today', ['today']], ['Yesterday', ['yesterday']]])
  })

  test('a live terminal or running chat stays in Today however old it is', () => {
    const running: HistoryItem = { ...chat('busy', now - 6 * DAY), kind: 'chat', running: true } as HistoryItem
    const groups = sidebarGroups([chat('today', now), terminal('long-lived', now - 4 * DAY), running], now)
    expect(groups).toEqual([{ day: 'Today', items: [chat('today', now), terminal('long-lived', now - 4 * DAY), running] }])
  })

  test('chats, live and ended terminals and the Claude Code sessions a person started are all listed', () => {
    const items = [chat('c1', now), session('h1', now - 1), terminal('t1', now - 2), terminal('old', now - 3, false)]
    expect(sidebarGroups(items, now)).toEqual([{ day: 'Today', items }])
  })

  test('empty groups are omitted', () => {
    expect(sidebarGroups([chat('y', now - DAY)], now).map(group => group.day)).toEqual(['Yesterday'])
    expect(sidebarGroups([chat('older', now - 5 * DAY)], now)).toEqual([])
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

  test('a live terminal never shows twice, even when the history row lacks the live marker', () => {
    const stale = { kind: 'terminal', id: 't1', title: 't1', updatedAt: now, cwd: '/tmp', engine: 'claude', sessionId: null } as unknown as HistoryItem
    expect(withLiveTerminals([stale, chat('c1', now - 1)], [live('t1')], now).map(item => `${item.kind}:${item.id}`)).toEqual(['terminal:t1', 'chat:c1'])
  })

  test('a session opened in a live terminal drops its ended row and its session row at once', () => {
    const endedRun = { ...terminal('old-run', now - 5, false), sessionId: 's1' } as HistoryItem
    const sessionRow = session('s1', now - 6)
    const merged = withLiveTerminals([endedRun, sessionRow, chat('c1', now - 7)], [{ ...live('fresh'), sessionId: 's1' }], now)
    expect(merged.map(item => `${item.kind}:${item.id}`)).toEqual(['terminal:fresh', 'chat:c1'])
  })

  test('a terminal that ended drops out even while history still lists it as live; ended ones and sessions stay', () => {
    expect(withLiveTerminals([terminal('gone', now), chat('c1', now), terminal('old', now, false), session('h1', now)], [], now).map(item => item.id)).toEqual(['c1', 'old', 'h1'])
  })
})

describe('numberedKeys', () => {
  test('numbers every row that can be opened, top to bottom, at most nine', () => {
    const items = [session('h1', 9), chat('c1', 8), { ...terminal('old', 7, false), sessionId: 's-old' } as HistoryItem, terminal('t1', 6), ...Array.from({ length: 10 }, (_, index) => chat(`x${index}`, 5 - index))]
    expect(numberedKeys(items)).toEqual(['claude-history:h1', 'chat:c1', 'terminal:old', 'terminal:t1', 'chat:x0', 'chat:x1', 'chat:x2', 'chat:x3', 'chat:x4'])
  })
  test('an ended terminal that cannot be resumed takes no number', () => {
    const codex = { ...terminal('cx', 9, false), engine: 'codex' } as HistoryItem
    expect(numberedKeys([codex, chat('c1', 8)])).toEqual(['chat:c1'])
  })
  test('collapsed, every chat and live terminal the rail shows is numbered, starting at one', () => {
    const busy = { ...chat('busy', 7), running: true } as HistoryItem
    const items = [session('h1', 9), terminal('t1', 8), chat('c1', 8), busy, terminal('old', 6, false)]
    expect(numberedKeys(items, true)).toEqual(['terminal:t1', 'chat:c1', 'chat:busy'])
  })
})

describe('visibleItems', () => {
  test('a removed row stays hidden until the item has newer activity', () => {
    const items = [chat('quiet', 100), chat('busy', 300), session('s1', 50)]
    const hidden = { 'chat:quiet': 200, 'chat:busy': 200, 'claude-history:s1': 60 }
    expect(visibleItems(items, hidden).map(item => item.id)).toEqual(['busy'])
  })
  test('nothing removed keeps every row', () => {
    const items = [chat('c1', 1), terminal('t1', 2)]
    expect(visibleItems(items, {})).toEqual(items)
  })
})

describe('pinned chats', () => {
  test('a pinned chat leads the list whatever its age', () => {
    const pinned = { ...chat('pinned-old', now - 9 * DAY), pinned: true } as HistoryItem
    const groups = sidebarGroups([chat('today', now), pinned], now)
    expect(groups.map(group => [group.day, group.items.map(item => item.id)])).toEqual([['Pinned', ['pinned-old']], ['Today', ['today']]])
  })

  test('no pinned chats keeps the groups unchanged', () => {
    const items = [chat('today', now), chat('y', now - DAY)]
    expect(sidebarGroups(items, now).map(group => group.day)).toEqual(['Today', 'Yesterday'])
  })
})
