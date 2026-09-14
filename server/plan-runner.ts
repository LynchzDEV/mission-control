import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { git, worktreeBranch } from './job-worktrees'
import type { JobManager, JobRecord } from './jobs'
import type { EngineResolver } from './jobs-engine-iface'
import { type PlanAssignee, type PlanStore, isAssignee } from './plans'
import { configDir } from './secrets'
import { lintSpec } from './spec-lint'

export const RUNS_FILE = 'runs.jsonl'
export const MAX_RUN_TASKS = 32
const DIR_MODE = 0o700
const FILE_MODE = 0o600

export type RunTask = { title: string; prompt: string }
export type RunInput = {
  engine: string
  model?: string
  cwd: string
  label: string
  terminalId?: string
  preamble: string
  tasks: RunTask[]
}
export type RunTaskState = RunTask & { status: 'pending' | 'running' | 'done' | 'failed'; jobId: string | null; commit: string | null }
export type Run = {
  id: string
  label: string
  engine: string
  model: string | null
  cwd: string
  terminalId: string | null
  preamble: string
  tasks: RunTaskState[]
  status: 'running' | 'done' | 'failed' | 'stopped'
  error: string | null
  createdAt: number
  updatedAt: number
}
export type RunParse = { ok: true; value: RunInput } | { ok: false; error: string; misses?: string[] }
export type StartResult = { ok: true; run: Run } | { ok: false; status: number; error: string }
export type StopResult = { ok: true } | { ok: false; status: number; error: string }
export type PlanRunner = {
  plans: PlanStore
  start(input: RunInput): Promise<StartResult>
  stop(label: string): Promise<StopResult>
  get(label: string): Run | undefined
  all(): Run[]
  onJobSettled(record: JobRecord): Promise<void>
}

