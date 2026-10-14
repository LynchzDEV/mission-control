import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { envNames } from '../server/env'
import { configDir, migrateConfigDir } from '../server/secrets'

let home: string
const newDir = () => join(home, '.config', 'shikidan')
const oldDir = () => join(home, '.config', 'mission-control')

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'skd-config-migration-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('migrateConfigDir', () => {
  test('a fresh install has nothing to move', async () => {
    expect(await migrateConfigDir(home)).toBe('none')
    expect(await lstat(newDir()).catch(() => null)).toBeNull()
    expect(await lstat(oldDir()).catch(() => null)).toBeNull()
  })

  test('moves the old folder and leaves a symlink at the old path', async () => {
    await mkdir(oldDir(), { recursive: true })
    await writeFile(join(oldDir(), 'secrets.json'), '{"apiToken":"t"}')
    expect(await migrateConfigDir(home)).toBe('migrated')
    expect((await lstat(newDir())).isDirectory()).toBe(true)
    expect(await readFile(join(newDir(), 'secrets.json'), 'utf8')).toBe('{"apiToken":"t"}')
    expect((await lstat(oldDir())).isSymbolicLink()).toBe(true)
    expect(await readlink(oldDir())).toBe(newDir())
    expect(await readFile(join(oldDir(), 'secrets.json'), 'utf8')).toBe('{"apiToken":"t"}')
  })

  test('an already migrated install is left alone', async () => {
    await mkdir(oldDir(), { recursive: true })
    await migrateConfigDir(home)
    expect(await migrateConfigDir(home)).toBe('none')
    expect((await lstat(oldDir())).isSymbolicLink()).toBe(true)
  })

  test('when both folders exist the new one wins and the old one is untouched', async () => {
    await mkdir(oldDir(), { recursive: true })
    await mkdir(newDir(), { recursive: true })
    await writeFile(join(oldDir(), 'secrets.json'), 'old')
    await writeFile(join(newDir(), 'secrets.json'), 'new')
    expect(await migrateConfigDir(home)).toBe('none')
    expect((await lstat(oldDir())).isDirectory()).toBe(true)
    expect(await readFile(join(oldDir(), 'secrets.json'), 'utf8')).toBe('old')
    expect(await readFile(join(newDir(), 'secrets.json'), 'utf8')).toBe('new')
  })
})

test('the default config dir is ~/.config/shikidan', () => {
  const saved = envNames('CONFIG_DIR').map(key => [key, process.env[key]] as const)
  for (const [key] of saved) delete process.env[key]
  try {
    expect(configDir().endsWith(join('.config', 'shikidan'))).toBe(true)
  } finally {
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
  }
})
