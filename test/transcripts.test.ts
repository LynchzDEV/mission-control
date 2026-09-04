import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultProjectsDir, listSessions, projectSlug } from '../server/transcripts'

let projectsDir: string
let sessionDir: string
let cwd: string

const TS = '2026-09-01T10:00:00.000Z'

beforeEach(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), 'mc-transcripts-'))
  cwd = '/Users/x/Desktop/app'
  sessionDir = join(projectsDir, projectSlug(cwd))
  await mkdir(sessionDir)
})

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true })
})

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

function userLine(content: unknown, timestamp: string = TS): unknown {
  return { type: 'user', message: { role: 'user', content }, timestamp }
}

function bridgeLine(): unknown {
  return { type: 'bridge-session', sessionId: 'stub' }
}

describe('projectSlug', () => {
  test('replaces every character outside [A-Za-z0-9-] with a dash', () => {
    expect(projectSlug('/Users/x/Desktop/app')).toBe('-Users-x-Desktop-app')
    expect(projectSlug('/Users/x/.claude-mem-observer-sessions')).toBe(
      '-Users-x--claude-mem-observer-sessions',
    )
    expect(projectSlug('/a b/c.d')).toBe('-a-b-c-d')
  })
})

describe('defaultProjectsDir', () => {
  test('points at ~/.claude/projects', () => {
    expect(defaultProjectsDir()).toBe(join(homedir(), '.claude', 'projects'))
  })
})

describe('listSessions', () => {
  test('reads the title from the first real user line and parses its timestamp', async () => {
    await writeFile(join(sessionDir, 'aaa.jsonl'), jsonl([bridgeLine(), userLine('fix the login bug')]))
    const info = await stat(join(sessionDir, 'aaa.jsonl'))

    const sessions = await listSessions(cwd, { projectsDir })

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual({
      id: 'aaa',
      title: 'fix the login bug',
      startedAt: Date.parse(TS),
      updatedAt: info.mtimeMs,
      bytes: info.size,
    })
  })

  test('skips a leading slash-command echo in favor of the real prompt', async () => {
    await writeFile(
      join(sessionDir, 'bbb.jsonl'),
      jsonl([userLine('<command-name>/x</command-name>'), userLine('real prompt')]),
    )

    const sessions = await listSessions(cwd, { projectsDir })

    expect(sessions.map((session) => session.title)).toEqual(['real prompt'])
  })

  test('skips bridge-session stubs with no user line', async () => {
    await writeFile(join(sessionDir, 'ccc.jsonl'), jsonl([bridgeLine()]))

    const sessions = await listSessions(cwd, { projectsDir })

    expect(sessions).toEqual([])
  })

  test('ignores non-jsonl files and subdirectories', async () => {
    await writeFile(join(sessionDir, 'notes.txt'), 'not a session')
    await mkdir(join(sessionDir, 'subagents'))
    await writeFile(join(sessionDir, 'subagents', 'nested.jsonl'), jsonl([userLine('nested prompt')]))

    const sessions = await listSessions(cwd, { projectsDir })

    expect(sessions).toEqual([])
  })

  test('reads the title from a text block inside an array content', async () => {
    await writeFile(join(sessionDir, 'ddd.jsonl'), jsonl([userLine([{ type: 'text', text: 'hi there' }])]))

    const sessions = await listSessions(cwd, { projectsDir })

    expect(sessions.map((session) => session.title)).toEqual(['hi there'])
  })

  test('orders newest first and honors the limit', async () => {
    await writeFile(join(sessionDir, 'old.jsonl'), jsonl([userLine('older')]))
    await writeFile(join(sessionDir, 'new.jsonl'), jsonl([userLine('newer')]))
    const oldTime = new Date('2026-08-01T00:00:00.000Z')
    const newTime = new Date('2026-09-01T00:00:00.000Z')
    await utimes(join(sessionDir, 'old.jsonl'), oldTime, oldTime)
    await utimes(join(sessionDir, 'new.jsonl'), newTime, newTime)

    const sessions = await listSessions(cwd, { projectsDir })
    expect(sessions.map((session) => session.id)).toEqual(['new', 'old'])

    const limited = await listSessions(cwd, { projectsDir, limit: 1 })
    expect(limited.map((session) => session.id)).toEqual(['new'])
  })

  test('returns an empty list for a missing directory', async () => {
    const sessions = await listSessions('no-such-cwd-anywhere', { projectsDir })

    expect(sessions).toEqual([])
  })
})
