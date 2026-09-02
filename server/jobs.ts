import { appendFile, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  ACTIVITY_THROTTLE_MS,
  createActivityThrottle,
  currentActivity,
  parseActivity,
  parseSessionId,
} from './activity'
import { DIR_MODE, FILE_MODE, configDir } from './secrets'
import { validateWorkspaceCwd } from './workspace'
import type { EngineResolver, EngineSpawn } from './jobs-engine-iface'

export const JOBS_FILE = 'jobs.jsonl'
export const LOGS_DIR = 'logs'
export const KILL_ESCALATION_MS = 5_000
export const LOG_TAIL_POLL_MS = 150
export const ADOPT_POLL_MS = 2_000
export const MIN_REDACTED_SECRET_LENGTH = 8
export const ACTIVITY_TAIL_CHARS = 16_384
export const SESSION_SCAN_MAX_CHARS = 65_536

const REDACTED_PLACEHOLDER = '[REDACTED]'

export type JobStatus = 'running' | 'done' | 'failed'

export type JobRecord = {
  id: string
  engine: string
  cwd: string
  label: string
  prompt: string
  pid: number
  status: JobStatus
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  diffStat: string | null
  reviewedAt: number | null
  sessionId: string | null
  parentJobId: string | null
  threadRoot: string
  terminalId: string | null
  reviewOf: string | null
  model: string | null
}

export type CreateJobParams = {
  engine: string
  cwd: string
  prompt: string
  label: string
  parentJobId?: string
  threadRoot?: string
  resumeSessionId?: string
  terminalId?: string
  reviewOf?: string
  model?: string
}

export type CreateJobResult =
  | { ok: true; job: JobRecord }
  | { ok: false; status: number; error: string }

export type KillJobResult = { ok: true } | { ok: false; status: number; error: string }

export type MarkReviewedResult =
  | { ok: true; job: JobRecord }
  | { ok: false; status: number; error: string }

export type JobManager = {
  createJob(params: CreateJobParams, resolver: EngineResolver): Promise<CreateJobResult>
  killJob(id: string): Promise<KillJobResult>
  markReviewed(id: string, at?: number): Promise<MarkReviewedResult>
  listJobs(): JobRecord[]
  getJob(id: string): JobRecord | undefined
  currentActivity(id: string): string | null
  logPath(id: string): string
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function normalizeJobRecord(raw: Record<string, unknown>): JobRecord {
  const id = readString(raw.id, '')
  return {
    ...(raw as unknown as JobRecord),
    reviewedAt: typeof raw.reviewedAt === 'number' ? raw.reviewedAt : null,
    prompt: readString(raw.prompt, ''),
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    parentJobId: typeof raw.parentJobId === 'string' && raw.parentJobId !== '' ? raw.parentJobId : null,
    threadRoot: readString(raw.threadRoot, '') === '' ? id : readString(raw.threadRoot, id),
    terminalId: typeof raw.terminalId === 'string' && raw.terminalId !== '' ? raw.terminalId : null,
    reviewOf: typeof raw.reviewOf === 'string' && raw.reviewOf !== '' ? raw.reviewOf : null,
    model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : null,
  }
}

function loadJobs(path: string): Map<string, JobRecord> {
  const jobs = new Map<string, JobRecord>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return jobs
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const record = normalizeJobRecord(JSON.parse(trimmed) as Record<string, unknown>)
      jobs.set(record.id, record)
    } catch {
      continue
    }
  }
  return jobs
}

async function appendJsonl(path: string, record: JobRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

function ensureDirsSync(dir: string, logsDir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  chmodSync(dir, DIR_MODE)
  mkdirSync(logsDir, { recursive: true, mode: DIR_MODE })
  chmodSync(logsDir, DIR_MODE)
}

export type { CwdCheck } from './workspace'
export { validateWorkspaceCwd as validateJobCwd } from './workspace'

async function captureDiffStat(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, 'diff', '--stat', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (exitCode !== 0) return null
    const trimmed = output.trim()
    return trimmed === '' ? null : trimmed
  } catch {
    return null
  }
}

export type LogRedactor = {
  redact(chunk: string): string
  flush(): string
}

