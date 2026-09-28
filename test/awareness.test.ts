import { expect, test } from 'bun:test'
import { activeAgents, scopedWork } from '../client/awareness'
import { buildWork, type WorkJob } from '../client/work'
const job = {id:'old',threadRoot:'old',label:'shared',engine:'codex',cwd:'/repo',status:'done',startedAt:1,endedAt:2} as WorkJob
test('scope uses terminal ownership before directory fallback and keeps everything when unscoped', () => {
  const items = buildWork([{...job,terminalId:'a'} as WorkJob,{...job,id:'child',threadRoot:'child',cwd:'/repo/sub'}])
  expect(scopedWork(items,'b','/repo').map(item => item.id)).toEqual(['child'])
  expect(scopedWork(items,'a','/other').map(item => item.id)).toEqual(['old'])
  expect(scopedWork(items,null,null)).toHaveLength(2)
})

test('active agents filter ownership before deduplicating threads, excluding history', () => {
  const jobs = [
    {...job,id:'a',threadRoot:'thread',terminalId:'a',status:'done'},
    {...job,id:'reply',threadRoot:'thread',terminalId:'a',status:'running'},
    {...job,id:'b',threadRoot:'b',terminalId:'b',status:'running'},
    {...job,id:'legacy',threadRoot:'legacy',status:'running',cwd:'/repo/sub'},
    {...job,id:'failed',threadRoot:'failed',status:'failed'},
    {...job,id:'queued',threadRoot:'queued',status:'queued'},
  ] as WorkJob[]
  expect(activeAgents(jobs,'a','/repo').map(item => item.id).sort()).toEqual(['legacy','queued','thread'])
  expect(activeAgents(jobs,'b','/repo').map(item => item.id).sort()).toEqual(['b','legacy','queued'])
  expect(activeAgents(jobs,null,'/repo')).toEqual([])
  expect(activeAgents([],'a','/repo')).toEqual([])
})

test('scope removes a foreign reply before assembling the thread', () => {
  const item = buildWork([{...job,terminalId:'a'},{...job,id:'foreign',terminalId:'b',status:'running'}] as WorkJob[])
  expect(scopedWork(item,'a','/repo')[0]!.members!.map(job => job.id)).toEqual(['old'])
})
