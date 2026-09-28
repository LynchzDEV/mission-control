import { expect, test } from 'bun:test'
import { buildWork, reviewable, type WorkJob } from '../client/work'
const job: WorkJob = { id:'j1', threadRoot:'j1', label:'Export orders', engine:'codex', cwd:'/work/orders', status:'done', startedAt:10, endedAt:20, diffStat:'1 file changed', worktree:'/work/tree', reviewedAt:null }
test('groups replies into one item per thread, led by the newest job', () => {
  const items = buildWork([job,{ ...job,id:'reply',startedAt:30 }])
  expect(items).toHaveLength(1)
  expect(items[0]!).toMatchObject({ id:'j1', label:'Export orders', provider:'codex' })
  expect(items[0]!.job!.id).toBe('reply')
  expect(items[0]!.members!.map(member => member.id)).toEqual(['j1','reply'])
})
test('no jobs means no work items', () => {
  expect(buildWork([])).toEqual([])
})
test('reviewable means finished with changes and not yet reviewed', () => {
  expect(reviewable(job)).toBe(true)
  expect(reviewable({ ...job, diffStat:'' })).toBe(true)
  expect(reviewable({ ...job, reviewedAt:30 })).toBe(false)
  expect(reviewable({ ...job, diffStat:'', worktree:null })).toBe(false)
  expect(reviewable({ ...job, status:'running' })).toBe(false)
  expect(reviewable(undefined)).toBe(false)
})
