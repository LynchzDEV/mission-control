import { describe, expect, test } from 'bun:test'

import {
  FLOW_BOTTOM_INSET,
  FLOW_NODE_H,
  FLOW_ROW_GAP,
  FLOW_TOP_INSET,
  LANE_LEFT,
  MAX_ROW_NODES,
  NEXT_LABEL_DROP,
  ROW_TOPS_SINGLE,
  ROW_TOPS_SPLIT,
  TEMPLATE_RAISE_MAX,
  TEMPLATE_RAISE_MIN,
  assigneeClass,
  flowContentH,
  rowTops,
  templateTops,
  nextLabelSpec,
  parsePlan,
  planNodeSpecs,
  planLayout,
  planRows,
  stepGlyph,
  stepNodeState,
  templateNodeSpecs,
} from '../client/plan-view'

describe('planRows', () => {
  test('keeps up to six steps on one row', () => {
    expect(planRows(1)).toEqual([[0]])
    expect(planRows(MAX_ROW_NODES)).toEqual([[0, 1, 2, 3, 4, 5]])
  })

  test('wraps to a second row past six, splitting as evenly as possible', () => {
    expect(planRows(7)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6],
    ])
    expect(planRows(8)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ])
    expect(planRows(13).map((row) => row.length)).toEqual([7, 6])
  })

  test('never returns more than two rows and handles a zero count', () => {
    expect(planRows(0)).toEqual([])
    for (const count of [9, 16, 32]) expect(planRows(count).length).toBe(2)
  })
})

describe('planLayout', () => {
  test('places a three-step plan on the single main row with even spacing', () => {
    const boxes = planLayout(3)

    expect(boxes.length).toBe(3)
    expect(boxes.map((box) => box.top)).toEqual([ROW_TOPS_SINGLE[0], ROW_TOPS_SINGLE[0], ROW_TOPS_SINGLE[0]])
    expect(boxes.map((box) => box.row)).toEqual([0, 0, 0])
    expect(boxes[0]?.left).toBe(`${LANE_LEFT.toFixed(2)}%`)
    expect(boxes.map((box) => box.left)).toEqual(['2.00%', '33.33%', '64.67%'])
  })

  test('uses the split rows once the plan wraps', () => {
    const boxes = planLayout(8)

    expect(boxes.map((box) => box.row)).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    expect(boxes[0]?.top).toBe(ROW_TOPS_SPLIT[0] as string)
    expect(boxes[7]?.top).toBe(ROW_TOPS_SPLIT[1] as string)
    expect(boxes[4]?.left).toBe(boxes[0]?.left)
  })

  test('lays out nothing for an empty plan', () => {
    expect(planLayout(0)).toEqual([])
  })
})

describe('rowTops', () => {
  test('centres a single row in the space below the caption', () => {
    const [top] = rowTops(1, 520)
    const band = 520 - FLOW_TOP_INSET - FLOW_BOTTOM_INSET
    expect(top).toBeCloseTo(FLOW_TOP_INSET + (band - FLOW_NODE_H) / 2, 5)
    expect(top).toBeGreaterThan(FLOW_TOP_INSET)
  })

  test('moves the single row down as the container grows', () => {
    const short = rowTops(1, 190)[0] as number
    const tall = rowTops(1, 700)[0] as number
    expect(tall).toBeGreaterThan(short)
  })

  test('spaces two rows evenly and never overlaps them', () => {
    const [first, second] = rowTops(2, 700) as [number, number]
    const band = 700 - FLOW_TOP_INSET - FLOW_BOTTOM_INSET
    expect(second - first).toBeCloseTo(band / 2, 5)
    expect(second - first).toBeGreaterThanOrEqual(FLOW_NODE_H)
  })

  test('keeps a minimum row pitch when the container is too short to space evenly', () => {
    const [first, second] = rowTops(2, 190) as [number, number]
    expect(second - first).toBe(FLOW_NODE_H + FLOW_ROW_GAP)
  })

  test('returns nothing for zero rows', () => {
    expect(rowTops(0, 520)).toEqual([])
  })
})

