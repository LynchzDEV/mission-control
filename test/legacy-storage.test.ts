import { describe, expect, test } from 'bun:test'
import { LEGACY_STORAGE_COPY } from '../server/views/legacy-storage'

function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() { return data.size },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

const run = (storage: ReturnType<typeof fakeStorage>) => new Function('localStorage', LEGACY_STORAGE_COPY)(storage)

describe('legacy storage copy', () => {
  test('copies every mc.* value to skd.* and keeps the old keys', () => {
    const storage = fakeStorage({ 'mc.theme': 'dark', 'mc.chat.leaf.abc': 't1', other: 'x' })
    run(storage)
    expect(storage.data.get('skd.theme')).toBe('dark')
    expect(storage.data.get('skd.chat.leaf.abc')).toBe('t1')
    expect(storage.data.get('mc.theme')).toBe('dark')
    expect(storage.data.has('skd.other')).toBe(false)
  })

  test('never overwrites an existing skd.* value', () => {
    const storage = fakeStorage({ 'mc.theme': 'dark', 'skd.theme': 'light' })
    run(storage)
    expect(storage.data.get('skd.theme')).toBe('light')
  })

  test('copies only once, so a value cleared later is not brought back', () => {
    const storage = fakeStorage({ 'mc.shell.project': '/old' })
    run(storage)
    storage.removeItem('skd.shell.project')
    run(storage)
    expect(storage.data.has('skd.shell.project')).toBe(false)
  })

  test('an empty storage gets only the done flag', () => {
    const storage = fakeStorage({})
    run(storage)
    expect([...storage.data.keys()]).toEqual(['skd.legacyCopied'])
  })

  test('a storage that throws does not break the page', () => {
    expect(() => new Function('localStorage', LEGACY_STORAGE_COPY)({ get length(): number { throw new Error('blocked') } })).not.toThrow()
  })
})
