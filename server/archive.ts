import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { JobRecord } from './jobs'
import type { Plan } from './plans'
import { DIR_MODE, FILE_MODE, configDir } from './secrets'

export const ARCHIVE_FILE = 'archive.jsonl'
export const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export type ArchiveRecord = { label: string; archivedAt: number | null }

export type ArchiveStore = {
  isArchived(label: string): boolean
  archivedAt(label: string): number | null
  archivedLabels(): string[]
  archive(label: string, at?: number): Promise<ArchiveRecord>
  unarchive(label: string): Promise<ArchiveRecord>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRecord(raw: unknown): ArchiveRecord | null {
  if (!isRecord(raw)) return null
  const label = typeof raw.label === 'string' ? raw.label : ''
  if (label === '') return null
  const archivedAt = typeof raw.archivedAt === 'number' ? raw.archivedAt : null
  return { label, archivedAt }
}

function loadArchive(path: string): Map<string, number | null> {
  const state = new Map<string, number | null>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return state
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = normalizeRecord(parsed)
    if (record !== null) state.set(record.label, record.archivedAt)
  }
  return state
}

async function appendRecord(path: string, record: ArchiveRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

export function createArchiveStore(): ArchiveStore {
  const path = join(configDir(), ARCHIVE_FILE)
  const state = loadArchive(path)

  async function write(label: string, archivedAt: number | null): Promise<ArchiveRecord> {
    state.set(label, archivedAt)
    const record: ArchiveRecord = { label, archivedAt }
    await appendRecord(path, record)
    return record
  }

  return {
    isArchived: (label) => (state.get(label) ?? null) !== null,
    archivedAt: (label) => state.get(label) ?? null,
    archivedLabels: () => [...state.entries()].filter(([, at]) => at !== null).map(([label]) => label),
    archive: (label, at = Date.now()) => write(label, at),
    unarchive: (label) => write(label, null),
  }
}

// The UTC instant of the most recent 00:00 Asia/Bangkok (UTC+7) at or before `now`.
export function bangkokMidnightBoundary(now: number): number {
  const shifted = now + BANGKOK_OFFSET_MS
  return Math.floor(shifted / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS
}

// Max of job endedAt / plan updatedAt — the moment a finished session went quiet.
export function sessionLastActivity(jobs: readonly JobRecord[], plan: Plan | null): number {
  const jobsMax = jobs.reduce((max, job) => Math.max(max, job.endedAt ?? 0), 0)
  return Math.max(jobsMax, plan?.updatedAt ?? 0)
}

export type ArchivableSession = { label: string; finished: boolean; lastActivity: number }

// Finished sessions roll off at the Bangkok day boundary, not on a rolling window.
export function sessionsDueForAutoArchive(sessions: readonly ArchivableSession[], now: number): string[] {
  const boundary = bangkokMidnightBoundary(now)
  return sessions
    .filter((session) => session.finished && session.lastActivity < boundary)
    .map((session) => session.label)
}
