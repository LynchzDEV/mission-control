import { expect, test } from 'bun:test'

import { answersMarkdown, branchLabel, questionsOf, runRequest, SETTLED, type RunView } from '../server/queue-prompts'
import type { WorkflowAttempt } from '../server/workflow-runner'

const attempt = (over: Partial<WorkflowAttempt>): WorkflowAttempt => ({ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: null, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [], ...over })
const run = (status: RunView['status'], attempts: WorkflowAttempt[]): RunView => ({ id: 'r1', status, error: null, attempts })

test('SETTLED holds the four end states', () => {
  expect([...SETTLED].sort()).toEqual(['blocked', 'done', 'failed', 'stopped'])
})

test('branchLabel is queue- plus a short slug of the title and the id', () => {
  expect(branchLabel({ title: 'Login page copy (TH)!', externalId: '86d3j4f8q' })).toBe('queue-login-page-copy-th-86d3j4f8q')
  expect(branchLabel({ title: 'ภาษาไทย', externalId: 'abc' })).toBe('queue-abc')
  expect(branchLabel({ title: 'x'.repeat(80), externalId: 'id' }).length).toBeLessThanOrEqual(60)
})

test('runRequest points at the context, lists answers, and explains how to ask', () => {
  const text = runRequest({ title: 'Login copy', url: 'https://x/t/1', contextPath: '/wt/.mission-control/context/clickup-board/item.md', answerPaths: ['/wt/a1.md'] })
  expect(text).toContain('Work on "Login copy" (https://x/t/1).')
  expect(text).toContain('Read the task context in /wt/.mission-control/context/clickup-board/item.md.')
  expect(text).toContain('The requester answered your earlier questions: read /wt/a1.md.')
  expect(text).toContain('MC_RESULT blocked')
  expect(runRequest({ title: 'T', url: 'u', contextPath: '/c.md', answerPaths: [] })).not.toContain('answered')
})

test('questionsOf reads the evidence of the last settled blocked step', () => {
  const asked = run('blocked', [
    attempt({ nodeId: 'plan', number: 1, endedAt: 5, result: { outcome: 'fail', summary: 'x', evidence: ['old'] } }),
    attempt({ nodeId: 'plan', number: 2, endedAt: 9, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?', '  ', 'Thai or English?'] } }),
  ])
  expect(questionsOf(asked)).toEqual(['Which page?', 'Thai or English?'])
})

test('questionsOf is empty for a cap block, an interrupt, a pass or a run without results', () => {
  expect(questionsOf(run('blocked', [attempt({ result: { outcome: 'fail', summary: 'cap', evidence: ['e'] } })]))).toEqual([])
  expect(questionsOf(run('blocked', [attempt({ interrupted: true, result: { outcome: 'blocked', summary: 'Interrupted before it finished', evidence: ['x'] } })]))).toEqual([])
  expect(questionsOf(run('done', [attempt({ result: { outcome: 'pass', summary: 'ok', evidence: ['e'] } })]))).toEqual([])
  expect(questionsOf(run('failed', []))).toEqual([])
})

test('answersMarkdown pairs the questions with each reply and its images', () => {
  const md = answersMarkdown(['Which page?'], [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }, { id: 'r2', author: 'Ploy', text: 'See screenshot', images: [] }], ['/wt/ctx/shot.png'])
  expect(md).toBe('# Answers from the requester\n\n## Questions asked\n\n- Which page?\n\n## Replies\n\n### Ploy\n\nThe login page\n\n### Ploy\n\nSee screenshot\n\n## Images\n\n- /wt/ctx/shot.png\n')
})
