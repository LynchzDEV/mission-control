import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { main, type MainDeps } from '../cli/mctl'
import { createJobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { jobsRoutes } from '../server/routes/jobs'
import { initScratchGitRepo } from './support/scratch-git-repo'

const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt], env: {} })
const failingResolver: EngineResolver = ({ prompt }) => ({ cmd: '/bin/sh', args: ['-c', `echo "${prompt}"; exit 3`], env: {} })

let configDir: string
let repo: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-cli-follow-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir

  repo = await mkdtemp(join(homedir(), 'mc-cli-follow-scratch-'))
  await initScratchGitRepo(repo)
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function harness(resolver: EngineResolver) {
  const app = new Elysia().use(jobsRoutes(createJobManager(), resolver))
  let out = ''
  let err = ''
  const deps: MainDeps = {
    fetch: (request) => app.handle(request),
    stdout: (chunk) => { out += chunk },
    stderr: (chunk) => { err += chunk },
    env: { MISSION_CONTROL_CONFIG_DIR: configDir, MC_URL: 'http://localhost' },
    cwd: repo,
    pollMs: 30,
  }
  return { app, deps, out: () => out, err: () => err }
}

describe('job new --follow', () => {
  test('streams the echoed text and exits 0 when the job finishes', async () => {
    const h = harness(echoResolver)
    const code = await main(['job', 'new', 'hi-from-follow', '--follow'], h.deps)
    expect(h.out()).toContain('hi-from-follow')
    expect(code).toBe(0)
  })

  test('a failing job exits 1', async () => {
    const h = harness(failingResolver)
    const code = await main(['job', 'new', 'doomed-run', '--follow'], h.deps)
    expect(h.out()).toContain('doomed-run')
    expect(code).toBe(1)
  })

  test('--json prints NDJSON: the created job, each data payload, then the end status', async () => {
    const h = harness(echoResolver)
    const code = await main(['job', 'new', 'ndjson-text', '--follow', '--json'], h.deps)
    expect(code).toBe(0)
    const lines = h.out().trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]!.type).toBe('job')
    expect((lines[0]!.job as { id: string }).id).toBeString()
    const data = lines.filter((line) => line.type === 'data').map((line) => line.data).join('')
    expect(data).toContain('ndjson-text')
    expect(lines.at(-1)).toEqual({ type: 'end', status: 'done' })
  })
})

describe('job follow', () => {
  test('follows an existing job to its end', async () => {
    const h = harness(echoResolver)
    const created = await main(['job', 'new', 'existing-job', '--json'], h.deps)
    expect(created).toBe(0)
    const { id } = JSON.parse(h.out()) as { id: string }
    const f = harness(echoResolver)
    f.deps.fetch = h.deps.fetch
    const code = await main(['job', 'follow', id], f.deps)
    expect(code).toBe(0)
    expect(f.out()).toContain('existing-job')
  })

  test('a stream slower than the job still delivers the final output', async () => {
    const h = harness(echoResolver)
    await main(['job', 'new', 'late-tail', '--json'], h.deps)
    const { id } = JSON.parse(h.out()) as { id: string }
    const f = harness(echoResolver)
    f.deps.fetch = async (request) => {
      const response = await h.deps.fetch(request)
      if (!new URL(request.url).pathname.endsWith('/stream') || response.body === null) return response
      const source = response.body
      const delayed = new ReadableStream<Uint8Array>({
        async start(controller) {
          await Bun.sleep(500)
          const reader = source.getReader()
          for (;;) {
            const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
            if (done) break
            controller.enqueue(value)
          }
          controller.close()
        },
        cancel: () => source.cancel(),
      })
      return new Response(delayed, { headers: response.headers })
    }
    expect(await main(['job', 'follow', id], f.deps)).toBe(0)
    expect(f.out()).toContain('late-tail')
  })

  test('an unknown job id exits 1', async () => {
    const h = harness(echoResolver)
    expect(await main(['job', 'follow', 'nope'], h.deps)).toBe(1)
    expect(h.err()).toContain('job not found')
  })
})
