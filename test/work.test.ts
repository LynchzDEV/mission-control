import { expect, test } from 'bun:test'
import { buildWork, reviewable, type WorkJob } from '../client/work'
const job: WorkJob = { id:'j1', threadRoot:'j1', label:'Export orders', engine:'codex', cwd:'/work/orders', status:'done', startedAt:10, endedAt:20, diffStat:'1 file changed', worktree:'/work/tree', reviewedAt:null }
test('groups replies and links plans by actual activity job', () => {
  const items = buildWork([job,{ ...job,id:'reply',startedAt:30 }], { unrelated: { activityJobId:'j1', plan:{steps:[{title:'Verify',assignee:'user',status:'active'}]} } })
  expect(items).toHaveLength(1)
  expect(items[0]!.flowLabel).toBe('unrelated')
  expect(items[0]!.job!.id).toBe('reply')
})
test('plan-only flows become work items without a job and keep their archived flag', () => {
  const items = buildWork([job], { archive: { archived:true,finished:true,plan:{steps:[{title:'Ship',assignee:'user',status:'done'}]} }, pending:{ plan:{steps:[{title:'Build',assignee:'glm',status:'pending'}]} } })
  const archived = items.find(item => item.label === 'archive')!
  expect(archived).toMatchObject({ id:'plan:archive', state:'done', archived:true })
  expect(archived.job).toBeUndefined()
  expect(items.find(item => item.label === 'pending')).toMatchObject({ state:'plan', archived:false })
})
test('reviewable means finished with changes and not yet reviewed', () => {
  expect(reviewable(job)).toBe(true)
  expect(reviewable({ ...job, diffStat:'' })).toBe(true)
  expect(reviewable({ ...job, reviewedAt:30 })).toBe(false)
  expect(reviewable({ ...job, diffStat:'', worktree:null })).toBe(false)
  expect(reviewable({ ...job, status:'running' })).toBe(false)
  expect(reviewable(undefined)).toBe(false)
})
