import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_DROP_BYTES,
  MTIME_TOLERANCE_MS,
  checkDropSize,
  findOriginalFile,
  safeDropName,
  saveDroppedCopy,
  spotlightQuery,
} from '../server/drops'
import type { DroppedFileMeta } from '../server/drops'

const META = { name: 'report.txt', size: 10, lastModified: 1_700_000_000_000 }

function statByPath(entries: Record<string, { size: number; mtimeMs: number } | null>) {
  return async (path: string) => entries[path] ?? null
}

describe('findOriginalFile', () => {
  test('returns null off darwin without touching mdfind', async () => {
    const result = await findOriginalFile(META, {
      platform: 'linux',
      runMdfind: async () => {
        throw new Error('must not run')
      },
    })
    expect(result).toBeNull()
  })

  test('returns the single exact match', async () => {
    const result = await findOriginalFile(META, {
      platform: 'darwin',
      runMdfind: async () => ['/Users/x/report.txt'],
      statSize: statByPath({ '/Users/x/report.txt': { size: 10, mtimeMs: META.lastModified } }),
    })
    expect(result).toBe('/Users/x/report.txt')
  })

  test('passes the full meta to the mdfind runner', async () => {
    const seen: DroppedFileMeta[] = []
    const result = await findOriginalFile(META, {
      platform: 'darwin',
      runMdfind: async (meta) => {
        seen.push(meta)
        return []
      },
    })
    expect(result).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe(META.name)
    expect(seen[0]?.size).toBe(META.size)
  })

  test('returns null when two candidates survive', async () => {
    const entry = { size: 10, mtimeMs: META.lastModified }
    const result = await findOriginalFile(META, {
      platform: 'darwin',
      runMdfind: async () => ['/Users/x/report.txt', '/Users/y/report.txt'],
      statSize: statByPath({ '/Users/x/report.txt': entry, '/Users/y/report.txt': entry }),
    })
    expect(result).toBeNull()
  })

  test('returns null on a basename mismatch', async () => {
    const result = await findOriginalFile(META, {
      platform: 'darwin',
      runMdfind: async () => ['/Users/x/other.txt'],
      statSize: statByPath({ '/Users/x/other.txt': { size: 10, mtimeMs: META.lastModified } }),
    })
    expect(result).toBeNull()
  })

  test('returns null on a size mismatch', async () => {
    const result = await findOriginalFile(META, {
      platform: 'darwin',
      runMdfind: async () => ['/Users/x/report.txt'],
      statSize: statByPath({ '/Users/x/report.txt': { size: 11, mtimeMs: META.lastModified } }),
    })
    expect(result).toBeNull()
  })

  test('returns null when mtime drifts beyond tolerance', async () => {
    const result = await findOriginalFile(META, {
      platform: 'darwin',
      runMdfind: async () => ['/Users/x/report.txt'],
      statSize: statByPath({
        '/Users/x/report.txt': { size: 10, mtimeMs: META.lastModified + MTIME_TOLERANCE_MS + 1 },
      }),
    })
    expect(result).toBeNull()
  })

  test('returns null when mdfind rejects', async () => {
    const result = await findOriginalFile(META, {
      platform: 'darwin',
      runMdfind: async () => {
        throw new Error('mdfind exploded')
      },
    })
    expect(result).toBeNull()
  })
})

describe('spotlightQuery', () => {
  test('escapes backslashes and quotes into a size-scoped query', () => {
    expect(spotlightQuery({ name: 'it\'s "x" \\ y.txt', size: 3, lastModified: 0 })).toBe(
      'kMDItemFSName == "it\'s \\"x\\" \\\\ y.txt" && kMDItemFSSize == 3',
    )
  })
})

describe('checkDropSize', () => {
  test('allows at and under the limit, rejects over', () => {
    expect(checkDropSize(0)).toBe(true)
    expect(checkDropSize(MAX_DROP_BYTES)).toBe(true)
    expect(checkDropSize(MAX_DROP_BYTES + 1)).toBe(false)
  })
})

describe('safeDropName', () => {
  test('strips path components and control characters', () => {
    expect(safeDropName('../../x')).toBe('x')
    expect(safeDropName('a/b.txt')).toBe('b.txt')
    expect(safeDropName('re\x00port.txt')).toBe('report.txt')
    expect(safeDropName('')).toBe('drop')
    expect(safeDropName('..')).toBe('drop')
    expect(safeDropName('  ')).toBe('drop')
  })
})

describe('saveDroppedCopy', () => {
  const tempDirs: string[] = []

  function makeDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'mc-drops-')).then((dir) => {
      tempDirs.push(dir)
      return dir
    })
  }

  afterAll(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
  })

  test('writes the bytes and returns a path inside the given dir', async () => {
    const dir = await makeDir()
    const bytes = new TextEncoder().encode('drop payload')
    const path = await saveDroppedCopy('note.txt', bytes, dir)
    expect(path.startsWith(dir + '/')).toBe(true)
    expect(path.endsWith('/note.txt')).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('drop payload')
  })

  test('suffixed name on collision', async () => {
    const dir = await makeDir()
    const bytes = new TextEncoder().encode('drop payload')
    const first = await saveDroppedCopy('note.txt', bytes, dir)
    const second = await saveDroppedCopy('note.txt', bytes, dir)
    expect(second).not.toBe(first)
    expect(second).toContain('/note-')
    expect(second.endsWith('.txt')).toBe(true)
    expect(await readFile(second, 'utf8')).toBe('drop payload')
  })

  test('writes the copy with mode 0o600', async () => {
    const dir = await makeDir()
    const path = await saveDroppedCopy('note.txt', new TextEncoder().encode('x'), dir)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('sanitizes hostile names', async () => {
    const dir = await makeDir()
    const path = await saveDroppedCopy('../evil/name\x01.txt', new TextEncoder().encode('x'), dir)
    expect(path.endsWith('/name.txt')).toBe(true)
  })
})
