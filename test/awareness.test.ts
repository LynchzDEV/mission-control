import { expect, test } from 'bun:test'
import { activeAgents, scopedWork, selectFlow, awarenessFlows, flowSteps, flowColumns } from '../client/awareness'
import { buildWork, type WorkJob } from '../client/work'
const job = {id:'old',threadRoot:'old',label:'shared',engine:'codex',cwd:'/repo',status:'done',startedAt:1,endedAt:2} as WorkJob
test('actual flow job ownership prevents same-label historical activity duplication', () => {
  const items = buildWork([job,{...job,id:'new',threadRoot:'new',status:'running',startedAt:3}], {shared:{activityJobId:'new',currentActivity:'Reading new file',plan:{steps:[{title:'Read',assignee:'codex',status:'active'}]}}})
  expect(items.find(item => item.id === 'old')!.plan).not.toBeNull()
  expect(items.find(item => item.id === 'old')!.activity).not.toContain('Reading new file')
  expect(items.find(item => item.id === 'new')!.activity).toBe('Reading new file')
  expect(selectFlow(items,'')).toBe('new'); expect(selectFlow(items,'old')).toBe('old')
})
test('scope uses terminal ownership before directory fallback and retains plan-only work when unscoped', () => {
  const items = buildWork([{...job,terminalId:'a'} as WorkJob,{...job,id:'child',threadRoot:'child',cwd:'/repo/sub'}],{manual:{plan:{steps:[]}}})
  expect(scopedWork(items,'b','/repo').map(item => item.id)).toEqual(['child'])
  expect(scopedWork(items,'a','/other').map(item => item.id)).toEqual(['old'])
  expect(scopedWork(items,null,null)).toHaveLength(3)
  expect(selectFlow([], 'gone')).toBe('')
})

test('automatic flow identity groups conversations and retains archived snapshots and manual precedence', () => {
  const stages = {spec:['done','SPEC DETAIL'],impl:['error','IMPL DETAIL'],codex:['queued','CODEX DETAIL'],verify:['active','VERIFY DETAIL'],merged:['future','MERGED DETAIL']}
  const items = buildWork([job,{...job,id:'new',threadRoot:'new',status:'running'}], {shared:{...stages,activityJobId:'new',currentActivity:'Only new'}})
  expect(items.map(item => item.flowLabel)).toEqual(['shared','shared'])
  expect(items.every(item => JSON.stringify(item.stages) === JSON.stringify(stages))).toBe(true)
  expect(awarenessFlows(items)).toHaveLength(1)
  expect(awarenessFlows(items)[0]!.label).toBe('shared')
  expect(awarenessFlows(items)[0]!.members).toHaveLength(2)
  expect(flowSteps(awarenessFlows(items)[0]!).map(step => step.title)).toEqual(['Direction','Codex work','Codex work','Your review'])
  const planned = buildWork([job], {shared:{...stages,plan:{steps:[{title:'Custom',assignee:'user',status:'active'}],next:'Ship'}}})
  expect(flowSteps(planned[0]!).map(step => step.title)).toEqual(['Custom'])
  expect(planned[0]!.plan!.next).toBe('Ship')
  const archived = buildWork([job,{...job,id:'new',threadRoot:'new'}], {shared:{...stages,activityJobId:'new',archived:true}})
  expect(archived.every(item => item.archived)).toBe(true)
  expect(awarenessFlows(archived)).toEqual([])
})

test('active agents filter ownership before deduplicating threads, excluding history and archived flows', () => {
  const jobs = [
    {...job,id:'a',threadRoot:'thread',terminalId:'a',status:'done'},
    {...job,id:'reply',threadRoot:'thread',terminalId:'a',status:'running'},
    {...job,id:'b',threadRoot:'b',terminalId:'b',status:'running'},
    {...job,id:'legacy',threadRoot:'legacy',status:'running',cwd:'/repo/sub'},
    {...job,id:'archived',threadRoot:'archived',label:'archived',status:'running'},
    {...job,id:'failed',threadRoot:'failed',status:'failed'},
    {...job,id:'queued',threadRoot:'queued',status:'queued'},
  ] as WorkJob[]
  const flows = {archived:{archived:true}}
  expect(activeAgents(jobs,flows,'a','/repo').map(item => item.id).sort()).toEqual(['legacy','queued','thread'])
  expect(activeAgents(jobs,flows,'b','/repo').map(item => item.id).sort()).toEqual(['b','legacy','queued'])
  expect(activeAgents(jobs,flows,null,'/repo')).toEqual([])
  expect(activeAgents([],{},'a','/repo')).toEqual([])
})

test('manual branches retain their placement when activity changes', () => {
  const titles = ['Direction','Components','Visual check','Your review']
  const plan = (states:string[]) => buildWork([], {manual:{plan:{steps:states.map((status,index) => ({title:titles[index] ?? `Step ${index}`,assignee:'codex',status}))}}})[0]!
  const branched = flowColumns(plan(['done','active','active','pending']))
  expect(branched.map(column => column.map(step => step.title))).toEqual([['Direction'],['Components','Visual check'],['Your review']])
  expect(branched[1]![0]!.detail).toBe('Working')
  for (const states of [['pending','pending','pending','pending'],['done','active','pending','pending'],['done','done','done','done'],['active','pending','active','done']]) {
    const columns = flowColumns(plan(states))
    expect(columns.map(column => column.length)).toEqual([1,2,1])
    expect(columns.flat().map(step => step.status)).toEqual(states)
  }
  expect(flowColumns(plan(Array(32).fill('pending'))).map(column => column.length)).toEqual([1,30,1])
  expect(flowColumns(plan([]))).toEqual([])
  expect(flowColumns(undefined)).toEqual([])
})
test('automatic work uses actual threads and a separately acknowledged human review', () => {
  const stages = {spec:['done','Spec detail'],impl:['active','Implementation detail'],codex:['active','Review detail'],verify:['queued','Verification detail'],merged:['future','Merge detail']}
  const jobs = [{...job,prompt:'Build components',label:'Components',diffStat:'one file',reviewedAt:null}, {...job,id:'review',threadRoot:'review',label:'Visual check',status:'running',startedAt:3}]
  const item = awarenessFlows(buildWork(jobs, {Components:{...stages,activityJobId:'old'}})).find(item => item.label === 'Components')!
  const columns = flowColumns(item)
  expect(columns.map(column => column.length)).toEqual([1,1,1])
  expect(columns.flat().map(step => step.title)).toEqual(['Direction','Codex work','Your review'])
  expect(columns[0]![0]!.status).toBe('done')
  expect(columns.at(-1)![0]!.detail).toBe('Ready for you')
  expect(columns.at(-1)![0]!.status).toBe('pending')
  item.members![0]!.reviewedAt = 12
  expect(flowColumns(item).at(-1)![0]!.detail).toBe('Reviewed')
})
test('scope removes a foreign reply before assembling flow branches', () => {
  const item = buildWork([{...job,terminalId:'a'},{...job,id:'foreign',terminalId:'b',status:'running'}] as WorkJob[],{})
  expect(scopedWork(item,'a','/repo')[0]!.members!.map(job => job.id)).toEqual(['old'])
})