describe('flowContentH', () => {
  test('reports the height a short container has to scroll to', () => {
    const tops = rowTops(2, 190)
    expect(flowContentH(tops)).toBe((tops[1] as number) + FLOW_NODE_H + FLOW_BOTTOM_INSET)
    expect(flowContentH(tops)).toBeGreaterThan(190)
  })

  test('a one-row layout always fits its own container', () => {
    for (const height of [190, 320, 520, 800]) {
      expect(flowContentH(rowTops(1, height))).toBeLessThanOrEqual(height)
    }
  })

  test('is zero when there is nothing to place', () => {
    expect(flowContentH([])).toBe(0)
  })
})

describe('templateTops', () => {
  test('raises the cross-review node above the main row and scales the gap', () => {
    const short = templateTops(190)
    const tall = templateTops(700)
    expect(short.main - short.raised).toBe(TEMPLATE_RAISE_MIN)
    expect(tall.main - tall.raised).toBe(TEMPLATE_RAISE_MAX)
    expect(tall.main).toBeGreaterThan(short.main)
    expect(tall.raised).toBeGreaterThan(short.raised)
  })

  test('fits the default flow height without scrolling', () => {
    const tops = templateTops(190)
    expect(flowContentH([tops.raised, tops.main])).toBeLessThanOrEqual(190)
  })

  test('drops the labels between and just below the rows', () => {
    const tops = templateTops(520)
    expect(tops.labelA).toBeGreaterThan(tops.raised)
    expect(tops.labelA).toBeLessThan(tops.main)
    expect(tops.labelB).toBeGreaterThan(tops.main)
  })
})

describe('planLayout with a live container height', () => {
  test('derives node tops from the container instead of the fixed fallback', () => {
    const boxes = planLayout(3, 520)
    expect(boxes[0]?.top).not.toBe(ROW_TOPS_SINGLE[0])
    expect(boxes[0]?.top).toBe(`${Math.round(rowTops(1, 520)[0] as number)}px`)
  })

  test('keeps the horizontal layout identical whatever the height', () => {
    const flat = planLayout(8).map((box) => box.left)
    expect(planLayout(8, 520).map((box) => box.left)).toEqual(flat)
    expect(planLayout(8, 900).map((box) => box.left)).toEqual(flat)
  })

  test('falls back to the fixed rows when no height is known', () => {
    expect(planLayout(3, 0).map((box) => box.top)).toEqual([ROW_TOPS_SINGLE[0], ROW_TOPS_SINGLE[0], ROW_TOPS_SINGLE[0]])
  })

  test('the next-step label follows the last row down', () => {
    const label = nextLabelSpec({ steps: [{ title: 'a', assignee: 'glm', status: 'active' }], next: 'ship' }, 700)
    const expected = Math.round(rowTops(1, 700)[0] as number) + NEXT_LABEL_DROP
    expect(label?.top).toBe(`${expected}px`)
  })

  test('node specs move with the container height', () => {
    const plan = { steps: [{ title: 'a', assignee: 'glm', status: 'active' }], next: '' }
    expect(planNodeSpecs(plan, 190)[0]?.top).not.toBe(planNodeSpecs(plan, 700)[0]?.top)
  })
})

describe('step presentation', () => {
  test('maps a step status to a node state and a glyph', () => {
    expect(['pending', 'active', 'done'].map(stepNodeState)).toEqual(['future', 'active', 'done'])
    expect(['pending', 'active', 'done'].map(stepGlyph)).toEqual(['·', '▸', '✓'])
    expect(stepNodeState('nonsense')).toBe('future')
  })

  test('maps an assignee to its engine accent class', () => {
    expect(['claude', 'glm', 'codex', 'user'].map(assigneeClass)).toEqual([
      'c-claude',
      'c-glm',
      'c-white',
      'c-user',
    ])
    expect(assigneeClass('someone-else')).toBe('c-user')
  })
})

