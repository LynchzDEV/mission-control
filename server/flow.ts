import { basename } from 'node:path'

import type { JobRecord } from './jobs'
import type { TerminalRecord } from './terminals'

export type StageState = 'done' | 'active' | 'queued' | 'future' | 'error'
export type Stage = [StageState, string]

export type SessionFlow = {
  spec: Stage
  impl: Stage
  codex: Stage
  verify: Stage
  merged: Stage
}

export type FlowInput = {
  jobs: readonly JobRecord[]
  terminals: readonly TerminalRecord[]
  now: number
}

export type FlowSnapshot = {
  current: string
  sessions: Record<string, SessionFlow>
  reviewCount: number
  mergedToday: number
}

export const IMPLEMENT_ENGINES: readonly string[] = ['claude', 'glm']
export const REVIEW_ENGINE = 'codex'

export function sessionKey(job: JobRecord): string {
  const label = job.label.trim()
  return label === '' ? job.id : label
}

export function awaitsReview(job: JobRecord): boolean {
  return job.status === 'done' && job.diffStat !== null && job.diffStat !== '' && job.reviewedAt === null
}

export function countPendingReviews(jobs: readonly JobRecord[]): number {
  return jobs.filter(awaitsReview).length
}

function minutesBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 60_000))
}

function newestBy(jobs: readonly JobRecord[], at: (job: JobRecord) => number): JobRecord {
  return jobs.reduce((best, job) => (at(job) > at(best) ? job : best))
}

function endOrStart(job: JobRecord): number {
  return job.endedAt ?? job.startedAt
}

function implStage(jobs: readonly JobRecord[], now: number): Stage {
  const impl = jobs.filter((job) => IMPLEMENT_ENGINES.includes(job.engine))
  if (impl.length === 0) return ['future', 'GLM']

  const running = impl.filter((job) => job.status === 'running')
  if (running.length > 0) {
    const latest = newestBy(running, (job) => job.startedAt)
    const engine = latest.engine.toUpperCase()
    return ['active', `${engine} · ${minutesBetween(latest.startedAt, now)}m · ${basename(latest.cwd)}`]
  }

  const done = impl.filter((job) => job.status === 'done')
  if (done.length > 0) {
    const latest = newestBy(done, endOrStart)
    return ['done', `${latest.engine.toUpperCase()} · ${basename(latest.cwd)}`]
  }

  return ['error', `${newestBy(impl, endOrStart).engine.toUpperCase()} · FAILED`]
}

function codexStage(jobs: readonly JobRecord[], implState: StageState, now: number): Stage {
  const codex = jobs.filter((job) => job.engine === REVIEW_ENGINE)
  if (codex.length === 0) {
    return implState === 'done' ? ['queued', 'CODEX · QUEUED'] : ['future', 'CODEX']
  }

  const running = codex.filter((job) => job.status === 'running')
  if (running.length > 0) {
    const latest = newestBy(running, (job) => job.startedAt)
    return ['active', `CODEX · ${minutesBetween(latest.startedAt, now)}m`]
  }
  if (codex.some((job) => job.status === 'done')) return ['done', 'CODEX · DONE']
  return ['error', 'CODEX · FAILED']
}

function verifyStage(jobs: readonly JobRecord[], now: number): Stage {
  const withDiff = jobs.filter((job) => job.status === 'done' && job.diffStat !== null && job.diffStat !== '')
  if (withDiff.length === 0) return ['future', 'CLAUDE']

  const pending = withDiff.filter((job) => job.reviewedAt === null)
  if (pending.length > 0) {
    const latest = newestBy(pending, endOrStart)
    return ['active', `CLAUDE · NOW · ${minutesBetween(endOrStart(latest), now)}m`]
  }
  return ['done', 'CLAUDE · REVIEWED']
}

function fullyReviewed(jobs: readonly JobRecord[]): boolean {
  return jobs.length > 0 && jobs.every((job) => job.reviewedAt !== null)
}

function sameDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function groupByLabel(jobs: readonly JobRecord[]): Map<string, JobRecord[]> {
  const grouped = new Map<string, JobRecord[]>()
  for (const job of jobs) {
    const key = sessionKey(job)
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [job])
    else bucket.push(job)
  }
  return grouped
}

function countMergedToday(grouped: Map<string, JobRecord[]>, now: number): number {
  let merged = 0
  for (const group of grouped.values()) {
    if (!fullyReviewed(group)) continue
    const latest = newestBy(group, (job) => job.reviewedAt ?? 0)
    if (sameDay(latest.reviewedAt ?? 0, now)) merged += 1
  }
  return merged
}

function pickCurrent(sessions: Record<string, SessionFlow>): string {
  const keys = Object.keys(sessions)
  const attention = keys.find((key) =>
    Object.values(sessions[key] as SessionFlow).some((stage) => stage[0] === 'active'),
  )
  return attention ?? keys[0] ?? ''
}

export function planOnlySession(): SessionFlow {
  return {
    spec: ['done', 'CLAUDE'],
    impl: ['future', 'GLM'],
    codex: ['future', 'CODEX'],
    verify: ['future', 'CLAUDE'],
    merged: ['future', '0 TODAY'],
  }
}

export function deriveFlow(input: FlowInput): FlowSnapshot {
  const ordered = [...input.jobs].sort((a, b) => b.startedAt - a.startedAt)
  const grouped = groupByLabel(ordered)
  const mergedToday = countMergedToday(grouped, input.now)

  const sessions: Record<string, SessionFlow> = {}
  for (const [key, group] of grouped) {
    const impl = implStage(group, input.now)
    sessions[key] = {
      spec: ['done', 'CLAUDE'],
      impl,
      codex: codexStage(group, impl[0], input.now),
      verify: verifyStage(group, input.now),
      merged: [fullyReviewed(group) ? 'done' : 'future', `${mergedToday} TODAY`],
    }
  }

  return {
    current: pickCurrent(sessions),
    sessions,
    reviewCount: countPendingReviews(ordered),
    mergedToday,
  }
}
