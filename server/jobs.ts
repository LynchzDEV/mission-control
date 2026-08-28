import { createWriteStream } from 'node:fs'
import { appendFile, chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { DIR_MODE, FILE_MODE, configDir } from './secrets'
import type { EngineResolver, EngineSpawn } from './jobs-engine-iface'

export const JOBS_FILE = 'jobs.jsonl'
export const LOGS_DIR = 'logs'
export const KILL_ESCALATION_MS = 5_000

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

export type CwdCheck = { ok: true; path: string } | { ok: false; error: string }

export async function validateJobCwd(cwd: string, home: string = homedir()): Promise<CwdCheck> {
  let info
  try {
    info = await stat(cwd)
  } catch {
    return { ok: false, error: 'cwd does not exist' }
  }
  if (!info.isDirectory()) return { ok: false, error: 'cwd is not a directory' }

  let real: string
  try {
    real = await realpath(cwd)
  } catch {
    return { ok: false, error: 'cwd could not be resolved' }
  }

  let realHome: string
  try {
    realHome = await realpath(home)
  } catch {
    realHome = home
  }

  if (real !== realHome && !real.startsWith(realHome + sep)) {
    return { ok: false, error: 'cwd must be under $HOME' }
  }

  const gitCheck = Bun.spawn(['git', '-C', real, 'rev-parse', '--git-dir'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const exitCode = await gitCheck.exited
  if (exitCode !== 0) return { ok: false, error: 'cwd is not a git repository' }

  return { ok: true, path: real }
}

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

async function pump(stream: ReadableStream<Uint8Array> | undefined, sink: NodeJS.WritableStream): Promise<void> {
  if (stream === undefined) return
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) sink.write(value)
  }
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

  async function finalizeJob(
    id: string,
    proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
    logStream: ReturnType<typeof createWriteStream>,
    cwd: string,
    record: JobRecord,
  ): Promise<void> {
    await Promise.all([pump(proc.stdout, logStream), pump(proc.stderr, logStream)])
    const exitCode = await proc.exited
    await new Promise<void>((resolveClose) => logStream.end(resolveClose))
    await chmod(logPath(id), FILE_MODE)

    const status: JobStatus = exitCode === 0 ? 'done' : 'failed'
    const diffStat = status === 'done' ? await captureDiffStat(cwd) : null

    processes.delete(id)
    await persist({ ...record, status, endedAt: Date.now(), exitCode, diffStat })
  }

  async function createJob(params: CreateJobParams, resolver: EngineResolver): Promise<CreateJobResult> {
    const cwdCheck = await validateJobCwd(params.cwd, home)
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

    void finalizeJob(id, proc, logStream, cwdCheck.path, record)

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