export function composeTaskPrompt(input: RunInput, index: number): string {
  const task = input.tasks[index]!
  const total = input.tasks.length
  return `${input.preamble}

## Steps
### Step ${index + 1} of ${total} — ${task.title}
${task.prompt}

This job is task ${index + 1} of ${total} only. Make exactly one commit for it, then stop and report the commit SHA. Do not start task ${index + 2}.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRunInput(body: unknown): RunParse {
  if (!isRecord(body)) return { ok: false, error: 'body must be an object' }
  for (const field of ['engine', 'cwd', 'label', 'preamble'] as const) {
    if (typeof body[field] !== 'string' || body[field] === '') return { ok: false, error: `${field} is required` }
  }
  if (!Array.isArray(body.tasks) || body.tasks.length === 0) return { ok: false, error: 'tasks must be a non-empty array' }
  if (body.tasks.length > MAX_RUN_TASKS) return { ok: false, error: `tasks must hold at most ${MAX_RUN_TASKS} entries` }
  const tasks: RunTask[] = []
  for (const [index, raw] of body.tasks.entries()) {
    const title = isRecord(raw) && typeof raw.title === 'string' ? raw.title.trim() : ''
    if (title === '') return { ok: false, error: `tasks[${index}].title is required` }
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    if (prompt === '') return { ok: false, error: `tasks[${index}].prompt is required` }
    tasks.push({ title, prompt })
  }
  const value: RunInput = {
    engine: body.engine as string,
    cwd: body.cwd as string,
    label: body.label as string,
    preamble: body.preamble as string,
    tasks,
    ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
    ...(typeof body.terminalId === 'string' && body.terminalId !== '' ? { terminalId: body.terminalId } : {}),
  }
  for (const index of tasks.keys()) {
    const misses = lintSpec(composeTaskPrompt(value, index))
    if (misses.length > 0) return { ok: false, error: `spec lint failed for task ${index + 1}`, misses }
  }
  return { ok: true, value }
}

function loadRuns(path: string): Map<string, Run> {
  const runs = new Map<string, Run>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return runs
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const run = JSON.parse(line) as Run
      if (typeof run.label === 'string') runs.set(run.label, run)
    } catch {}
  }
  return runs
}

// ponytail: a run that was mid-flight at restart stays "running" on disk with no process behind it; stop it and start again
export function createPlanRunner(deps: { manager: JobManager; resolver: EngineResolver; plans: PlanStore }): PlanRunner {
  const path = join(configDir(), RUNS_FILE)
  const runs = loadRuns(path)
  const heads = new Map<string, string>()
  const settling = new Set<string>()

  async function headBefore(run: Run, index: number): Promise<string> {
    if (index > 0) return run.tasks[index - 1]!.commit ?? ''
    const branch = await git(run.cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${worktreeBranch(run.label)}`).catch(() => '')
    return branch !== '' ? branch : await git(run.cwd, 'rev-parse', 'HEAD').catch(() => '')
  }

  async function persist(run: Run): Promise<void> {
    runs.set(run.label, run)
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
    await appendFile(path, `${JSON.stringify(run)}\n`, { mode: FILE_MODE })
    await chmod(path, FILE_MODE)
  }

  async function syncPlan(run: Run, next: string): Promise<void> {
    const assignee: PlanAssignee = isAssignee(run.engine) ? run.engine : 'user'
    const steps = run.tasks.map((task) => ({
      title: task.title,
      assignee,
      status: task.status === 'done' ? ('done' as const) : task.status === 'pending' ? ('pending' as const) : ('active' as const),
    }))
    await deps.plans.attach(run.label, { steps, next })
  }

  async function dispatch(run: Run, index: number): Promise<Run> {
    const before = await headBefore(run, index)
    const input: RunInput = { engine: run.engine, cwd: run.cwd, label: run.label, preamble: run.preamble, tasks: run.tasks, ...(run.model === null ? {} : { model: run.model }) }
    const result = await deps.manager.createJob(
      {
        engine: run.engine,
        cwd: run.cwd,
        prompt: composeTaskPrompt(input, index),
        label: run.label,
        worktree: true,
        ...(run.terminalId === null ? {} : { terminalId: run.terminalId }),
        ...(run.model === null ? {} : { model: run.model }),
      },
      deps.resolver,
    )
    if (!result.ok) {
      const failed: Run = { ...run, status: 'failed', error: `task ${index + 1} could not start: ${result.error}`, updatedAt: Date.now() }
      await persist(failed)
      await syncPlan(failed, `Task ${index + 1} failed: ${failed.error}`)
      return failed
    }
    heads.set(result.job.id, before)
    const tasks = run.tasks.map((task, at) => (at === index ? { ...task, status: 'running' as const, jobId: result.job.id } : task))
    const running: Run = { ...run, tasks, status: 'running', updatedAt: Date.now() }
    await persist(running)
    await syncPlan(running, `Task ${index + 1} of ${run.tasks.length} running`)
    const settled = deps.manager.getJob(result.job.id)
    if (settled !== undefined && settled.status !== 'running') await onJobSettled(settled)
    return runs.get(run.label) ?? running
  }

  async function start(input: RunInput): Promise<StartResult> {
    if (runs.get(input.label)?.status === 'running') return { ok: false, status: 409, error: 'a run is already running for that label' }
    const run: Run = {
      id: crypto.randomUUID(),
      label: input.label,
      engine: input.engine,
      model: input.model ?? null,
      cwd: input.cwd,
      terminalId: input.terminalId ?? null,
      preamble: input.preamble,
      tasks: input.tasks.map((task) => ({ ...task, status: 'pending', jobId: null, commit: null })),
      status: 'running',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const started = await dispatch(run, 0)
    if (started.status === 'failed') return { ok: false, status: 400, error: started.error ?? 'run failed to start' }
    return { ok: true, run: started }
  }

  async function fail(run: Run, index: number, error: string): Promise<void> {
    const tasks = run.tasks.map((task, at) => (at === index ? { ...task, status: 'failed' as const } : task))
    const failed: Run = { ...run, tasks, status: 'failed', error, updatedAt: Date.now() }
    await persist(failed)
    await syncPlan(failed, `Task ${index + 1} failed: ${error}`)
  }

  async function onJobSettled(record: JobRecord): Promise<void> {
    const run = runs.get(record.label)
    if (run === undefined || run.status !== 'running') return
    const index = run.tasks.findIndex((task) => task.jobId === record.id && task.status === 'running')
    if (index === -1 || settling.has(record.id)) return
    settling.add(record.id)
    try {
      const before = heads.get(record.id) ?? ''
      heads.delete(record.id)
      if (record.status !== 'done') return await fail(run, index, `task ${index + 1} job ${record.status}`)
      const after = await git(record.cwd, 'rev-parse', 'HEAD').catch(() => before)
      if (after === before) return await fail(run, index, `task ${index + 1} ended without a commit`)
      const tasks = run.tasks.map((task, at) => (at === index ? { ...task, status: 'done' as const, commit: after } : task))
      const advanced: Run = { ...run, tasks, updatedAt: Date.now() }
      if (index + 1 < run.tasks.length) {
        await dispatch(advanced, index + 1)
        return
      }
      const done: Run = { ...advanced, status: 'done' }
      await persist(done)
      await syncPlan(done, `All ${run.tasks.length} tasks committed`)
    } finally {
      settling.delete(record.id)
    }
  }

  async function stop(label: string): Promise<StopResult> {
    const run = runs.get(label)
    if (run === undefined) return { ok: false, status: 404, error: 'no run for that label' }
    if (run.status !== 'running') return { ok: false, status: 409, error: 'run is not running' }
    const stopped: Run = { ...run, status: 'stopped', updatedAt: Date.now() }
    await persist(stopped)
    const current = run.tasks.find((task) => task.status === 'running')
    if (current?.jobId) await deps.manager.killJob(current.jobId)
    await syncPlan(stopped, `Stopped at task ${run.tasks.findIndex((task) => task.status === 'running') + 1}`)
    return { ok: true }
  }

  return { plans: deps.plans, start, stop, get: (label) => runs.get(label), all: () => [...runs.values()], onJobSettled }
}
