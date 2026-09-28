import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTerminalLog, type PastTerminal } from '../server/terminal-log'
import { createTerminalRegistry } from '../server/terminals'

let dir: string
let file: string
const entry: PastTerminal = { id: 't1', engine: 'claude', cwd: '/repo', title: 'Shell work', sessionId: 's1', createdAt: 1_000, endedAt: null }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-terminal-log-'))
  file = join(dir, 'terminals.jsonl')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('terminal log', () => {
  test('the latest record per terminal wins and survives a reload', () => {
    const log = createTerminalLog(file)
    log.record(entry)
    log.record({ ...entry, title: 'Renamed' })
    log.record({ ...entry, id: 't2', createdAt: 2_000 })
    log.record({ ...entry, title: 'Renamed', endedAt: 5_000 })
    expect(createTerminalLog(file).list()).toEqual([{ ...entry, title: 'Renamed', endedAt: 5_000 }, { ...entry, id: 't2', createdAt: 2_000 }])
  })

  test('a missing file is empty and broken lines are skipped', () => {
    expect(createTerminalLog(file).list()).toEqual([])
    appendFileSync(file, `not json\n${JSON.stringify(entry)}\n{"id":42}\n`)
    expect(createTerminalLog(file).list()).toEqual([entry])
  })
})

describe('terminal registry with a log', () => {
  let repo: string
  beforeEach(async () => {
    process.env.MC_FAKE_ENGINES = '1'
    process.env.MISSION_CONTROL_CONFIG_DIR = dir
    repo = await mkdtemp(join(homedir(), 'mc-terminal-log-repo-'))
  })
  afterEach(async () => {
    delete process.env.MC_FAKE_ENGINES
    delete process.env.MISSION_CONTROL_CONFIG_DIR
    await rm(repo, { recursive: true, force: true })
  })

  test('resuming a session that is already open, or being opened, returns that terminal instead of a second copy', async () => {
    const registry = createTerminalRegistry()
    const resumeSessionId = '35e2e0d9-0000-4000-8000-000000000000'
    const clicks = await Promise.all(Array.from({ length: 5 }, () => registry.createTerminal({ engine: 'claude', cwd: repo, resumeSessionId, title: 'mine' })))
    const ids = clicks.map((result) => (result.ok ? result.terminal.id : result.error))
    expect(new Set(ids).size).toBe(1)
    expect(registry.list()).toHaveLength(1)
    const later = await registry.createTerminal({ engine: 'claude', cwd: repo, resumeSessionId })
    expect(later.ok && later.terminal.id).toBe(ids[0])
    registry.kill(ids[0]!)
    const reopened = await registry.createTerminal({ engine: 'claude', cwd: repo, resumeSessionId })
    expect(reopened.ok && reopened.terminal.id).not.toBe(ids[0])
    registry.shutdown()
  })

  test('records a terminal when it opens, is renamed and ends; ended() lists only finished ones', async () => {
    const log = createTerminalLog(file)
    const registry = createTerminalRegistry({ log })
    const created = await registry.createTerminal({ engine: 'claude', cwd: repo, title: 'api work' })
    if (!created.ok) throw new Error(created.error)
    const id = created.terminal.id
    expect(registry.ended()).toEqual([])
    registry.rename(id, 'api · runtime')
    registry.kill(id)
    const [past] = registry.ended()
    expect(past).toMatchObject({ id, engine: 'claude', title: 'api · runtime', sessionId: created.terminal.sessionId })
    expect(typeof past?.endedAt).toBe('number')
    expect(createTerminalLog(file).list().map(item => item.id)).toEqual([id])
    registry.shutdown()
  })
})
