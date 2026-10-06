import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { questionsOf, runRequest, type RunView } from '../server/queue-prompts'
import { prepareRepoWorkspace } from '../server/repo-workspace'
import { git, repoAt } from './support/git-repos'
import { blockedWith, queueHarness } from './support/queue-harness'

let parent: string
let scratch: string

beforeEach(async () => {
  parent = await mkdtemp(join(homedir(), 'mc-plan-picks-'))
  scratch = await mkdtemp(join(tmpdir(), 'mc-plan-picks-scratch-'))
})
afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const repos = async (...names: string[]) => { for (const name of names) await repoAt(join(parent, name)) }
const multi = { source: 'clickup-board', externalId: '7', repo: '' }
const workspace = () => join(parent, '.worktree', 'queue-task-7-7-a8c0')
const harness = () => queueHarness(scratch, { prepareWorkspace: (folder, names, label) => prepareRepoWorkspace(folder, names, label) })
const blocked = (evidence: string[]): Partial<RunView> => ({ status: 'blocked', attempts: [blockedWith(evidence)] })

test('a multi-repo item with no repos ticked builds in an empty workspace and tells the agent how to ask for repos', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', repos: [], worktree: workspace() })
  expect(JSON.parse(await readFile(join(workspace(), '.mission-control', 'repos.json'), 'utf8'))).toEqual({ repos: [] })
  expect(existsSync(join(workspace(), 'a'))).toBe(false)
  expect(h.started[0]!.cwd).toBe(workspace())
  const request = h.started[0]!.request
  for (const text of ['READ-ONLY', join(parent, 'a'), join(parent, 'b'), `${workspace()}/<name>`, 'none yet', '`repo: <name>`']) expect(request).toContain(text)
})

test('a run blocked only to ask for a repo gets that repo copy and reruns first, with nothing posted', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  const other = await h.engine.add({ ...multi, externalId: '8', repo: '/repo' })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: a'])))
  expect(git(join(workspace(), 'a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('queue-task-7-7-a8c0')
  expect(existsSync(join(workspace(), 'b'))).toBe(false)
  expect(h.started.map(start => start.cwd)).toEqual([workspace(), workspace()])
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', repos: ['a'], repoReruns: 1, questions: [] })
  expect(h.store.get(other.id)!.state).toBe('queued')
  expect(h.posted).toEqual([])
  expect(h.started[1]!.request).toContain(`Copies ready now: ${join(workspace(), 'a')}.`)
})

test('a run that asks for a repo and asks questions gets the repo and parks for the questions', async () => {
  await repos('a', 'b')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: b', 'Which page?'])))
  expect(h.posted).toEqual([{ id: '7', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.get(item.id)).toMatchObject({ state: 'waiting-info', repos: ['b'], questions: ['Which page?'] })
  expect(existsSync(join(workspace(), 'b', 'README.md'))).toBe(true)
  expect(h.started).toHaveLength(1)
})

test('a run that asks for a name that is not a repo in the folder fails the item', async () => {
  await repos('a')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  for (const [run, name] of [['run-1', 'zzz'], ['run-2', '../a']] as const) {
    if (run === 'run-2') await h.engine.requeue(item.id)
    await h.engine.onRunSettled(h.settle(run, blocked([`repo: ${name}`])))
    expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: `The plan asked for ${name}, which is not a repo in ${parent}` })
  }
  expect(h.posted).toEqual([])
})

test('a run that asks again only for repos it already has fails instead of looping', async () => {
  await repos('a')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: a'])))
  await h.engine.onRunSettled(h.settle('run-2', blocked(['repo: a'])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'The plan asked again for a, which it already has; stopped so it does not loop' })
  expect(h.started).toHaveLength(2)
})

test('after 3 repo-only reruns the next repo request fails the item', async () => {
  await repos('a', 'b', 'c', 'd')
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: [] })
  for (const [index, name] of ['a', 'b', 'c'].entries()) await h.engine.onRunSettled(h.settle(`run-${index + 1}`, blocked([`repo: ${name}`])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'building', repos: ['a', 'b', 'c'], repoReruns: 3 })
  await h.engine.onRunSettled(h.settle('run-4', blocked(['repo: d'])))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'The plan asked for repos 3 times already; tick the repos yourself and requeue' })
  expect(h.started).toHaveLength(4)
})

test('a run that would take the item past 8 repos fails it', async () => {
  const names = Array.from({ length: 9 }, (_, index) => `r${index}`)
  await repos(...names)
  const h = harness()
  const item = await h.engine.add({ ...multi, repo: parent, repos: ['r0'] })
  await h.engine.onRunSettled(h.settle('run-1', blocked(names.slice(1).map(name => `repo: ${name}`))))
  expect(h.store.get(item.id)).toMatchObject({ state: 'failed', error: 'The plan asked for more than 8 repos' })
})

test('a single-repo item never asks the source about repo lines', async () => {
  const h = queueHarness(scratch)
  const item = await h.engine.add({ ...multi, repo: '/repo' })
  await h.engine.onRunSettled(h.settle('run-1', blocked(['repo: a', 'Which page?'])))
  expect(h.posted).toEqual([{ id: '7', kind: 'ask', lines: ['Which page?'] }])
  expect(h.store.get(item.id)).toMatchObject({ state: 'waiting-info', questions: ['Which page?'] })
  expect('repos' in h.store.get(item.id)!).toBe(false)
})

test('questionsOf leaves out repo requests', () => {
  const run: RunView = { id: 'r', status: 'blocked', error: null, attempts: [blockedWith(['repo: api', '  repo:web ', 'Which page?', 'Is the repo: label right?'])] }
  expect(questionsOf(run)).toEqual(['Which page?', 'Is the repo: label right?'])
})

test('a ticked multi-repo item builds its repos up front as before', async () => {
  await repos('a', 'b')
  const h = harness()
  await h.engine.add({ ...multi, repo: parent, repos: ['a'] })
  expect(existsSync(join(workspace(), 'a', 'README.md'))).toBe(true)
  expect(existsSync(join(workspace(), 'b'))).toBe(false)
  expect(h.started[0]!.request).toContain(`${workspace()}/a`)
})

test('the request for a single-repo item has no repo instructions', () => {
  const request = runRequest({ title: 'T', url: 'u', contextPath: '/c.md', answerPaths: [], repo: '/repo', worktree: '/repo/.worktree/q' })
  expect(request).not.toContain('repo: <name>')
  expect(request).not.toContain('READ-ONLY')
})
