import { describe, expect, test } from 'bun:test'
import { chatHome, sharedRoot } from '../server/chat-home'

describe('sharedRoot', () => {
  test('deepest folder shared by every path', () => {
    expect(sharedRoot(['/Users/me/work/a', '/Users/me/work/b/c'])).toBe('/Users/me/work')
    expect(sharedRoot(['/Users/me/work/a'])).toBe('/Users/me/work/a')
    expect(sharedRoot(['/Users/me/work', '/Users/me/other'])).toBe('/Users/me')
    expect(sharedRoot([])).toBeNull()
  })
  test('ignores relative and empty entries', () => {
    expect(sharedRoot(['/Users/me/work/a', 'relative', ''])).toBe('/Users/me/work/a')
  })
})

describe('chatHome', () => {
  const home = '/Users/me'
  test('a configured home wins', () => {
    expect(chatHome({ chatHome: '/Users/me/code' }, ['/Users/me/x'], home)).toEqual({ ok: true, path: '/Users/me/code', source: 'config' })
  })
  test('derives the shared folder of known projects', () => {
    expect(chatHome({ chatHome: null }, ['/Users/me/work/a', '/Users/me/work/b'], home)).toEqual({ ok: true, path: '/Users/me/work', source: 'derived' })
  })
  test('never answers ~: asks with the known folders as candidates', () => {
    expect(chatHome({ chatHome: null }, ['/Users/me/work', '/Users/me/other'], home)).toEqual({ ok: false, reason: 'home', candidates: ['/Users/me/work', '/Users/me/other'] })
    expect(chatHome({ chatHome: null }, [], home)).toEqual({ ok: false, reason: 'none', candidates: [] })
  })
  test('a configured home outside $HOME is ignored', () => {
    expect(chatHome({ chatHome: '/tmp/elsewhere' }, [], home)).toEqual({ ok: false, reason: 'none', candidates: [] })
  })
})
