import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PLANS_FILE, createPlanStore, parsePlanInput, type PlanInput } from '../server/plans'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-plans-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = dir
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(dir, { recursive: true, force: true })
})

const THREE_STEPS = {
  steps: [
    { title: 'Write the spec', assignee: 'claude', status: 'done' },
    { title: 'Implement the parser', assignee: 'glm' },
    { title: 'Cross-review the diff', assignee: 'codex', status: 'pending' },
  ],
  next: 'human verify on uat',
}

function input(): PlanInput {
  const parsed = parsePlanInput(THREE_STEPS)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

describe('parsePlanInput', () => {
  test('defaults a step status to pending and trims the next line', () => {
    const parsed = parsePlanInput({ steps: [{ title: '  Ship it  ', assignee: 'user' }], next: '  merge  ' })
    expect(parsed).toEqual({
      ok: true,
      value: { steps: [{ title: 'Ship it', assignee: 'user', status: 'pending' }], next: 'merge' },
    })
  })

  test('treats a missing or blank next as no next', () => {
    const parsed = parsePlanInput({ steps: [{ title: 'a', assignee: 'user' }] })
    const blank = parsePlanInput({ steps: [{ title: 'a', assignee: 'user' }], next: '   ' })
    expect(parsed.ok && parsed.value.next).toBeNull()
    expect(blank.ok && blank.value.next).toBeNull()
  })

  test('rejects malformed bodies with a reason', () => {
    expect(parsePlanInput(null).ok).toBe(false)
    expect(parsePlanInput({ steps: [] }).ok).toBe(false)
    expect(parsePlanInput({ steps: 'nope' }).ok).toBe(false)
    expect(parsePlanInput({ steps: [{ title: '', assignee: 'claude' }] }).ok).toBe(false)
    expect(parsePlanInput({ steps: [{ title: 'a', assignee: 'fable' }] }).ok).toBe(false)
    expect(parsePlanInput({ steps: [{ title: 'a', assignee: 'claude', status: 'blocked' }] }).ok).toBe(false)
    expect(parsePlanInput({ steps: Array.from({ length: 33 }, () => ({ title: 'a', assignee: 'user' })) }).ok).toBe(
      false,
    )
  })
})

describe('createPlanStore', () => {
  test('attaches a plan, reads it back, and persists it as jsonl', async () => {
    const store = createPlanStore()
    const plan = await store.attach('plan-demo', input(), 1_700_000_000_000)

    expect(plan.label).toBe('plan-demo')
    expect(plan.steps.map((step) => step.status)).toEqual(['done', 'pending', 'pending'])
    expect(store.get('plan-demo')).toEqual(plan)
    expect(store.all()).toEqual({ 'plan-demo': plan })

    const raw = await readFile(join(dir, PLANS_FILE), 'utf8')
    expect(raw.trim().split('\n').length).toBe(1)
  })

  test('patches one step and leaves the others alone', async () => {
    const store = createPlanStore()
    await store.attach('plan-demo', input())

    const patched = await store.patchStep('plan-demo', 1, 'active')
    expect(patched.ok && patched.plan.steps.map((step) => step.status)).toEqual(['done', 'active', 'pending'])
    expect(store.get('plan-demo')?.steps[1]?.status).toBe('active')
  })

  test('404s an unknown label and an out-of-range index', async () => {
    const store = createPlanStore()
    await store.attach('plan-demo', input())

    expect(await store.patchStep('nobody-home', 0, 'done')).toEqual({
      ok: false,
      status: 404,
      error: 'no plan for that session',
    })
    for (const index of [-1, 3, Number.NaN]) {
      const result = await store.patchStep('plan-demo', index, 'done')
      expect(result.ok).toBe(false)
    }
  })

  test('reloads the newest write per label across a manager restart', async () => {
    const first = createPlanStore()
    await first.attach('plan-demo', input())
    await first.attach('other', input())
    await first.patchStep('plan-demo', 2, 'done')
    await first.attach('plan-demo', { steps: [{ title: 'Rewritten', assignee: 'user', status: 'active' }], next: null })

    const reloaded = createPlanStore()
    expect(reloaded.get('plan-demo')?.steps).toEqual([{ title: 'Rewritten', assignee: 'user', status: 'active' }])
    expect(reloaded.get('plan-demo')?.next).toBeNull()
    expect(reloaded.get('other')?.steps.length).toBe(3)
    expect(Object.keys(reloaded.all()).sort()).toEqual(['other', 'plan-demo'])
  })

  test('skips unreadable and malformed lines on load', async () => {
    const store = createPlanStore()
    await store.attach('plan-demo', input())
    await Bun.write(
      join(dir, PLANS_FILE),
      `not json\n{"label":"broken"}\n${JSON.stringify(store.get('plan-demo'))}\n`,
    )

    const reloaded = createPlanStore()
    expect(Object.keys(reloaded.all())).toEqual(['plan-demo'])
  })
})
