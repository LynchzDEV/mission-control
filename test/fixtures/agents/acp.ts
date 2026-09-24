import { createInterface } from 'node:readline'
import { defaultWorkflow } from '../../../server/workflows'
const lines = createInterface({ input: process.stdin })
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
  else if (message.method === 'session/new' || message.method === 'session/load') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture-session', configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fixture-model', options: [{ value: 'fixture-model', name: 'Fixture' }] }] } })
  else if (message.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: message.id, result: { configOptions: [] } })
  else if (message.method === 'session/prompt') {
    if (process.env.FIXTURE_PERMISSION === '1') {
      send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { toolCallId: 'tool', title: 'Edit file', status: 'pending' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } })
    }
    const prompt = message.params.prompt.map((part: {text?:string}) => part.text ?? '').join('\n')
    let text = 'MC_RESULT {"outcome":"pass","summary":"Fixture ran","evidence":["fixture assertion"]}'
    if (prompt.startsWith('You are the Mission Control workflow designer.')) {
      const raw = /Current workflow: ([^\n]+)/.exec(prompt)?.[1]
      const current = raw ? JSON.parse(raw) : null
      const workflow = current ?? {...defaultWorkflow(),id:'draft',name:'AI browser workflow'}
      if (current) {
        const node = {...workflow.nodes[0],id:'fixture-tests',kind:'task',title:'Run tests',instructions:'Run the fixture tests',agent:{role:'execute'},position:{x:560,y:340}}
        const edge = workflow.edges.find((item: {source:string;outcome:string}) => item.source==='execute'&&item.outcome==='pass')
        workflow.nodes.push(node)
        if (edge) {const target=edge.target;edge.target=node.id;workflow.edges.push({source:node.id,target,outcome:'pass'})}
      }
      text = JSON.stringify({workflow,summary:current?'Added a testing step':'Created your workflow',setup:[]})
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: process.env.FIXTURE_STOP || 'end_turn' } })
  }
}
