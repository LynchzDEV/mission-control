import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { claudeSkillsDir, installSkills, repoSkillsDir } from '../server/skill-install'

const SKILL_MD = '---\nname: skd-dispatch\n---\n\n# skd-dispatch\n'

let base: string
let repo: string
let target: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'skd-skill-install-'))
  repo = join(base, 'repo')
  target = join(base, 'home', '.claude', 'skills')
  await mkdir(join(repo, 'skills', 'skd-dispatch'), { recursive: true })
  await writeFile(join(repo, 'skills', 'skd-dispatch', 'SKILL.md'), SKILL_MD)
  await writeFile(join(repo, 'skills', 'notes.txt'), 'not a skill dir')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('installSkills', () => {
  test('fresh install links each skill dir and ignores plain files', async () => {
    const result = await installSkills({ repoRoot: repo, targetDir: target })

    expect(result).toEqual({ linked: [join(target, 'skd-dispatch')], movedAside: [], skipped: [], removed: [] })
    const link = join(target, 'skd-dispatch')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(join(repo, 'skills', 'skd-dispatch'))
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(await readdir(target)).toEqual(['skd-dispatch'])
  })

  test('running again is a no-op: linked again, nothing moved aside', async () => {
    await installSkills({ repoRoot: repo, targetDir: target })

    const result = await installSkills({ repoRoot: repo, targetDir: target })

    expect(result).toEqual({ linked: [join(target, 'skd-dispatch')], movedAside: [], skipped: [], removed: [] })
    expect((await lstat(join(target, 'skd-dispatch'))).isSymbolicLink()).toBe(true)
  })

  test('re-points a symlink that resolves somewhere else', async () => {
    const elsewhere = join(base, 'elsewhere', 'skd-dispatch')
    await mkdir(elsewhere, { recursive: true })
    await writeFile(join(elsewhere, 'SKILL.md'), 'hand written copy')
    await mkdir(target, { recursive: true })
    await symlink(elsewhere, join(target, 'skd-dispatch'))

    const result = await installSkills({ repoRoot: repo, targetDir: target })

    expect(result).toEqual({ linked: [join(target, 'skd-dispatch')], movedAside: [], skipped: [], removed: [] })
    expect(await realpath(join(target, 'skd-dispatch'))).toBe(await realpath(join(repo, 'skills', 'skd-dispatch')))
    expect(await readFile(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('hand written copy')
  })

  test('moves a real directory aside into skills-backup and links the repo dir in its place', async () => {
    const existing = join(target, 'skd-dispatch')
    await mkdir(existing, { recursive: true })
    await writeFile(join(existing, 'SKILL.md'), 'my own copy')

    const result = await installSkills({ repoRoot: repo, targetDir: target, now: () => 1234567890123 })

    const backupDir = join(dirname(target), 'skills-backup')
    const aside = join(backupDir, 'skd-dispatch.pre-shikidan-1234567890123')
    expect(result).toEqual({ linked: [existing], movedAside: [aside], skipped: [], removed: [] })
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(aside, 'SKILL.md'), 'utf8')).toBe('my own copy')
    expect(await readFile(join(existing, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(await readdir(target)).toEqual(['skd-dispatch'])
  })

  test('moves a real file aside too', async () => {
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'skd-dispatch'), 'a file, not a dir')

    const result = await installSkills({ repoRoot: repo, targetDir: target, now: () => 42 })

    const aside = join(dirname(target), 'skills-backup', 'skd-dispatch.pre-shikidan-42')
    expect(result.linked).toEqual([join(target, 'skd-dispatch')])
    expect(result.movedAside).toEqual([aside])
    expect(await readFile(aside, 'utf8')).toBe('a file, not a dir')
    expect(await readdir(target)).toEqual(['skd-dispatch'])
  })

  test('removes a link into this repo\'s skills/ whose skill folder is gone', async () => {
    await mkdir(target, { recursive: true })
    await symlink(join(repo, 'skills', 'mc-dispatch'), join(target, 'mc-dispatch'))

    const result = await installSkills({ repoRoot: repo, targetDir: target })

    expect(result.removed).toEqual([join(target, 'mc-dispatch')])
    expect(await readdir(target)).toEqual(['skd-dispatch'])
  })

  test('keeps dangling links that point elsewhere, live links and real folders', async () => {
    await mkdir(join(target, 'own-folder'), { recursive: true })
    await symlink(join(base, 'elsewhere', 'gone'), join(target, 'foreign-dangling'))
    await mkdir(join(base, 'other-skill'))
    await symlink(join(base, 'other-skill'), join(target, 'foreign-live'))

    const result = await installSkills({ repoRoot: repo, targetDir: target })

    expect(result.removed).toEqual([])
    expect((await readdir(target)).sort()).toEqual(['foreign-dangling', 'foreign-live', 'own-folder', 'skd-dispatch'])
  })

  test('creates no skills-backup dir when nothing needs moving aside', async () => {
    await installSkills({ repoRoot: repo, targetDir: target })

    await installSkills({ repoRoot: repo, targetDir: target })

    const backupDir = join(dirname(target), 'skills-backup')
    await expect(stat(backupDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('skips instead of throwing when the target dir cannot be created', async () => {
    const blocker = join(base, 'blocker')
    await writeFile(blocker, 'a file, not a dir')

    const result = await installSkills({ repoRoot: repo, targetDir: join(blocker, 'skills') })

    expect(result.linked).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('could not create directory')
  })

  test('skips instead of throwing when the repo has no skills dir', async () => {
    const result = await installSkills({ repoRoot: join(base, 'empty'), targetDir: target })

    expect(result.linked).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('could not read repo skills dir')
  })
})

describe('repoSkillsDir', () => {
  test('joins skills under the given root and defaults to the repo', () => {
    expect(repoSkillsDir('/tmp/repo')).toBe(join('/tmp/repo', 'skills'))
    expect(repoSkillsDir()).toBe(resolve(import.meta.dir, '..', 'skills'))
  })
})

describe('claudeSkillsDir', () => {
  test('joins .claude/skills under the given home', () => {
    expect(claudeSkillsDir('/home/me')).toBe(join('/home/me', '.claude', 'skills'))
  })

  test('defaults to the current $HOME, so a test home never touches the real one', () => {
    expect(claudeSkillsDir()).toBe(join(process.env.HOME!, '.claude', 'skills'))
  })
})
