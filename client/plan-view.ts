import { readArray, readRecord, type JsonRecord } from './shared'

export type PlanStep = { title: string; assignee: string; status: string }
export type Plan = { steps: PlanStep[]; next: string }

export type StageState = 'done' | 'active' | 'queued' | 'future' | 'error'
export type Stage = [StageState, string]
export type SessionFlow = Record<string, Stage>

export const STAGES = ['spec', 'impl', 'codex', 'verify', 'merged'] as const

export type TemplateSpec = {
  id: string
  chipId: string
  className: string
  chipText: string
  trimmable: boolean
}

export function templateNodeSpecs(stages: SessionFlow): TemplateSpec[] {
  return STAGES.map((stage) => ({
    id: `nd-${stage}`,
    chipId: `lc-${stage}`,
    className: `node tpl ${stages[stage]?.[0] ?? 'future'}`,
    chipText: stages[stage]?.[1] ?? '',
    trimmable: stage !== 'merged',
  }))
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toStep(raw: JsonRecord): PlanStep | null {
  const title = str(raw.title)
  if (title === '') return null
  return { title, assignee: str(raw.assignee), status: str(raw.status) }
}

export function parsePlan(raw: unknown): Plan | null {
  const record = readRecord(raw)
  const steps = readArray(record.steps)
    .map(toStep)
    .filter((step): step is PlanStep => step !== null)
  if (steps.length === 0) return null
  return { steps, next: str(record.next) }
}
