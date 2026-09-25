import { expect, test } from 'bun:test'
import { defaultWorkflow, validateWorkflow } from '../server/workflows'
import { agentLabel, insertWorkflowStep, removeWorkflowStep, taskPreset, workflowTemplates } from '../client/studio-graph'

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
