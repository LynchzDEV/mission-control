import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DIR_MODE, FILE_MODE, configDir } from './secrets'

export const PLANS_FILE = 'plans.jsonl'
export const MAX_PLAN_STEPS = 32
export const MAX_TITLE_CHARS = 120

export const ASSIGNEES = ['claude', 'glm', 'codex', 'user'] as const
export const STEP_STATUSES = ['pending', 'active', 'done'] as const

export type PlanAssignee = (typeof ASSIGNEES)[number]
export type PlanStepStatus = (typeof STEP_STATUSES)[number]

export type PlanStep = {
  title: string
  assignee: PlanAssignee
  status: PlanStepStatus
}

export type Plan = {
  label: string
  steps: PlanStep[]
  next: string | null
  updatedAt: number
}

export type PlanInput = {
  steps: PlanStep[]
  next: string | null
}

export type PlanParse = { ok: true; value: PlanInput } | { ok: false; error: string }

export type PlanPatchResult = { ok: true; plan: Plan } | { ok: false; status: number; error: string }

export type PlanStore = {
  get(label: string): Plan | undefined
  all(): Record<string, Plan>
  attach(label: string, input: PlanInput, at?: number): Promise<Plan>
  patchStep(label: string, index: number, status: PlanStepStatus): Promise<PlanPatchResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isAssignee(value: unknown): value is PlanAssignee {
  return typeof value === 'string' && (ASSIGNEES as readonly string[]).includes(value)
}

export function isStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value)
}

function parseStep(raw: unknown, index: number): { ok: true; value: PlanStep } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `steps[${index}] must be an object` }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title === '') return { ok: false, error: `steps[${index}].title is required` }
  if (!isAssignee(raw.assignee)) {
    return { ok: false, error: `steps[${index}].assignee must be one of ${ASSIGNEES.join(', ')}` }
  }
  const status = raw.status ?? 'pending'
  if (!isStepStatus(status)) {
    return { ok: false, error: `steps[${index}].status must be one of ${STEP_STATUSES.join(', ')}` }
  }
  return { ok: true, value: { title: title.slice(0, MAX_TITLE_CHARS), assignee: raw.assignee, status } }
}

export function parsePlanInput(body: unknown): PlanParse {
  if (!isRecord(body)) return { ok: false, error: 'body must be an object' }
  const raw = body.steps
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'steps must be a non-empty array' }
  if (raw.length > MAX_PLAN_STEPS) return { ok: false, error: `steps must hold at most ${MAX_PLAN_STEPS} entries` }

  const steps: PlanStep[] = []
  for (const [index, entry] of raw.entries()) {
    const parsed = parseStep(entry, index)
    if (!parsed.ok) return parsed
    steps.push(parsed.value)
  }

  const next = typeof body.next === 'string' && body.next.trim() !== '' ? body.next.trim() : null
  return { ok: true, value: { steps, next } }
}

function normalizePlan(raw: unknown): Plan | null {
  if (!isRecord(raw)) return null
  const label = typeof raw.label === 'string' ? raw.label : ''
  if (label === '') return null
  const parsed = parsePlanInput(raw)
  if (!parsed.ok) return null
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  return { label, steps: parsed.value.steps, next: parsed.value.next, updatedAt }
}

function loadPlans(path: string): Map<string, Plan> {
  const plans = new Map<string, Plan>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return plans
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
    const plan = normalizePlan(parsed)
    if (plan !== null) plans.set(plan.label, plan)
  }
  return plans
}

async function appendPlan(path: string, plan: Plan): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await appendFile(path, `${JSON.stringify(plan)}\n`, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

export function createPlanStore(): PlanStore {
  const path = join(configDir(), PLANS_FILE)
  const plans = loadPlans(path)

  async function attach(label: string, input: PlanInput, at: number = Date.now()): Promise<Plan> {
    const plan: Plan = { label, steps: input.steps, next: input.next, updatedAt: at }
    plans.set(label, plan)
    await appendPlan(path, plan)
    return plan
  }

  async function patchStep(label: string, index: number, status: PlanStepStatus): Promise<PlanPatchResult> {
    const plan = plans.get(label)
    if (plan === undefined) return { ok: false, status: 404, error: 'no plan for that session' }
    if (!Number.isInteger(index) || index < 0 || index >= plan.steps.length) {
      return { ok: false, status: 404, error: 'step index out of range' }
    }
    const steps = plan.steps.map((step, at) => (at === index ? { ...step, status } : step))
    const updated: Plan = { ...plan, steps, updatedAt: Date.now() }
    plans.set(label, updated)
    await appendPlan(path, updated)
    return { ok: true, plan: updated }
  }

  return {
    get: (label) => plans.get(label),
    all: () => Object.fromEntries(plans),
    attach,
    patchStep,
  }
}
