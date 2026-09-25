import { describe, expect, test } from 'bun:test'
import { dragKind, dropCopy, findCount, findKeys, latestLine, nextActive, renameValue, sessionState, splitPlan } from '../client/terminal-state'

describe('sessionState', () => {
  test('working within 5 s of output, idle after, ended wins', () => {
    expect(sessionState(10_000, false, 14_999)).toBe('working')
    expect(sessionState(10_000, false, 15_000)).toBe('idle')
    expect(sessionState(null, false, 15_000)).toBe('idle')
    expect(sessionState(14_999, true, 15_000)).toBe('ended')
  })
})

describe('latestLine', () => {
  test('strips ANSI colours, OSC titles and carriage returns, returns the last non-empty line', () => {
    expect(latestLine('\x1b]0;title\x07\x1b[32m✓\x1b[0m done\r\n\n> \x1b[1mecho hi\x1b[0m\r\n   \n')).toBe('> echo hi')
  })
  test('truncates at 80 characters and is empty for no output', () => {
    expect(latestLine('x'.repeat(100)).length).toBe(80)
    expect(latestLine('x'.repeat(100)).endsWith('…')).toBe(true)
    expect(latestLine('')).toBe('')
  })
})

describe('nextActive', () => {
  test('keeps the current terminal when it survives', () => {
    expect(nextActive(['a', 'b', 'c'], 'b', 'c')).toBe('c')
  })
  test('falls to the next, then the previous, then null', () => {
    expect(nextActive(['a', 'b', 'c'], 'b', 'b')).toBe('c')
    expect(nextActive(['a', 'b', 'c'], 'c', 'c')).toBe('b')
    expect(nextActive(['a'], 'a', 'a')).toBeNull()
  })
})

describe('splitPlan', () => {
  test('maps zones to directions and refuses duplicates', () => {
    expect(splitPlan('b', ['a'], 'right')).toEqual({ id: 'b', direction: 'right' })
    expect(splitPlan('b', ['a'], 'bottom')).toEqual({ id: 'b', direction: 'below' })
    expect(splitPlan('a', ['a'], 'right')).toBeNull()
    expect(splitPlan('b', ['a'], null)).toBeNull()
  })
})

describe('renameValue', () => {
  test('trims, caps at 60, and rejects empty or unchanged names', () => {
    expect(renameValue('old', '  new name  ')).toBe('new name')
    expect(renameValue('old', 'x'.repeat(70))).toHaveLength(60)
    expect(renameValue('old', '   ')).toBeNull()
    expect(renameValue('old', 'old')).toBeNull()
  })
})

describe('dragKind', () => {
  test('tells a rail card from files from nothing', () => {
    expect(dragKind(['text/x-mc-terminal'])).toBe('card')
    expect(dragKind(['Files'])).toBe('files')
    expect(dragKind(['text/uri-list', 'text/plain'])).toBe('files')
    expect(dragKind(['text/plain'])).toBe('none')
  })
})

describe('findKeys', () => {
  const key = (key: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, ...extra })
  test('⌘F or Ctrl+F opens; Enter / Shift+Enter / Escape act only while open', () => {
    expect(findKeys(key('f', { metaKey: true }), false)).toBe('open')
    expect(findKeys(key('F', { ctrlKey: true }), true)).toBe('open')
    expect(findKeys(key('Enter'), true)).toBe('next')
    expect(findKeys(key('Enter', { shiftKey: true }), true)).toBe('prev')
    expect(findKeys(key('Escape'), true)).toBe('close')
    expect(findKeys(key('Enter'), false)).toBeNull()
    expect(findKeys(key('f'), false)).toBeNull()
  })
})

describe('dropCopy', () => {
  test('counts files in the overlay title and the toast, singular and plural', () => {
    expect(dropCopy(1)).toEqual({ title: 'Drop to add 1 file', toast: 'Added 1 file' })
    expect(dropCopy(3)).toEqual({ title: 'Drop to add 3 files', toast: 'Added 3 files' })
    expect(dropCopy(0)).toEqual({ title: 'Drop to add files', toast: 'Added files' })
  })
})

describe('findCount', () => {
  test('reads n of m, 0 of m before a match is chosen, and No matches', () => {
    expect(findCount(1, 3)).toBe('2 of 3')
    expect(findCount(-1, 3)).toBe('0 of 3')
    expect(findCount(-1, 0)).toBe('No matches')
    expect(findCount(-1, 0, '')).toBe('')
  })
})
