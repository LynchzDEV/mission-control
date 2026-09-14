import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJobManager, type JobManager, type JobRecord } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { composeTaskPrompt, createPlanRunner, parseRunInput, type PlanRunner, type RunInput } from '../server/plan-runner'
import { createPlanStore } from '../server/plans'
import { lintSpec } from '../server/spec-lint'
import { initScratchGitRepo } from './support/scratch-git-repo'

const PREAMBLE = `You are a Mission Control worker job.
## Decisions
1. Exactly as written.
## Preserve
- Everything else (server/index.ts).
Done means all of these hold, verified by you before you report:
1. Touched specs pass.`

const commitResolver: EngineResolver = ({ prompt }) => ({ cmd: 'git', args: ['commit', '-q', '--allow-empty', '-m', prompt.slice(0, 40)], env: {} })
const echoResolver: EngineResolver = ({ prompt }) => ({ cmd: 'echo', args: [prompt.slice(0, 20)], env: {} })
const failResolver: EngineResolver = () => ({ cmd: 'false', args: [], env: {} })
const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })

let configDir: string
let repo: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-plan-runner-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  repo = await mkdtemp(join(homedir(), 'mc-plan-runner-scratch-'))
  await initScratchGitRepo(repo)
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

function input(overrides: Partial<RunInput> = {}): RunInput {
  return {
    engine: 'glm',
    cwd: repo,
    label: 'products-v2-army',
    preamble: PREAMBLE,
    tasks: [
      { title: 'Add the constant', prompt: 'Create `app/models/x.rb` with the constant.' },
      { title: 'Add the spec', prompt: 'Create `spec/models/x_spec.rb` covering it.' },
    ],
    ...overrides,
  }
}

function build(resolver: EngineResolver): { manager: JobManager; runner: PlanRunner } {
  let runner!: PlanRunner
  const manager = createJobManager({ onJobSettled: (record: JobRecord) => void runner.onJobSettled(record) })
  runner = createPlanRunner({ manager, resolver, plans: createPlanStore() })
  return { manager, runner }
}

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((wait) => setTimeout(wait, 20))
  }
}

describe('composeTaskPrompt', () => {
  test('wraps one task as a single lint-clean step with a one-commit contract', () => {
    const prompt = composeTaskPrompt(input(), 1)
    expect(prompt.startsWith(PREAMBLE)).toBe(true)
    expect(prompt).toContain('## Steps\n### Step 2 of 2 — Add the spec\nCreate `spec/models/x_spec.rb` covering it.')
    expect(prompt).toContain('This job is task 2 of 2 only. Make exactly one commit for it, then stop and report the commit SHA.')
    expect(lintSpec(prompt)).toEqual([])
  })
})

describe('parseRunInput', () => {
  test('rejects a missing field, an empty task list and a task without a title', () => {
    expect(parseRunInput({ ...input(), preamble: '' })).toEqual({ ok: false, error: 'preamble is required' })
    expect(parseRunInput({ ...input(), tasks: [] })).toEqual({ ok: false, error: 'tasks must be a non-empty array' })
    expect(parseRunInput({ ...input(), tasks: [{ title: '', prompt: 'x' }] })).toEqual({ ok: false, error: 'tasks[0].title is required' })
    expect(parseRunInput({ ...input(), tasks: [{ title: 't', prompt: '' }] })).toEqual({ ok: false, error: 'tasks[0].prompt is required' })
  })

  test('returns the lint misses of the first task prompt that fails', () => {
    const parsed = parseRunInput({ ...input(), preamble: 'no sections' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toBe('spec lint failed for task 1')
    if (!parsed.ok) expect(parsed.misses).toContain('missing "## Decisions" section')
  })

  test('accepts a full input and keeps the model', () => {
    const parsed = parseRunInput({ ...input(), model: 'glm-x' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.model).toBe('glm-x')
  })
})

describe('createPlanRunner', () => {
  test('chains one job per task in the same worktree and finishes when every task committed', async () => {
    const { manager, runner } = build(commitResolver)
    const started = await runner.start(input())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.run.status).toBe('running')
    expect(started.run.tasks[0]!.status).toBe('running')
    expect(runner.plans.get('products-v2-army')?.steps.map((step) => [step.title, step.assignee, step.status])).toEqual([
      ['Add the constant', 'glm', 'active'],
      ['Add the spec', 'glm', 'pending'],
    ])

    await until(() => runner.get('products-v2-army')?.status === 'done')
    const run = runner.get('products-v2-army')!
    expect(run.tasks.map((task) => task.status)).toEqual(['done', 'done'])
    expect(run.tasks[0]!.commit).not.toBeNull()
    expect(run.tasks[1]!.commit).not.toBe(run.tasks[0]!.commit)
    const jobs = manager.listJobs().filter((job) => job.label === 'products-v2-army')
    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((job) => job.worktree)).size).toBe(1)
    expect(jobs.every((job) => job.status === 'done')).toBe(true)
    expect(runner.plans.get('products-v2-army')?.steps.map((step) => step.status)).toEqual(['done', 'done'])
    expect(runner.plans.get('products-v2-army')?.next).toBe('All 2 tasks committed')
  })

  test('a task that exits without a commit fails the run and leaves the rest pending', async () => {
    const { manager, runner } = build(echoResolver)
    await runner.start(input())
    await until(() => runner.get('products-v2-army')?.status === 'failed')
    const run = runner.get('products-v2-army')!
    expect(run.tasks.map((task) => task.status)).toEqual(['failed', 'pending'])
    expect(run.error).toBe('task 1 ended without a commit')
    expect(manager.listJobs()).toHaveLength(1)
    expect(runner.plans.get('products-v2-army')?.next).toBe('Task 1 failed: task 1 ended without a commit')
  })

  test('a job that exits non-zero fails the run', async () => {
    const { runner } = build(failResolver)
    await runner.start(input())
    await until(() => runner.get('products-v2-army')?.status === 'failed')
    expect(runner.get('products-v2-army')?.error).toBe('task 1 job failed')
  })

  test('stop kills the running job and dispatches nothing more', async () => {
    const { manager, runner } = build(sleepResolver)
    await runner.start(input())
    const stopped = await runner.stop('products-v2-army')
    expect(stopped).toEqual({ ok: true })
    await until(() => manager.listJobs()[0]?.status !== 'running')
    await new Promise((wait) => setTimeout(wait, 50))
    expect(runner.get('products-v2-army')?.status).toBe('stopped')
    expect(manager.listJobs()).toHaveLength(1)
    expect(await runner.stop('products-v2-army')).toEqual({ ok: false, status: 409, error: 'run is not running' })
    expect(await runner.stop('nope')).toEqual({ ok: false, status: 404, error: 'no run for that label' })
  })

  test('a second run on a running label is refused', async () => {
    const { runner } = build(sleepResolver)
    await runner.start(input())
    const again = await runner.start(input())
    expect(again).toEqual({ ok: false, status: 409, error: 'a run is already running for that label' })
    await runner.stop('products-v2-army')
  })
})
