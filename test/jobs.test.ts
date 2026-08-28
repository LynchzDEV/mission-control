import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JOBS_FILE,
  LOGS_DIR,
  createJobManager,
  createLogRedactor,
  readLogSince,
  readLogTail,
  validateJobCwd,
} from '../server/jobs'
import type { JobManager, JobRecord } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { configPath, writeSecrets } from '../server/secrets'
import { initScratchGitRepo } from './support/scratch-git-repo'

let configDir: string
let testRoot: string
let home: string
let outside: string

const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })
const failResolver: EngineResolver = () => ({
  cmd: 'ls',
  args: ['/definitely-does-not-exist-mission-control-jobs-test'],
  env: {},
})
const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })
const initGitRepo = initScratchGitRepo

async function waitForStatus(
  manager: JobManager,
  id: string,
  timeoutMs = 3000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = manager.getJob(id)
    if (job !== undefined && job.status !== 'running') return job
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle within ${timeoutMs}ms`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-jobs-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir

  testRoot = await mkdtemp(join(tmpdir(), 'mc-jobs-root-'))
  home = join(testRoot, 'home')
  outside = join(testRoot, 'outside')
  await mkdir(home, { recursive: true })
  await mkdir(outside, { recursive: true })
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(testRoot, { recursive: true, force: true })
})

describe('validateJobCwd', () => {
  test('rejects a directory that does not exist', async () => {
    const result = await validateJobCwd(join(home, 'nope'), home)
    expect(result.ok).toBe(false)
  })

  test('rejects an existing directory that is not a git repo', async () => {
    const plain = join(home, 'plain')
    await mkdir(plain, { recursive: true })
    const result = await validateJobCwd(plain, home)
    expect(result.ok).toBe(false)
  })

  test('rejects a git repo outside HOME', async () => {
    await initGitRepo(outside)
    const result = await validateJobCwd(outside, home)
    expect(result.ok).toBe(false)
  })

  test('rejects `..` traversal that escapes HOME', async () => {
    await initGitRepo(outside)
    const nested = join(home, 'nested')
    await mkdir(nested, { recursive: true })
    const traversal = join(nested, '..', '..', 'outside')
    const result = await validateJobCwd(traversal, home)
    expect(result.ok).toBe(false)
  })

  test('rejects a symlink under HOME that escapes to outside HOME', async () => {
    await initGitRepo(outside)
    const escapeLink = join(home, 'escape')
    await symlink(outside, escapeLink)
    const result = await validateJobCwd(escapeLink, home)
    expect(result.ok).toBe(false)
  })

  test('accepts a git repo under HOME', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const result = await validateJobCwd(repo, home)
    expect(result.ok).toBe(true)
  })
})

describe('job lifecycle', () => {
  test('a job runs to completion and is recorded as done', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'hello-world', label: 'smoke' },
      echoResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.job.status).toBe('running')

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('done')
    expect(finished?.exitCode).toBe(0)
    expect(finished?.endedAt).not.toBeNull()

    const log = await readFile(manager.logPath(result.job.id), 'utf8')
    expect(log).toContain('hello-world')

    const jsonl = await readFile(configPath(JOBS_FILE), 'utf8')
    const lines = jsonl.trim().split('\n').map((line) => JSON.parse(line))
    const lastRecordForJob = [...lines].reverse().find((record) => record.id === result.job.id)
    expect(lastRecordForJob.status).toBe('done')
  })

  test('a job that exits non-zero is recorded as failed with a null diffStat', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'fail' },
      failResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('failed')
    expect(finished?.exitCode).not.toBe(0)
    expect(finished?.diffStat).toBeNull()
  })

  test('killJob sends SIGTERM and the job settles as failed', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'kill-me' },
      sleepResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const killResult = await manager.killJob(result.job.id)
    expect(killResult.ok).toBe(true)

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('failed')
  })

  test('killJob reports an error for an id that is not running', async () => {
    const manager = createJobManager({ home })
    const result = await manager.killJob('does-not-exist')
    expect(result.ok).toBe(false)
  })

  test('diffStat captures an uncommitted change in the job cwd once the job is done', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    await writeFile(join(repo, 'README.md'), 'initial\nchanged\n')
    const manager = createJobManager({ home })

    const result = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'diff' },
      echoResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('done')
    expect(finished?.diffStat).not.toBeNull()
    expect(finished?.diffStat).toContain('README.md')
  })

  test('a job whose engine echoes the configured zai token never writes it to the log file', async () => {
    const TOKEN = 'super-secret-zai-token-abcdef123456'
    await writeSecrets({ zaiAuthToken: TOKEN })

    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })
    const echoTokenResolver: EngineResolver = () => ({
      cmd: 'echo',
      args: [`leaking ${TOKEN} in verbose output`],
      env: {},
    })

    const result = await manager.createJob(
      { engine: 'glm', cwd: repo, prompt: 'irrelevant', label: 'redact' },
      echoTokenResolver,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const finished = await waitForStatus(manager, result.job.id)
    expect(finished?.status).toBe('done')

    const log = await readFile(manager.logPath(result.job.id), 'utf8')
    expect(log).toContain('[REDACTED]')
    expect(log).not.toContain(TOKEN)
  })

  test('listJobs returns newest first', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const first = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'one', label: 'first' },
      echoResolver,
    )
    const second = await manager.createJob(
      { engine: 'claude', cwd: repo, prompt: 'two', label: 'second' },
      echoResolver,
    )
    if (!first.ok || !second.ok) throw new Error('expected both jobs to be created')

    await waitForStatus(manager, first.job.id)
    await waitForStatus(manager, second.job.id)

    const listed = manager.listJobs()
    const firstIndex = listed.findIndex((job) => job.id === first.job.id)
    const secondIndex = listed.findIndex((job) => job.id === second.job.id)
    expect(secondIndex).toBeLessThan(firstIndex)
  })
})

describe('createLogRedactor', () => {
  const TOKEN = 'zai-token-1234567890'

  test('redacts a token fully contained within one chunk', () => {
    const redactor = createLogRedactor(TOKEN)
    const out = redactor.redact(`before ${TOKEN} after`) + redactor.flush()
    expect(out).toBe('before [REDACTED] after')
    expect(out).not.toContain(TOKEN)
  })

  test('redacts a token split across two chunk writes', () => {
    const redactor = createLogRedactor(TOKEN)
    const splitAt = Math.floor(TOKEN.length / 2)
    const first = redactor.redact(`before ${TOKEN.slice(0, splitAt)}`)
    const second = redactor.redact(`${TOKEN.slice(splitAt)} after`)
    const out = first + second + redactor.flush()
    expect(out).toBe('before [REDACTED] after')
    expect(out).not.toContain(TOKEN)
  })

  test('leaves a chunk with no token untouched', () => {
    const redactor = createLogRedactor(TOKEN)
    const text = 'nothing sensitive in this line\n'
    const out = redactor.redact(text) + redactor.flush()
    expect(out).toBe(text)
  })

  test('disables redaction when the secret is shorter than the minimum length', () => {
    const redactor = createLogRedactor('short1')
    const text = 'contains short1 verbatim'
    const out = redactor.redact(text) + redactor.flush()
    expect(out).toBe(text)
  })

  test('passes chunks through unchanged when no secret is configured', () => {
    const redactor = createLogRedactor(null)
    const text = 'anything goes here'
    const out = redactor.redact(text) + redactor.flush()
    expect(out).toBe(text)
  })
})

describe('log stream failures', () => {
  test('a job whose log stream errors settles as failed instead of crashing the process', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const manager = createJobManager({ home })

    const fixedId = 'fixed-log-stream-error-id'
    const originalRandomUUID = crypto.randomUUID
    crypto.randomUUID = (() => fixedId) as typeof crypto.randomUUID
    try {
      await mkdir(join(configDir, LOGS_DIR, `${fixedId}.log`), { recursive: true })

      const result = await manager.createJob(
        { engine: 'claude', cwd: repo, prompt: 'irrelevant', label: 'log-error' },
        echoResolver,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.job.id).toBe(fixedId)

      const finished = await waitForStatus(manager, fixedId)
      expect(finished.status).toBe('failed')
      expect(finished.diffStat).toBeNull()
    } finally {
      crypto.randomUUID = originalRandomUUID
    }
  })
})

describe('jsonl reload', () => {
  test('a fresh manager instance loads jobs persisted by an earlier instance', async () => {
    const repo = join(home, 'repo')
    await initGitRepo(repo)
    const first = createJobManager({ home })

    const result = await first.createJob(
      { engine: 'claude', cwd: repo, prompt: 'hello-again', label: 'reload' },
      echoResolver,
    )
    if (!result.ok) throw new Error('expected job to be created')
    await waitForStatus(first, result.job.id)

    const second = createJobManager({ home })
    const reloaded = second.getJob(result.job.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.status).toBe('done')
    expect(second.listJobs().some((job) => job.id === result.job.id)).toBe(true)
  })
})

describe('log tail/offset reader', () => {
  test('readLogTail returns only the last N bytes and the total size as offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, '0123456789')

    const tail = await readLogTail(path, 4)
    expect(tail.content).toBe('6789')
    expect(tail.offset).toBe(10)

    await rm(dir, { recursive: true, force: true })
  })

  test('readLogTail returns the whole file when it is smaller than the requested window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, 'short')

    const tail = await readLogTail(path, 4096)
    expect(tail.content).toBe('short')
    expect(tail.offset).toBe(5)

    await rm(dir, { recursive: true, force: true })
  })

  test('readLogTail on a missing file returns empty content and zero offset', async () => {
    const tail = await readLogTail(join(tmpdir(), 'mc-jobs-log-missing.log'))
    expect(tail.content).toBe('')
    expect(tail.offset).toBe(0)
  })

  test('readLogSince returns only bytes appended after the given offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, 'abc')

    const first = await readLogTail(path)
    expect(first.content).toBe('abc')

    await writeFile(path, 'abcdef')
    const since = await readLogSince(path, first.offset)
    expect(since.content).toBe('def')
    expect(since.offset).toBe(6)

    await rm(dir, { recursive: true, force: true })
  })

  test('readLogSince returns empty content when nothing new has been written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-jobs-log-'))
    const path = join(dir, 'sample.log')
    await writeFile(path, 'stable')

    const tail = await readLogTail(path)
    const since = await readLogSince(path, tail.offset)
    expect(since.content).toBe('')
    expect(since.offset).toBe(tail.offset)

    await rm(dir, { recursive: true, force: true })
  })
})