// The longest suffix of `text` that is also a prefix of `secret` (capped at maxLen) — the
// part of `text` that could still grow into a full match once more input arrives.
function suffixPrefixOverlap(text: string, secret: string, maxLen: number): number {
  const upper = Math.min(maxLen, text.length)
  for (let len = upper; len > 0; len--) {
    if (text.endsWith(secret.slice(0, len))) return len
  }
  return 0
}

// Holds back only the trailing chars of unprocessed input that could still be the start of
// a secret continuing into the next chunk, so a secret split across two writes is still
// matched once the next chunk arrives.
export function createLogRedactor(secret: string | null): LogRedactor {
  if (secret === null || secret.length < MIN_REDACTED_SECRET_LENGTH) {
    return { redact: (chunk) => chunk, flush: () => '' }
  }
  const holdBack = secret.length - 1
  let carry = ''

  return {
    redact(chunk: string): string {
      const combined = carry + chunk
      const replaced = combined.split(secret).join(REDACTED_PLACEHOLDER)
      const overlap = suffixPrefixOverlap(combined, secret, holdBack)
      if (overlap === 0) {
        carry = ''
        return replaced
      }
      carry = combined.slice(combined.length - overlap)
      return replaced.slice(0, replaced.length - overlap)
    },
    flush(): string {
      const remaining = carry
      carry = ''
      return remaining
    },
  }
}

export function redactSecrets(content: string, secret: string | null): string {
  const redactor = createLogRedactor(secret)
  return redactor.redact(content) + redactor.flush()
}

export type JobManagerOptions = {
  home?: string
  activityIntervalMs?: number
  now?: () => number
  onJobSettled?: (record: JobRecord) => void
}

