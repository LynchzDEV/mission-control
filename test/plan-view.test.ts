import { describe, expect, test } from 'bun:test'

import { parsePlan, templateNodeSpecs } from '../client/plan-view'

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
