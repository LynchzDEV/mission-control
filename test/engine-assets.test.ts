import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentMarkdownToToml, syncEngineAssets } from '../server/engine-assets'

let base: string
let claudeDir: string
let codexDir: string
const sync = () => syncEngineAssets({ claudeDir, codexDir, now: () => 42 })

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mc-engine-assets-'))
  claudeDir = join(base, 'claude')
  codexDir = join(base, 'codex')
  await mkdir(join(claudeDir, 'skills'), { recursive: true })
  await mkdir(join(claudeDir, 'agents'))
  await mkdir(codexDir)
  await writeFile(join(claudeDir, 'CLAUDE.md'), 'global instructions')
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('global instructions', () => {
  test('links fresh instructions and the second run is a no-op', async () => {
    const target = join(codexDir, 'AGENTS.md')
    expect(await sync()).toEqual({ linked: [target], written: [], movedAside: [], skipped: [] })
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect(await readlink(target)).toBe(join(claudeDir, 'CLAUDE.md'))
    expect(await sync()).toEqual({ linked: [], written: [], movedAside: [], skipped: [] })
  })
  test('backs up a real file with the injected timestamp and private directory', async () => {
    const target = join(codexDir, 'AGENTS.md')
    await writeFile(target, 'personal instructions')
    const backup = join(codexDir, 'backup', 'AGENTS.md.pre-mission-control-42')
    expect((await sync()).movedAside).toEqual([backup])
    expect(await readFile(backup, 'utf8')).toBe('personal instructions')
    expect((await stat(join(codexDir, 'backup'))).mode & 0o777).toBe(0o700)
    expect(await readlink(target)).toBe(join(claudeDir, 'CLAUDE.md'))
  })
  test('missing source is skipped without changing existing instructions', async () => {
    await rm(join(claudeDir, 'CLAUDE.md'))
    await writeFile(join(codexDir, 'AGENTS.md'), 'keep')
    const result = await sync()
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain(join(claudeDir, 'CLAUDE.md'))
    expect(await readFile(join(codexDir, 'AGENTS.md'), 'utf8')).toBe('keep')
  })
  test('repoints stale symlinks without altering their old destination', async () => {
    const old = join(base, 'old')
    await writeFile(old, 'keep')
    await symlink(old, join(codexDir, 'AGENTS.md'))
    await sync()
    expect(await readlink(join(codexDir, 'AGENTS.md'))).toBe(join(claudeDir, 'CLAUDE.md'))
    expect(await readFile(old, 'utf8')).toBe('keep')
  })
})

describe('skills', () => {
  test('links two directories, ignores hidden names and files, and preserves .system', async () => {
    for (const name of ['one', 'two', '.hidden', '.system']) await mkdir(join(claudeDir, 'skills', name))
    await writeFile(join(claudeDir, 'skills', 'loose'), 'ignore')
    await mkdir(join(codexDir, 'skills', '.system'), { recursive: true })
    await writeFile(join(codexDir, 'skills', '.system', 'keep'), 'system')
    const result = await sync()
    expect(result.linked.filter(path => path.includes('/skills/'))).toHaveLength(2)
    for (const name of ['one', 'two']) expect(await readlink(join(codexDir, 'skills', name))).toBe(join(claudeDir, 'skills', name))
    expect((await readdir(join(codexDir, 'skills'))).sort()).toEqual(['.system', 'one', 'two'])
    expect(await readFile(join(codexDir, 'skills', '.system', 'keep'), 'utf8')).toBe('system')
  })
  test('moves real directories aside and links symlinked source skills', async () => {
    const repoSkill = join(base, 'repo-skill')
    await mkdir(repoSkill)
    await symlink(repoSkill, join(claudeDir, 'skills', 'linked'))
    const target = join(codexDir, 'skills', 'linked')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'personal')
    const backup = join(codexDir, 'backup', 'skills', 'linked.pre-mission-control-42')
    expect((await sync()).movedAside).toEqual([backup])
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8')).toBe('personal')
    expect(await readlink(target)).toBe(join(claudeDir, 'skills', 'linked'))
    expect((await stat(join(codexDir, 'backup'))).mode & 0o777).toBe(0o700)
    expect((await sync()).linked).toEqual([])
  })
  test('repoints dangling skill links', async () => {
    await mkdir(join(claudeDir, 'skills', 'one'))
    await mkdir(join(codexDir, 'skills'))
    await symlink(join(base, 'missing'), join(codexDir, 'skills', 'one'))
    await sync()
    expect(await readlink(join(codexDir, 'skills', 'one'))).toBe(join(claudeDir, 'skills', 'one'))
  })
})

