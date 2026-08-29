import { readArray, readRecord, type JsonRecord } from './shared'

export type PlanStep = { title: string; assignee: string; status: string }
export type Plan = { steps: PlanStep[]; next: string }
export type NodeBox = { left: string; top: string; row: number }

export type StageState = 'done' | 'active' | 'queued' | 'future' | 'error'
export type Stage = [StageState, string]
export type SessionFlow = Record<string, Stage>

export const STAGES = ['spec', 'impl', 'codex', 'verify', 'merged'] as const

export const MAX_ROW_NODES = 6
export const ROW_TOPS_SINGLE = ['96px']
export const ROW_TOPS_SPLIT = ['34px', '112px']
export const LANE_LEFT = 2
export const LANE_SPAN = 94

const ASSIGNEE_CLASS: Record<string, string> = {
  claude: 'c-claude',
  glm: 'c-glm',
  codex: 'c-white',
  user: 'c-user',
}

const STEP_STATE: Record<string, string> = {
  done: 'done',
  active: 'active',
  pending: 'future',
}

const STEP_GLYPH: Record<string, string> = {
  done: '✓',
  active: '▸',
  pending: '·',
}

export function assigneeClass(assignee: string): string {
  return ASSIGNEE_CLASS[assignee] ?? 'c-user'
}

export function stepNodeState(status: string): string {
  return STEP_STATE[status] ?? 'future'
}

export function stepGlyph(status: string): string {
  return STEP_GLYPH[status] ?? '·'
}

export function planRows(count: number): number[][] {
  const total = Math.max(0, Math.floor(count))
  if (total === 0) return []
  const perRow = total <= MAX_ROW_NODES ? total : Math.ceil(total / 2)
  const rows: number[][] = []
  for (let start = 0; start < total; start += perRow) {
    const size = Math.min(perRow, total - start)
    rows.push(Array.from({ length: size }, (_unused, offset) => start + offset))
  }
  return rows
}

export function planLayout(count: number): NodeBox[] {
  const rows = planRows(count)
  const tops = rows.length > 1 ? ROW_TOPS_SPLIT : ROW_TOPS_SINGLE
  const boxes: NodeBox[] = []
  rows.forEach((row, rowIndex) => {
    const stride = LANE_SPAN / row.length
    row.forEach((_index, column) => {
      boxes.push({
        left: `${(LANE_LEFT + column * stride).toFixed(2)}%`,
        top: tops[Math.min(rowIndex, tops.length - 1)] as string,
        row: rowIndex,
      })
    })
  })
  return boxes
}

export type NodeSpec = {
  id: string
  className: string
  left: string
  top: string
  title: string
  chipClass: string
  chipText: string
}

export type LabelSpec = { text: string; left: string; top: string }

export const NEXT_LABEL_DROP = 62

export function planNodeSpecs(plan: Plan): NodeSpec[] {
  const boxes = planLayout(plan.steps.length)
  return plan.steps.flatMap((step, index) => {
    const box = boxes[index]
    if (box === undefined) return []
    return [
      {
        id: `pn-${index}`,
        className: `node step ${stepNodeState(step.status)}`,
        left: box.left,
        top: box.top,
        title: `${index + 1}. ${step.title}`,
        chipClass: `lane-chip ${assigneeClass(step.assignee)}`,
        chipText: step.assignee.toUpperCase(),
      },
    ]
  })
}

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

export function nextLabelSpec(plan: Plan): LabelSpec | null {
  if (plan.next === '') return null
  const boxes = planLayout(plan.steps.length)
  const last = boxes[boxes.length - 1]
  if (last === undefined) return null
  return {
    text: `NEXT → ${plan.next}`,
    left: last.left,
    top: `${Number.parseInt(last.top, 10) + NEXT_LABEL_DROP}px`,
  }
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
