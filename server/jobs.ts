import { createWriteStream } from 'node:fs'
import { appendFile, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DIR_MODE, FILE_MODE, configDir, readSecrets } from './secrets'
import { validateWorkspaceCwd } from './workspace'
import type { EngineResolver, EngineSpawn } from './jobs-engine-iface'

export const JOBS_FILE = 'jobs.jsonl'
export const LOGS_DIR = 'logs'
export const KILL_ESCALATION_MS = 5_000
export const MIN_REDACTED_SECRET_LENGTH = 8

const REDACTED_PLACEHOLDER = '[REDACTED]'

export type JobStatus = 'running' | 'done' | 'failed'

export type JobRecord = {
  id: string
  engine: string
  cwd: string
  label: string
  pid: number
  status: JobStatus
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  diffStat: string | null
}

export type CreateJobParams = {
  engine: string
  cwd: string
  prompt: string
  label: string
}

export type CreateJobResult =
  | { ok: true; job: JobRecord }
  | { ok: false; status: number; error: string }

export type KillJobResult = { ok: true } | { ok: false; status: number; error: string }

export type JobManager = {
  createJob(params: CreateJobParams, resolver: EngineResolver): Promise<CreateJobResult>
  killJob(id: string): Promise<KillJobResult>
  listJobs(): JobRecord[]
  getJob(id: string): JobRecord | undefined
  logPath(id: string): string
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
      const record = JSON.parse(trimmed) as JobRecord
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

async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: NodeJS.WritableStream,
  redactor: LogRedactor,
): Promise<void> {
  if (stream === undefined) return
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      const text = decoder.decode(value, { stream: true })
      if (text !== '') {
        const redacted = redactor.redact(text)
        if (redacted !== '') sink.write(redacted)
      }
    }
  }
  const tailText = decoder.decode()
  if (tailText !== '') {
    const redacted = redactor.redact(tailText)
    if (redacted !== '') sink.write(redacted)
  }
  const flushed = redactor.flush()
  if (flushed !== '') sink.write(flushed)
}

export type JobManagerOptions = {
  home?: string
}

export function createJobManager(options: JobManagerOptions = {}): JobManager {
  const dir = configDir()
  const jsonlPath = join(dir, JOBS_FILE)
  const logsDir = join(dir, LOGS_DIR)
  const jobs = loadJobs(jsonlPath)
  const home = options.home
  const processes = new Map<string, Bun.Subprocess<'ignore', 'pipe', 'pipe'>>()

  function logPath(id: string): string {
    return join(logsDir, `${id}.log`)
  }

  async function persist(record: JobRecord): Promise<void> {
    jobs.set(record.id, record)
    await appendJsonl(jsonlPath, record)
  }

  async function settleFailed(id: string, record: JobRecord): Promise<void> {
    processes.delete(id)
    await persist({ ...record, status: 'failed', endedAt: Date.now(), exitCode: null, diffStat: null })
  }

  async function finalizeJob(
    id: string,
    proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
    logStream: ReturnType<typeof createWriteStream>,
    streamState: { failed: boolean },
    cwd: string,
    record: JobRecord,
    redactToken: string | null,
  ): Promise<void> {
    try {
      await Promise.all([
        pump(proc.stdout, logStream, createLogRedactor(redactToken)),
        pump(proc.stderr, logStream, createLogRedactor(redactToken)),
      ])
      const exitCode = await proc.exited
      await new Promise<void>((resolveClose) => logStream.end(resolveClose))
      if (!streamState.failed) await chmod(logPath(id), FILE_MODE).catch(() => {})

      const status: JobStatus = !streamState.failed && exitCode === 0 ? 'done' : 'failed'
      const diffStat = status === 'done' ? await captureDiffStat(cwd) : null

      processes.delete(id)
      await persist({ ...record, status, endedAt: Date.now(), exitCode, diffStat })
    } catch {
      await settleFailed(id, record)
    }
  }

  async function createJob(params: CreateJobParams, resolver: EngineResolver): Promise<CreateJobResult> {
    const cwdCheck = await validateWorkspaceCwd(params.cwd, home)
    if (!cwdCheck.ok) return { ok: false, status: 400, error: cwdCheck.error }

    ensureDirsSync(dir, logsDir)
    let spawnSpec: EngineSpawn
    try {
      spawnSpec = await resolver({ engine: params.engine, prompt: params.prompt })
    } catch {
      return { ok: false, status: 400, error: 'engine resolver failed' }
    }

    const id = crypto.randomUUID()
    const path = logPath(id)
    const logStream = createWriteStream(path, { mode: FILE_MODE, flags: 'a' })
    const streamState = { failed: false }
    logStream.on('error', () => {
      streamState.failed = true
    })

    const secrets = await readSecrets()

    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([spawnSpec.cmd, ...spawnSpec.args], {
        cwd: cwdCheck.path,
        env: { ...process.env, ...spawnSpec.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch {
      logStream.end()
      return { ok: false, status: 500, error: 'failed to spawn engine process' }
    }
    processes.set(id, proc)

    const record: JobRecord = {
      id,
      engine: params.engine,
      cwd: cwdCheck.path,
      label: params.label,
      pid: proc.pid,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      diffStat: null,
    }
    await persist(record)

    void finalizeJob(
      id,
      proc,
      logStream,
      streamState,
      cwdCheck.path,
      record,
      secrets.zaiAuthToken,
    ).catch(() => settleFailed(id, record).catch(() => {}))

    return { ok: true, job: record }
  }

  async function killJob(id: string): Promise<KillJobResult> {
    const proc = processes.get(id)
    if (proc === undefined) return { ok: false, status: 404, error: 'job is not running' }
    proc.kill('SIGTERM')
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }, KILL_ESCALATION_MS)
    return { ok: true }
  }

  function listJobs(): JobRecord[] {
    return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  function getJob(id: string): JobRecord | undefined {
    return jobs.get(id)
  }

  return { createJob, killJob, listJobs, getJob, logPath }
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
