import { expect, test } from 'bun:test'
import { activeAgents, scopedWork } from '../client/awareness'
import { buildWork, type WorkJob } from '../client/work'
const job = {id:'old',threadRoot:'old',label:'shared',engine:'codex',cwd:'/repo',status:'done',startedAt:1,endedAt:2} as WorkJob
test('scope keeps only the jobs the terminal started and keeps everything when unscoped', () => {
  const items = buildWork([{...job,terminalId:'a'} as WorkJob,{...job,id:'child',threadRoot:'child',terminalId:'b',cwd:'/repo/sub'} as WorkJob])
  expect(scopedWork(items,{id:'b'}).map(item => item.id)).toEqual(['child'])
  expect(scopedWork(items,{id:'a'}).map(item => item.id)).toEqual(['old'])
  expect(scopedWork(items,null)).toHaveLength(2)
})

test('active agents filter ownership before deduplicating threads, excluding history', () => {
  const jobs = [
    {...job,id:'a',threadRoot:'thread',terminalId:'a',status:'done'},
    {...job,id:'reply',threadRoot:'thread',terminalId:'a',status:'running'},
    {...job,id:'b',threadRoot:'b',terminalId:'b',status:'running'},
    {...job,id:'queued',threadRoot:'queued',terminalId:'b',status:'queued'},
    {...job,id:'failed',threadRoot:'failed',terminalId:'a',status:'failed'},
  ] as WorkJob[]
  expect(activeAgents(jobs,{id:'a'}).map(item => item.id)).toEqual(['thread'])
  expect(activeAgents(jobs,{id:'b'}).map(item => item.id).sort()).toEqual(['b','queued'])
  expect(activeAgents(jobs,null)).toEqual([])
  expect(activeAgents([],{id:'a'})).toEqual([])
})

test('scope removes a foreign reply before assembling the thread', () => {
  const item = buildWork([{...job,terminalId:'a'},{...job,id:'foreign',terminalId:'b',status:'running'}] as WorkJob[])
  expect(scopedWork(item,{id:'a'})[0]!.members!.map(job => job.id)).toEqual(['old'])
})

test('jobs from chats or other sessions never show in a terminal, even inside its folder', () => {
  const jobs = [
    {...job,id:'chat',threadRoot:'chat',purpose:'chat',status:'running',cwd:'/repo'},
    {...job,id:'helper',threadRoot:'helper',chatId:'chat',status:'running',cwd:'/repo/sub'},
    {...job,id:'elsewhere',threadRoot:'elsewhere',status:'running',cwd:'/repo/sub'},
    {...job,id:'mine',threadRoot:'mine',terminalId:'a',status:'running'},
  ] as WorkJob[]
  expect(activeAgents(jobs,{id:'a'}).map(item => item.id)).toEqual(['mine'])
  expect(scopedWork(buildWork(jobs),{id:'a'}).map(item => item.id)).toEqual(['mine'])
})

test('a resumed terminal keeps the agents its earlier terminal started', () => {
  const jobs = [
    {...job,id:'before',threadRoot:'before',terminalId:'old',terminalSessionId:'conv',status:'running'},
    {...job,id:'other',threadRoot:'other',terminalId:'x',terminalSessionId:'other-conv',status:'running'},
  ] as WorkJob[]
  expect(activeAgents(jobs,{id:'new',sessionId:'conv'}).map(item => item.id)).toEqual(['before'])
  expect(activeAgents(jobs,{id:'new',sessionId:null}).map(item => item.id)).toEqual([])
})
