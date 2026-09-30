import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rankFiles, listProjectFiles, subsequenceAt } from '../server/chat-files'

describe('rankFiles', () => {
  const files = ['client/chat.ts', 'client/charts.ts', 'docs/chat-help.md', 'client/sidebar.ts']

  test('basename matches come first, shorter paths leading; then subsequence matches', () => {
    expect(rankFiles(files, 'chat').map(file => file.path)).toEqual(['client/chat.ts', 'docs/chat-help.md', 'client/charts.ts'])
    expect(rankFiles(files, 'chat')[0]).toEqual({ path: 'client/chat.ts', folder: 'client' })
  })

  test('an empty query lists the shortest paths', () => {
    expect(rankFiles(files, '').map(file => file.path)).toEqual(['client/chat.ts', 'client/charts.ts', 'docs/chat-help.md', 'client/sidebar.ts'])
  })

  test('no match yields an empty list', () => {
    expect(rankFiles(files, 'zzz')).toEqual([])
  })

  test('subsequenceAt reports the matched positions or null', () => {
    expect(subsequenceAt('client/charts.ts', 'cht')).toEqual([0, 8, 11])
    expect(subsequenceAt('client/sidebar.ts', 'zzz')).toBeNull()
  })
})

describe('listProjectFiles', () => {
  test('git ls-files lists the tracked files and the fallback skips dot folders and node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mc-chat-files-'))
    try {
      await mkdir(join(root, '.git'), { recursive: true })
      await writeFile(join(root, '.git', 'index'), '')
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await writeFile(join(root, 'node_modules', 'pkg.js'), '')
      await mkdir(join(root, '.hidden'), { recursive: true })
      await writeFile(join(root, '.hidden', 'secret.ts'), '')
      await mkdir(join(root, 'client'), { recursive: true })
      await writeFile(join(root, 'client', 'chat.ts'), '')
      await writeFile(join(root, 'README.md'), '')
      const files = await listProjectFiles(root)
      expect(files).toContain('client/chat.ts')
      expect(files).toContain('README.md')
      expect(files.some(file => file.includes('node_modules') || file.startsWith('.'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
})
