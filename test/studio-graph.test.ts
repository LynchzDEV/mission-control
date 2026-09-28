import { expect, test } from 'bun:test'
import { defaultWorkflow, validateWorkflow } from '../server/workflows'
import { agentLabel, insertWorkflowStep, kindIcon, nodeRunStates, roleWord, removeWorkflowStep, taskPreset, workflowTemplates } from '../client/studio-graph'

test('adding a custom step keeps the following review connected and preserves failure routes',()=>{
  const graph=defaultWorkflow()
  graph.edges.push({source:'execute',target:'verify-plan',outcome:'fail'})
  const step=taskPreset('custom')
  const next=insertWorkflowStep(graph,step,'execute')
  expect(next.edges).toContainEqual({source:'execute',target:step.id,outcome:'pass'})
  expect(next.edges).toContainEqual({source:step.id,target:'review',outcome:'pass'})
  expect(next.edges).toContainEqual({source:'execute',target:'verify-plan',outcome:'fail'})
  expect(validateWorkflow(next)).toEqual([])
  expect(graph.nodes).toHaveLength(4)
})

test('removing a custom step reconnects the existing flow without removing its review',()=>{
  const graph=defaultWorkflow(),step=taskPreset('custom')
  expect(removeWorkflowStep(insertWorkflowStep(graph,step,'execute'),step.id)).toEqual(graph)
})

test('all built-in starting templates satisfy core graph rules and blank graphs get an entry',()=>{
  for(const template of workflowTemplates(defaultWorkflow()))expect(validateWorkflow(template)).toEqual([])
  const step=taskPreset('research')
  const graph=insertWorkflowStep({id:'empty',name:'New workflow',entry:'',nodes:[],edges:[]},step)
  expect(graph.entry).toBe(step.id)
  expect(validateWorkflow(graph)).toEqual([])
})

test('agentLabel reads Chat decides, the provider name, or Unavailable for a removed connection',()=>{
  const providers=[{id:'claude',name:'Claude',models:[]},{id:'qwen',name:'Qwen Code',models:[]}]
  expect(agentLabel({agent:{role:'execute'}},providers)).toBe('Chat decides')
  expect(agentLabel({agent:{role:'execute',engine:'qwen'}},providers)).toBe('Qwen Code')
  expect(agentLabel({agent:{role:'execute',engine:'grok'}},providers)).toBe('Unavailable · grok')
})

test('kindIcon names the symbol drawn on each step kind',()=>{
  expect(kindIcon('plan')).toBe('plan-icon')
  expect(kindIcon('verify-plan')).toBe('check-circle-icon')
  expect(kindIcon('implement')).toBe('code-icon')
  expect(kindIcon('review')).toBe('eye-icon')
  expect(kindIcon('task')).toBe('spark-icon')
})

test('roleWord capitalises the role shown on the AI tag',()=>{
  expect(roleWord('plan')).toBe('Plan')
  expect(roleWord('execute')).toBe('Execute')
  expect(roleWord('review')).toBe('Review')
})

const settled=(nodeId:string,outcome:string,startedAt:number)=>({nodeId,status:'settled',result:{outcome},startedAt})

test('nodeRunStates is empty when no run is running',()=>{
  expect(nodeRunStates(null)).toEqual({})
})

test('nodeRunStates marks settled passes and the current step as running',()=>{
  const run={status:'running',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('plan','pass',1),settled('verify-plan','pass',2),{nodeId:'execute',status:'running',result:null,startedAt:3}]}
  expect(nodeRunStates(run)).toEqual({plan:'passed','verify-plan':'passed',execute:'running'})
})

test('nodeRunStates keeps the highlights of a paused run',()=>{
  const run={status:'paused',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('plan','pass',1),{nodeId:'execute',status:'running',result:null,startedAt:2}]}
  expect(nodeRunStates(run)).toEqual({plan:'passed',execute:'running'})
})

test('nodeRunStates marks a settled fail or blocked step as failed',()=>{
  expect(nodeRunStates({status:'running',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('review','fail',1)]}).review).toBe('failed')
  expect(nodeRunStates({status:'running',currentNodeId:'execute',tokens:[{nodeId:'execute',state:'working'}],attempts:[settled('review','blocked',1)]}).review).toBe('failed')
})

test('nodeRunStates uses the newest settled attempt of a step',()=>{
  const run={status:'running',currentNodeId:'review',tokens:[{nodeId:'review',state:'working'}],attempts:[settled('execute','fail',1),settled('execute','pass',2)]}
  expect(nodeRunStates(run).execute).toBe('passed')
})

test('nodeRunStates marks every step that holds a working token as running',()=>{
  const run={status:'running',currentNodeId:'a',tokens:[{nodeId:'a',state:'working'},{nodeId:'b',state:'working'},{nodeId:'join',state:'waiting'}],attempts:[settled('split','pass',1),{nodeId:'a',status:'running',result:null,startedAt:2},{nodeId:'b',status:'running',result:null,startedAt:2}]}
  expect(nodeRunStates(run)).toEqual({split:'passed',a:'running',b:'running'})
})

test('nodeRunStates does not mark a step whose token is only ready as running',()=>{
  expect(nodeRunStates({status:'paused',currentNodeId:'review',tokens:[{nodeId:'review',state:'ready'}],attempts:[settled('execute','pass',1)]})).toEqual({execute:'passed'})
})
