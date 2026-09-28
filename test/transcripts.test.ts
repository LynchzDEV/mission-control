import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultProjectsDir, listSessions, listUserSessions, projectSlug } from '../server/transcripts'

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

describe('listUserSessions', () => {
  const session = (entrypoint: string, sessionCwd: string, prompt: string) => jsonl([
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', entrypoint, cwd: sessionCwd, message: { role: 'user', content: '<command-name>/clear</command-name>' }, timestamp: TS },
    { type: 'user', entrypoint, cwd: sessionCwd, message: { role: 'user', content: prompt }, timestamp: TS },
  ])
  const write = async (folder: string, id: string, text: string, mtime: number) => {
    await mkdir(join(projectsDir, folder), { recursive: true })
    const path = join(projectsDir, folder, `${id}.jsonl`)
    await writeFile(path, text)
    await utimes(path, new Date(mtime), new Date(mtime))
  }
  const now = Date.parse('2026-09-28T00:00:00.000Z')

  test('lists only sessions a person started, from every folder, newest first, with their real folder', async () => {
    await write('-Users-x-api', 'mine-old', session('cli', '/Users/x/api', 'fix the runtime specs'), now - 5_000)
    await write('-Users-x', 'mine-new', session('cli', '/Users/x', 'what is in my home'), now - 1_000)
    await write('-Users-x-api', 'hook', session('sdk-cli', '/Users/x/api', 'Summarize this shell command for a permission prompt'), now - 500)
    await write('-Users-x-claude-mem', 'observer', session('sdk-cli', '/Users/x/.claude-mem', 'observe'), now - 400)
    const sessions = await listUserSessions({ projectsDir, since: now - 86_400_000, limit: 10 })
    expect(sessions.map((item) => [item.id, item.cwd, item.title])).toEqual([
      ['mine-new', '/Users/x', 'what is in my home'],
      ['mine-old', '/Users/x/api', 'fix the runtime specs'],
    ])
  })

  test('skips sessions older than the window, stops at the limit and ignores sub-agent folders', async () => {
    await write('-Users-x-api', 'stale', session('cli', '/Users/x/api', 'old'), now - 10 * 86_400_000)
    for (const index of [1, 2, 3]) await write('-Users-x-api', `s${index}`, session('cli', '/Users/x/api', `task ${index}`), now - index * 1_000)
    await write('-Users-x-api/s1/subagents', 'agent-a1', session('cli', '/Users/x/api', 'sub'), now)
    expect((await listUserSessions({ projectsDir, since: now - 86_400_000, limit: 2 })).map((item) => item.id)).toEqual(['s1', 's2'])
  })

  test('a session with no prompt yet appears once its first prompt is written', async () => {
    await write('-Users-x-api', 'fresh', jsonl([{ type: 'user', entrypoint: 'cli', cwd: '/Users/x/api', message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' }, timestamp: TS }]), now - 1_000)
    const since = now - 86_400_000
    expect(await listUserSessions({ projectsDir, since, limit: 10 })).toEqual([])
    await write('-Users-x-api', 'fresh', session('cli', '/Users/x/api', 'now a real prompt'), now - 500)
    expect((await listUserSessions({ projectsDir, since, limit: 10 })).map((item) => item.title)).toEqual(['now a real prompt'])
  })

  test('a missing projects folder is empty', async () => {
    expect(await listUserSessions({ projectsDir: join(projectsDir, 'nope'), since: 0, limit: 10 })).toEqual([])
  })
})
