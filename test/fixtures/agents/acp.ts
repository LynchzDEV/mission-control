import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { defaultWorkflow } from '../../../server/workflows'
const lines = createInterface({ input: process.stdin })
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
let pendingPromptId: unknown = null
let terminalId = ''
const finish = (id: unknown, text: string) => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
  send({ jsonrpc: '2.0', id, result: { stopReason: process.env.FIXTURE_STOP || 'end_turn' } })
}
for await (const line of lines) {
  const message = JSON.parse(line)
  if (process.env.FIXTURE_LOG && message.method) appendFileSync(process.env.FIXTURE_LOG, `${message.method}\n`)
  if (message.id === 'term-create') { terminalId = message.result?.terminalId ?? ''; send({ jsonrpc: '2.0', id: 'term-wait', method: 'terminal/wait_for_exit', params: { sessionId: 'fixture-session', terminalId } }) }
  else if (message.id === 'term-wait') send({ jsonrpc: '2.0', id: 'term-output', method: 'terminal/output', params: { sessionId: 'fixture-session', terminalId } })
  else if (message.id === 'term-output') finish(pendingPromptId, `Terminal said ${JSON.stringify(message.result?.output ?? message.error?.message ?? '')}`)
  else if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, ...(process.env.FIXTURE_CLOSE === '1' ? { sessionCapabilities: { close: {} } } : {}) }, authMethods: [] } })
  else if (message.method === 'session/close') send({ jsonrpc: '2.0', id: message.id, result: {} })
  else if (message.method === 'session/new' || message.method === 'session/load') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture-session', configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fixture-model', options: [{ value: 'fixture-model', name: 'Fixture' }] }] } })
  else if (message.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: message.id, result: { configOptions: [] } })
  else if (message.method === 'session/prompt') {
    if (process.env.FIXTURE_PERMISSION === '1') {
      send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { toolCallId: 'tool', title: 'Edit file', status: 'pending' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } })
    }
    if (process.env.FIXTURE_TERMINAL) {
      pendingPromptId = message.id
      send({ jsonrpc: '2.0', id: 'term-create', method: 'terminal/create', params: { sessionId: 'fixture-session', command: process.env.FIXTURE_TERMINAL } })
      continue
    }
    const prompt = message.params.prompt.map((part: {text?:string}) => part.text ?? '').join('\n')
    let text = 'SKD_RESULT {"outcome":"pass","summary":"Fixture ran","evidence":["fixture assertion"]}'
    if (prompt.startsWith('You are the Shikidan workflow designer.')) {
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
