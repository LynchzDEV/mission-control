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

test('questionsOf ignores a stopped run even when its last step asked questions', () => {
  expect(questionsOf(run('stopped', [attempt({ result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })]))).toEqual([])
})

test('branchLabel keeps a long id whole and drops the title slug when there is no room', () => {
  const id = 'a'.repeat(70)
  expect(branchLabel({ title: 'Login copy', externalId: id })).toBe(`queue-${id}`)
})

test('a step blocked with questions keeps them when a parallel step is interrupted as the run blocks', () => {
  const asked = attempt({ nodeId: 'plan-a', number: 2, endedAt: 9, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })
  const sibling = attempt({ nodeId: 'plan-b', number: 1, endedAt: 10, interrupted: true, result: { outcome: 'blocked', summary: 'Interrupted before it finished', evidence: [] } })
  expect(questionsOf(run('blocked', [sibling, asked]))).toEqual(['Which page?'])
})

test('a join conflict the runner blocked on is never asked of the requester', () => {
  const join = attempt({ nodeId: 'join', number: 3, jobId: null, endedAt: 9, result: { outcome: 'blocked', summary: 'Paths could not be joined: a.ts', evidence: ['Joined: p1', 'Conflicts in p2: a.ts'] } })
  expect(questionsOf(run('blocked', [join]))).toEqual([])
})

test('questionsOf reads the questions of a step run in the session, which has no job', () => {
  const asked = attempt({ jobId: null, inSession: true, endedAt: 9, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })
  expect(questionsOf(run('blocked', [asked]))).toEqual(['Which page?'])
})

test('questionsOf does not reach back to an older blocked step once a join conflict blocks the run', () => {
  const older = attempt({ nodeId: 'plan-a', number: 1, endedAt: 5, result: { outcome: 'blocked', summary: 'Need info', evidence: ['Which page?'] } })
  const join = attempt({ nodeId: 'join', number: 2, jobId: null, endedAt: 9, result: { outcome: 'blocked', summary: 'Paths could not be joined: a.ts', evidence: ['Conflicts in p2: a.ts'] } })
  expect(questionsOf(run('blocked', [older, join]))).toEqual([])
})