describe('planNodeSpecs', () => {
  const PLAN = {
    steps: [
      { title: 'Spec the parser', assignee: 'claude', status: 'done' },
      { title: 'Implement it', assignee: 'glm', status: 'active' },
      { title: 'Cross-review', assignee: 'codex', status: 'pending' },
    ],
    next: 'human verify on uat',
  }

  test('renders one node per plan step, in order, with the step state and assignee accent', () => {
    const specs = planNodeSpecs(PLAN)

    expect(specs.length).toBe(3)
    expect(specs.map((spec) => spec.id)).toEqual(['pn-0', 'pn-1', 'pn-2'])
    expect(specs.map((spec) => spec.className)).toEqual([
      'node step done',
      'node step active',
      'node step future',
    ])
    expect(specs.map((spec) => spec.title)).toEqual([
      '1. Spec the parser',
      '2. Implement it',
      '3. Cross-review',
    ])
    expect(specs.map((spec) => spec.chipClass)).toEqual([
      'lane-chip c-claude',
      'lane-chip c-glm',
      'lane-chip c-white',
    ])
    expect(specs.map((spec) => spec.chipText)).toEqual(['CLAUDE', 'GLM', 'CODEX'])
  })

  test('scales to any step count, not just the five fixed stages', () => {
    const steps = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        title: `step ${index}`,
        assignee: 'user',
        status: 'pending',
      }))

    expect(planNodeSpecs({ steps: steps(1), next: '' }).length).toBe(1)
    expect(planNodeSpecs({ steps: steps(9), next: '' }).length).toBe(9)
    expect(new Set(planNodeSpecs({ steps: steps(9), next: '' }).map((spec) => spec.top)).size).toBe(2)
  })

  test('places the NEXT label under the last node, and omits it when there is no next', () => {
    const label = nextLabelSpec(PLAN)

    expect(label?.text).toBe('NEXT → human verify on uat')
    expect(label?.left).toBe(planNodeSpecs(PLAN)[2]?.left)
    expect(label?.top).toBe(`${96 + NEXT_LABEL_DROP}px`)
    expect(nextLabelSpec({ steps: PLAN.steps, next: '' })).toBeNull()
  })
})

describe('templateNodeSpecs', () => {
  test('falls back to the five fixed stage nodes for a session with no plan', () => {
    const specs = templateNodeSpecs({
      spec: ['done', 'CLAUDE'],
      impl: ['active', 'GLM · 4m · orders'],
      codex: ['queued', 'CODEX · QUEUED'],
      verify: ['future', ''],
      merged: ['future', '0 TODAY'],
    })

    expect(specs.map((spec) => spec.id)).toEqual(['nd-spec', 'nd-impl', 'nd-codex', 'nd-verify', 'nd-merged'])
    expect(specs.map((spec) => spec.className)).toEqual([
      'node tpl done',
      'node tpl active',
      'node tpl queued',
      'node tpl future',
      'node tpl future',
    ])
    expect(specs[1]?.chipText).toBe('GLM · 4m · orders')
    expect(specs.map((spec) => spec.trimmable)).toEqual([true, true, true, true, false])
  })

  test('treats a missing stage as future', () => {
    expect(templateNodeSpecs({}).map((spec) => spec.className)).toEqual([
      'node tpl future',
      'node tpl future',
      'node tpl future',
      'node tpl future',
      'node tpl future',
    ])
  })
})

describe('parsePlan', () => {
  test('reads the plan shape the flow response serves', () => {
    expect(
      parsePlan({
        label: 'plan-demo',
        steps: [
          { title: 'Spec', assignee: 'claude', status: 'done' },
          { title: 'Build', assignee: 'glm', status: 'active' },
        ],
        next: 'verify on uat',
      }),
    ).toEqual({
      steps: [
        { title: 'Spec', assignee: 'claude', status: 'done' },
        { title: 'Build', assignee: 'glm', status: 'active' },
      ],
      next: 'verify on uat',
    })
  })

  test('returns null for a session with no plan and drops unusable steps', () => {
    expect(parsePlan(null)).toBeNull()
    expect(parsePlan({ steps: [] })).toBeNull()
    expect(parsePlan({ steps: [{ assignee: 'glm' }] })).toBeNull()
    expect(parsePlan({ steps: [{ title: 'ok', assignee: 'glm' }, 'junk', { title: '' }], next: null })).toEqual({
      steps: [{ title: 'ok', assignee: 'glm', status: '' }],
      next: '',
    })
  })
})