const markdown = '---\nname: reviewer\ndescription: Reviews code\n---\n\n# Review\nInclude """ here.\n'
const expected = 'name = "reviewer"\ndescription = "Reviews code"\ndeveloper_instructions = """\n\n# Review\nInclude \\"\\"\\" here.\n"""\n'

describe('agents', () => {
  test('writes exact TOML, skips missing front matter and ignores documentation and nested agents', async () => {
    await writeFile(join(claudeDir, 'agents', 'review.md'), markdown)
    await writeFile(join(claudeDir, 'agents', 'plain.md'), 'no front matter')
    for (const name of ['README', 'AGENTS', 'CLAUDE', 'CONTRIBUTING', 'GEMINI', 'ARCHITECTURE']) {
      await writeFile(join(claudeDir, 'agents', `${name}.md`), markdown)
    }
    await mkdir(join(claudeDir, 'agents', 'nested'))
    await writeFile(join(claudeDir, 'agents', 'nested', 'agent.md'), markdown)
    const target = join(codexDir, 'agents', 'review.toml')
    const result = await sync()
    expect(result.written).toEqual([target])
    expect(await readFile(target, 'utf8')).toBe(expected)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('plain.md')
    expect(await readdir(join(codexDir, 'agents'))).toEqual(['review.toml'])
  })
  test('keeps unchanged mtimes, rewrites changed agents, and retains orphan and handwritten TOML', async () => {
    const source = join(claudeDir, 'agents', 'review.md')
    const target = join(codexDir, 'agents', 'review.toml')
    await writeFile(source, markdown)
    await sync()
    await writeFile(join(codexDir, 'agents', 'personal.toml'), 'handwritten')
    await utimes(target, 1000, 1000)
    const before = (await stat(target)).mtimeMs
    expect((await sync()).written).toEqual([])
    expect((await stat(target)).mtimeMs).toBe(before)
    await writeFile(source, markdown + 'Changed\n')
    expect((await sync()).written).toEqual([target])
    await rm(source)
    expect((await sync()).written).toEqual([])
    expect(await readFile(target, 'utf8')).toContain('Changed')
    expect(await readFile(join(codexDir, 'agents', 'personal.toml'), 'utf8')).toBe('handwritten')
  })
})

describe('agentMarkdownToToml', () => {
  test('escapes description quotes and backslashes, and uses the fallback name', () => {
    expect(agentMarkdownToToml('---\ndescription: \'Say "hi" at C:\\tools\'\n---\nBody', 'fallback')).toBe(
      'name = "fallback"\ndescription = "Say \\"hi\\" at C:\\\\tools"\ndeveloper_instructions = """\nBody\n"""\n',
    )
  })
  test('escapes every triple quote while retaining body whitespace', () => {
    expect(agentMarkdownToToml(markdown, 'fallback')).toBe(expected)
  })
  test('supports YAML multiline descriptions', () => {
    expect(agentMarkdownToToml('---\ndescription: >-\n  Review\n  code\n---\nBody\n', 'fallback')).toContain('description = "Review code"\n')
  })
  test('rejects absent, malformed and non-mapping front matter', () => {
    for (const value of ['plain', 'preface\n---\nname: x\n---\nbody', '---\nname: [\n---\nbody', '---\n- item\n---\nbody']) {
      expect(agentMarkdownToToml(value, 'fallback')).toBeNull()
    }
  })
})

test('a blocked destination does not prevent independent assets from syncing', async () => {
  await writeFile(join(codexDir, 'skills'), 'blocker')
  await mkdir(join(claudeDir, 'skills', 'one'))
  await writeFile(join(claudeDir, 'agents', 'review.md'), markdown)
  const result = await sync()
  expect(result.linked).toEqual([join(codexDir, 'AGENTS.md')])
  expect(result.written).toEqual([join(codexDir, 'agents', 'review.toml')])
  expect(result.skipped).toHaveLength(1)
  expect(result.skipped[0]).toContain(join(codexDir, 'skills', 'one'))
})

test('backup collisions preserve both the existing backup and the active file', async () => {
  await mkdir(join(codexDir, 'backup'))
  const backup = join(codexDir, 'backup', 'AGENTS.md.pre-mission-control-42')
  await writeFile(backup, 'old backup')
  await writeFile(join(codexDir, 'AGENTS.md'), 'current')
  expect((await sync()).skipped[0]).toContain('backup already exists')
  expect(await readFile(backup, 'utf8')).toBe('old backup')
  expect(await readFile(join(codexDir, 'AGENTS.md'), 'utf8')).toBe('current')
})