export function createJobManager(options: JobManagerOptions = {}): JobManager {
  const dir = configDir()
  const jsonlPath = join(dir, JOBS_FILE)
  const logsDir = join(dir, LOGS_DIR)
  const jobs = loadJobs(jsonlPath)
  const home = options.home
  const activityIntervalMs = options.activityIntervalMs ?? ACTIVITY_THROTTLE_MS
  const clock = options.now ?? Date.now
  const processes = new Map<string, Bun.Subprocess>()
  const activities = new Map<string, string>()
  const tails = new Map<string, string>()
  const sessionScans = new Map<string, string>()
  const pendingActivityTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function logPath(id: string): string {
    return join(logsDir, `${id}.log`)
  }

  function refreshActivity(id: string): void {
    const line = currentActivity(parseActivity(tails.get(id) ?? ''))
    if (line !== null) activities.set(id, line)
  }

  // The activity tail drops the head of a long log, but the session id is in the first line —
  // so it gets its own bounded head buffer, dropped as soon as an id is found.
  function scanSessionId(id: string, text: string): void {
    const pending = sessionScans.get(id)
    if (pending === undefined) return
    const combined = pending + text
    const found = parseSessionId(combined)
    if (found === null) {
      if (combined.length > SESSION_SCAN_MAX_CHARS) sessionScans.delete(id)
      else sessionScans.set(id, combined)
      return
    }
    sessionScans.delete(id)
    const record = jobs.get(id)
    if (record === undefined || record.sessionId === found) return
    void persist({ ...record, sessionId: found }).catch(() => {})
  }

  function clearPendingActivityTimer(id: string): void {
    const pending = pendingActivityTimers.get(id)
    if (pending === undefined) return
    clearTimeout(pending)
    pendingActivityTimers.delete(id)
  }

  // A throttled chunk still holds the newest activity line — it just can't be shown yet — so a
  // single coalesced timer revisits it once the throttle window passes, even if no further chunk
  // ever arrives (a long tool call with no interim output would otherwise leave the ticker stale).
  function scheduleTrailingRefresh(id: string, throttle: ReturnType<typeof createActivityThrottle>): void {
    if (pendingActivityTimers.has(id)) return
    const timer = setTimeout(() => {
      pendingActivityTimers.delete(id)
      refreshActivity(id)
    }, throttle.remainingMs())
    pendingActivityTimers.set(id, timer)
  }

  function collectActivity(id: string, throttle: ReturnType<typeof createActivityThrottle>) {
    return (text: string): void => {
      scanSessionId(id, text)
      const combined = (tails.get(id) ?? '') + text
      tails.set(id, combined.slice(Math.max(0, combined.length - ACTIVITY_TAIL_CHARS)))
      if (throttle.ready()) {
        refreshActivity(id)
        return
      }
      scheduleTrailingRefresh(id, throttle)
    }
  }

  async function persist(record: JobRecord): Promise<void> {
    jobs.set(record.id, record)
    await appendJsonl(jsonlPath, record)
  }

  async function settleFailed(id: string, record: JobRecord): Promise<void> {
    processes.delete(id)
    clearPendingActivityTimer(id)
    await persist({
      ...(jobs.get(id) ?? record),
      status: 'failed',
      endedAt: Date.now(),
      exitCode: null,
      diffStat: null,
    })
  }

  // Children write straight to the log file (no pipes), so they survive a server restart;
  // activity comes from tailing that file instead of pumping stdio.
  function startLogTail(id: string, collect: (text: string) => void, startOffset = 0): () => Promise<void> {
    const path = logPath(id)
    let offset = startOffset
    let busy = false
    const tick = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const chunk = await readLogSince(path, offset)
        if (chunk.content !== '') {
          offset = chunk.offset
          collect(chunk.content)
        }
      } catch {
        // log file may not exist yet; the next tick retries
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => void tick(), LOG_TAIL_POLL_MS)
    return async () => {
      clearInterval(timer)
      await tick()
    }
  }

  async function settleJob(id: string, record: JobRecord, exitCode: number | null, status: JobStatus): Promise<void> {
    const current = jobs.get(id) ?? record
    if (current.status !== 'running') return
    processes.delete(id)
    sessionScans.delete(id)
    clearPendingActivityTimer(id)
    tails.delete(id)
    const diffStat = status === 'done' ? await captureDiffStat(current.cwd) : null
    const settled = { ...current, status, endedAt: Date.now(), exitCode, diffStat }
    await persist(settled)
    options.onJobSettled?.(settled)
  }

  async function finalizeJob(id: string, proc: Bun.Subprocess, record: JobRecord): Promise<void> {
    const throttle = createActivityThrottle(activityIntervalMs, clock)
    const stopTail = startLogTail(id, collectActivity(id, throttle))
    try {
      const exitCode = await proc.exited
      await stopTail()
      refreshActivity(id)
      await settleJob(id, record, exitCode, exitCode === 0 ? 'done' : 'failed')
    } catch {
      await stopTail().catch(() => {})
      await settleFailed(id, record)
    }
  }

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  // ponytail: an orphan's exit code is unknowable — a result marker in the log is the best done-signal.
  async function settleAdopted(record: JobRecord): Promise<void> {
    const log = await readLogFile(logPath(record.id)).catch(() => '')
    const done = log.includes('"type":"result"')
    await settleJob(record.id, record, null, done ? 'done' : 'failed')
  }

  function adoptOrphan(record: JobRecord): void {
    if (!pidAlive(record.pid)) {
      void settleAdopted(record).catch(() => {})
      return
    }
    const throttle = createActivityThrottle(activityIntervalMs, clock)
    const stopTail = startLogTail(record.id, collectActivity(record.id, throttle))
    const watcher = setInterval(() => {
      if (pidAlive(record.pid)) return
      clearInterval(watcher)
      void stopTail()
        .catch(() => {})
        .then(() => settleAdopted(jobs.get(record.id) ?? record))
        .catch(() => {})
    }, ADOPT_POLL_MS)
  }

  for (const record of jobs.values()) {
    if (record.status === 'running') adoptOrphan(record)
  }

  async function createJob(params: CreateJobParams, resolver: EngineResolver): Promise<CreateJobResult> {
    const cwdCheck = await validateWorkspaceCwd(params.cwd, home)
    if (!cwdCheck.ok) return { ok: false, status: 400, error: cwdCheck.error }

    ensureDirsSync(dir, logsDir)
    let spawnSpec: EngineSpawn
    try {
      spawnSpec = await resolver({
        engine: params.engine,
        prompt: params.prompt,
        ...(params.resumeSessionId === undefined ? {} : { resumeSessionId: params.resumeSessionId }),
        ...(typeof params.model === 'string' && params.model !== '' ? { model: params.model } : {}),
      })
    } catch {
      return { ok: false, status: 400, error: 'engine resolver failed' }
    }

    const id = crypto.randomUUID()
    const path = logPath(id)

    let proc: Bun.Subprocess
    try {
      const logFd = openSync(path, 'a', FILE_MODE)
      try {
        proc = Bun.spawn([spawnSpec.cmd, ...spawnSpec.args], {
          cwd: cwdCheck.path,
          env: { ...process.env, ...spawnSpec.env },
          stdin: 'ignore',
          stdout: logFd,
          stderr: logFd,
        })
      } finally {
        closeSync(logFd)
      }
    } catch {
      return { ok: false, status: 500, error: 'failed to spawn engine process' }
    }
    processes.set(id, proc)

    const record: JobRecord = {
      id,
      engine: params.engine,
      cwd: cwdCheck.path,
      label: params.label,
      prompt: params.prompt,
      pid: proc.pid,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      diffStat: null,
      reviewedAt: null,
      sessionId: null,
      parentJobId: params.parentJobId ?? null,
      threadRoot: params.threadRoot ?? id,
      terminalId: typeof params.terminalId === 'string' && params.terminalId !== '' ? params.terminalId : null,
      reviewOf: typeof params.reviewOf === 'string' && params.reviewOf !== '' ? params.reviewOf : null,
      model: typeof params.model === 'string' && params.model !== '' ? params.model : null,
    }
    sessionScans.set(id, '')
    await persist(record)

    void finalizeJob(id, proc, record).catch(() => settleFailed(id, record).catch(() => {}))

    return { ok: true, job: record }
  }

  async function killJob(id: string): Promise<KillJobResult> {
    const proc = processes.get(id)
    if (proc !== undefined) {
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }, KILL_ESCALATION_MS)
      return { ok: true }
    }
    const record = jobs.get(id)
    if (record === undefined || record.status !== 'running' || !pidAlive(record.pid)) {
      return { ok: false, status: 404, error: 'job is not running' }
    }
    try {
      process.kill(record.pid, 'SIGTERM')
      setTimeout(() => {
        if (pidAlive(record.pid)) {
          try {
            process.kill(record.pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
      }, KILL_ESCALATION_MS)
    } catch {
      return { ok: false, status: 404, error: 'job is not running' }
    }
    return { ok: true }
  }

  async function markReviewed(id: string, at: number = Date.now()): Promise<MarkReviewedResult> {
    const record = jobs.get(id)
    if (record === undefined) return { ok: false, status: 404, error: 'job not found' }
    if (record.reviewedAt !== null) return { ok: true, job: record }
    const reviewed: JobRecord = { ...record, reviewedAt: at }
    await persist(reviewed)
    return { ok: true, job: reviewed }
  }

  function listJobs(): JobRecord[] {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  function getJob(id: string): JobRecord | undefined {
    return jobs.get(id)
  }

  function jobActivity(id: string): string | null {
    return activities.get(id) ?? null
  }

  return { createJob, killJob, markReviewed, listJobs, getJob, currentActivity: jobActivity, logPath }
}

export async function readLogFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

export type LogChunk = { content: string; offset: number }

export async function readLogTail(path: string, maxBytes = 4096): Promise<LogChunk> {
  let info
  try {
    info = await stat(path)
  } catch {
    return { content: '', offset: 0 }
  }
  const size = info.size
  const start = Math.max(0, size - maxBytes)
  const content = await readLogRange(path, start, size)
  return { content, offset: size }
}

export async function readLogSince(path: string, offset: number): Promise<LogChunk> {
  let info
  try {
    info = await stat(path)
  } catch {
    return { content: '', offset }
  }
  if (info.size <= offset) return { content: '', offset }
  const content = await readLogRange(path, offset, info.size)
  return { content, offset: info.size }
}

async function readLogRange(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return ''
  const file = Bun.file(path)
  const slice = file.slice(start, end)
  return slice.text()
}
