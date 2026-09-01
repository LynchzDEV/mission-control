import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ARCHIVE_FILE,
  STALE_UNFINISHED_MS,
  bangkokMidnightBoundary,
  createArchiveStore,
  sessionLastActivity,
  sessionsDueForAutoArchive,
} from '../server/archive'
import type { JobRecord } from '../server/jobs'
import type { Plan } from '../server/plans'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-archive-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    engine: 'glm',
    cwd: '/home/dev/code',
    label: 'demo',
    pid: 1,
    status: 'done',
    startedAt: 0,
    endedAt: 1_000,
    exitCode: 0,
    diffStat: null,
    reviewedAt: null,
    ...overrides,
  }
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return { label: 'demo', steps: [], next: null, updatedAt: 0, ...overrides }
}

describe('createArchiveStore', () => {
  test('archives a label and persists it as jsonl', async () => {
    const store = createArchiveStore()
    const record = await store.archive('demo', 1_700_000_000_000)

    expect(record).toEqual({ label: 'demo', archivedAt: 1_700_000_000_000 })
    expect(store.isArchived('demo')).toBe(true)
    expect(store.archivedAt('demo')).toBe(1_700_000_000_000)
    expect(store.archivedLabels()).toEqual(['demo'])

    const raw = await readFile(join(dir, ARCHIVE_FILE), 'utf8')
    expect(raw.trim().split('\n').length).toBe(1)
  })

  test('unarchive appends a null-archivedAt record and last-write-wins', async () => {
    const store = createArchiveStore()
    await store.archive('demo', 1_000)
    await store.unarchive('demo')

    expect(store.isArchived('demo')).toBe(false)
    expect(store.archivedAt('demo')).toBeNull()
    expect(store.archivedLabels()).toEqual([])

    const raw = await readFile(join(dir, ARCHIVE_FILE), 'utf8')
    expect(raw.trim().split('\n').length).toBe(2)
  })

  test('a label never archived is not archived', () => {
    const store = createArchiveStore()
    expect(store.isArchived('never-seen')).toBe(false)
    expect(store.archivedAt('never-seen')).toBeNull()
  })

  test('reloads the newest write per label across a restart', async () => {
    const first = createArchiveStore()
    await first.archive('one', 1_000)
    await first.archive('two', 2_000)
    await first.unarchive('one')

    const reloaded = createArchiveStore()
    expect(reloaded.isArchived('one')).toBe(false)
    expect(reloaded.isArchived('two')).toBe(true)
    expect(reloaded.archivedAt('two')).toBe(2_000)
  })

  test('skips unreadable and malformed lines on load', async () => {
    const store = createArchiveStore()
    await store.archive('demo', 5_000)
    await Bun.write(
      join(dir, ARCHIVE_FILE),
      `not json\n{"nolabel":true}\n${JSON.stringify({ label: 'demo', archivedAt: 5_000 })}\n`,
    )

    const reloaded = createArchiveStore()
    expect(reloaded.isArchived('demo')).toBe(true)
  })
})

describe('bangkokMidnightBoundary', () => {
  test('returns the UTC instant of 00:00 Asia/Bangkok for the current Bangkok day', () => {
    // 2026-08-29 10:00 UTC == 2026-08-29 17:00 Bangkok, so the boundary is 2026-08-29 00:00
    // Bangkok == 2026-08-28 17:00 UTC.
    const now = Date.parse('2026-08-29T10:00:00.000Z')
    expect(bangkokMidnightBoundary(now)).toBe(Date.parse('2026-08-28T17:00:00.000Z'))
  })

  test('a moment just after midnight Bangkok still resolves to that same-day boundary', () => {
    const now = Date.parse('2026-08-29T17:01:00.000Z') // 2026-08-30 00:01 Bangkok
    expect(bangkokMidnightBoundary(now)).toBe(Date.parse('2026-08-29T17:00:00.000Z'))
  })
})

describe('sessionsDueForAutoArchive', () => {
  test('a session finished at 23:59 Bangkok yesterday is due at 00:01 today', () => {
    const now = Date.parse('2026-08-29T17:01:00.000Z') // 2026-08-30 00:01 Bangkok
    const lastActivity = Date.parse('2026-08-29T16:59:00.000Z') // 2026-08-29 23:59 Bangkok
    const due = sessionsDueForAutoArchive(
      [{ label: 'yesterday', finished: true, running: false, lastActivity }],
      now,
    )
    expect(due).toEqual(['yesterday'])
  })

  test('a session finished 5 minutes ago (same Bangkok day) is not due', () => {
    const now = Date.parse('2026-08-29T10:00:00.000Z') // 2026-08-29 17:00 Bangkok — far from midnight
    const lastActivity = now - 5 * 60_000
    const due = sessionsDueForAutoArchive(
      [{ label: 'recent', finished: true, running: false, lastActivity }],
      now,
    )
    expect(due).toEqual([])
  })

  test('an unfinished session idle past the stale window is due', () => {
    const now = Date.parse('2026-08-29T17:01:00.000Z')
    const lastActivity = now - STALE_UNFINISHED_MS - 1
    const due = sessionsDueForAutoArchive(
      [{ label: 'stale-but-open', finished: false, running: false, lastActivity }],
      now,
    )
    expect(due).toEqual(['stale-but-open'])
  })

  test('an unfinished session inside the stale window stays', () => {
    const now = Date.parse('2026-08-29T17:01:00.000Z')
    const due = sessionsDueForAutoArchive(
      [{ label: 'open-recent', finished: false, running: false, lastActivity: now - 60_000 }],
      now,
    )
    expect(due).toEqual([])
  })

  test('a session with a running job is never due, however old its lastActivity', () => {
    const now = Date.parse('2026-08-29T17:01:00.000Z')
    const due = sessionsDueForAutoArchive(
      [
        { label: 'live-old', finished: false, running: true, lastActivity: 0 },
        { label: 'live-finished-flag', finished: true, running: true, lastActivity: 0 },
      ],
      now,
    )
    expect(due).toEqual([])
  })
})

describe('sessionLastActivity', () => {
  test('is the max job endedAt when there is no plan', () => {
    const jobs = [job({ id: 'a', endedAt: 1_000 }), job({ id: 'b', endedAt: 5_000 })]
    expect(sessionLastActivity(jobs, null)).toBe(5_000)
  })

  test('is the plan updatedAt when it is newer than every job', () => {
    const jobs = [job({ endedAt: 1_000 })]
    expect(sessionLastActivity(jobs, plan({ updatedAt: 9_000 }))).toBe(9_000)
  })

  test('a running job (endedAt null) does not count as activity', () => {
    const jobs = [job({ endedAt: null }), job({ id: 'b', endedAt: 2_000 })]
    expect(sessionLastActivity(jobs, null)).toBe(2_000)
  })
})
