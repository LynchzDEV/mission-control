import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextTooLarge, safeContextName, sweepContextFiles, writeContextFile } from '../server/plugins/context-files'

let dir: string
const previous = process.env.MISSION_CONTROL_CONFIG_DIR

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-context-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.MISSION_CONTROL_CONFIG_DIR
  else process.env.MISSION_CONTROL_CONFIG_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

describe('writeContextFile', () => {
  test('writes a private file named by time and task', async () => {
    const path = await writeContextFile('clickup-board', { name: 'HerMEZ kood queue', markdown: '# x' }, new Date('2026-10-04T10:11:12Z'))
    expect(path).toBe(join(dir, 'context', 'clickup-board', '20261004-101112-hermez-kood-queue.md'))
    expect(await readFile(path, 'utf8')).toBe('# x')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'context', 'clickup-board'))).mode & 0o777).toBe(0o700)
  })

  test('refuses context over 512 KB', async () => {
    await expect(writeContextFile('p', { name: 'big', markdown: 'x'.repeat(600 * 1024) })).rejects.toBeInstanceOf(ContextTooLarge)
  })
})

describe('safeContextName', () => {
  test('keeps a .md name and falls back for empty names', () => {
    expect(safeContextName('Task-86d3.md')).toBe('task-86d3.md')
    expect(safeContextName('!!!')).toBe('context.md')
  })
})

describe('sweepContextFiles', () => {
  test('removes files older than 30 days and keeps newer ones', async () => {
    const now = new Date('2026-10-04T00:00:00Z')
    const folder = join(dir, 'context', 'p')
    await mkdir(folder, { recursive: true })
    const old = join(folder, 'old.md')
    const recent = join(folder, 'recent.md')
    await writeFile(old, 'a')
    await writeFile(recent, 'b')
    const day = 24 * 60 * 60 * 1000
    await utimes(old, new Date(now.getTime() - 31 * day), new Date(now.getTime() - 31 * day))
    await utimes(recent, new Date(now.getTime() - 29 * day), new Date(now.getTime() - 29 * day))
    expect(await sweepContextFiles(now)).toBe(1)
    await expect(stat(old)).rejects.toThrow()
    expect((await stat(recent)).isFile()).toBe(true)
  })

  test('the next write sweeps old files', async () => {
    const now = new Date('2026-10-04T00:00:00Z')
    const folder = join(dir, 'context', 'p')
    await mkdir(folder, { recursive: true })
    const old = join(folder, 'old.md')
    await writeFile(old, 'a')
    const stale = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)
    await utimes(old, stale, stale)
    await writeContextFile('p', { name: 'new', markdown: 'n' }, now)
    await expect(stat(old)).rejects.toThrow()
  })
})
