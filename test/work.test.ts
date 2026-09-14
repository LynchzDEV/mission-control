import { expect, test } from 'bun:test'
import { buildWork, filterWork, chooseWork, readDraft, reworkSummary, reworkText, type WorkJob } from '../client/work'
const job: WorkJob = { id:'j1', threadRoot:'j1', label:'Export orders', engine:'codex', cwd:'/work/orders', status:'done', startedAt:10, endedAt:20, diffStat:'1 file changed', worktree:'/work/tree', reviewedAt:null }
test('groups replies and links plans by actual activity job', () => {
  const items = buildWork([job,{ ...job,id:'reply',startedAt:30 }], { unrelated: { activityJobId:'j1', plan:{steps:[{title:'Verify',assignee:'user',status:'active'}]} } })
  expect(items).toHaveLength(1)
  expect(items[0]!.flowLabel).toBe('unrelated')
  expect(items[0]!.job!.id).toBe('reply')
})
test('filters review eligibility, archived plan-only work and search', () => {
  const items = buildWork([job], { archive: { archived:true,finished:true,plan:{steps:[{title:'Ship',assignee:'user',status:'done'}]} }, pending:{ plan:{steps:[{title:'Build',assignee:'glm',status:'pending'}]} } })
  expect(filterWork(items,'review','orders')).toHaveLength(1)
  expect(filterWork(items,'review','missing')).toEqual([])
  expect(filterWork(items,'archived','')[0]!.job).toBeUndefined()
  expect(filterWork(items,'active','')[0]!.label).toBe('pending')
  expect(filterWork(buildWork([{...job,reviewedAt:30}],{}),'review','')).toHaveLength(1)
  expect(filterWork(buildWork([{...job,reviewedAt:30,worktree:null}],{}),'review','')).toEqual([])
})
test('selection remains stable and empty filters have no phantom work', () => {
  const items = buildWork([job],{})
  expect(chooseWork(items,'j1')).toBe('j1')
  expect(chooseWork(items,'missing')).toBe('j1')
  expect(chooseWork([],'j1')).toBe('')
})
test('draft restoration tolerates corrupt storage and preserves unchecked worktrees', () => {
  expect(readDraft('{')).toEqual({})
  expect(readDraft(JSON.stringify({prompt:'Keep this',worktree:false,secret:'discard',cwd:'/repo'}))).toEqual({prompt:'Keep this',worktree:false,cwd:'/repo'})
})

test('rework summary counts root jobs, reply fixes, reviews and turns per label', () => {
  const impl = { ...job, id:'impl', label:'ticket', turns:50 }
  const fix = { ...job, id:'fix', threadRoot:'impl', label:'ticket', parentJobId:'impl', turns:20 }
  const review = { ...job, id:'rev', threadRoot:'rev', label:'ticket', engine:'codex', reviewOf:'impl', turns:5 }
  const other = { ...job, id:'x', label:'other', turns:9 }
  expect(reworkSummary([impl, fix, review, other], 'ticket')).toEqual({ jobs:1, fixes:1, reviews:1, turns:75 })
  expect(reworkSummary([impl], 'ticket')).toEqual({ jobs:1, fixes:0, reviews:0, turns:50 })
  expect(reworkText({ jobs:1, fixes:0, reviews:0, turns:50 })).toBe('1 job · 50 turns')
  expect(reworkText({ jobs:3, fixes:2, reviews:1, turns:385 })).toBe('3 jobs · 2 fixes · 1 review · 385 turns')
  expect(buildWork([impl, fix, review], {})[0]!.rework).toEqual({ jobs:1, fixes:1, reviews:1, turns:75 })
})
