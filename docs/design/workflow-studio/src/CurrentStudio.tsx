import { useCallback, useEffect, useState, memo } from 'react'
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, useNodesState, useEdgesState, type Node, type NodeProps, type Edge, type Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Workflow, WorkflowNode, WorkflowRevision, PolicyRevision, Outcome } from '../../../../server/workflows'
import type { AgentConnection } from '../../../../server/agent-connections'
import type { WorkflowRun } from '../../../../server/workflow-runner'

import { fixtureApi as api } from './fixtures'

type TaskNode = Node<WorkflowNode & { selected?: boolean }, 'task'>
type ConnectionList = { builtins: string[]; connections: AgentConnection[]; presets: Array<Partial<AgentConnection>>; models: Record<string, string[]> }
type RunSummary = Pick<WorkflowRun, 'id' | 'label' | 'status' | 'error' | 'currentNodeId' | 'createdAt'> & { workflowName: string; revision: string }
const outcomes: Outcome[] = ['pass', 'fail', 'blocked']
const kindLabels: Record<WorkflowNode['kind'], string> = { task: 'AI task', plan: 'Plan', 'verify-plan': 'Verify plan', implement: 'Implementation', review: 'Review' }
const TaskCard = memo(function TaskCard({ data, selected }: NodeProps<TaskNode>) {
  return <div className={`studio-task ${selected ? 'is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} aria-label={`Connect to ${data.title}`} />
    <span className="studio-task-kind">{kindLabels[data.kind]}</span>
    <strong>{data.title}</strong><span className="studio-task-agent">{data.agent.engine ?? `${data.agent.role} default`}{data.agent.model ? ` / ${data.agent.model}` : ''}</span>
    <div className="studio-task-outcomes">{outcomes.map(outcome => <span key={outcome} data-outcome={outcome}>{outcome}<Handle type="source" id={outcome} position={Position.Right} style={{ top: `${outcomes.indexOf(outcome) * 25 + 48}%` }} aria-label={`${data.title} ${outcome}`} /></span>)}</div>
  </div>
})
const nodeTypes = { task: TaskCard }
function graphNodes(graph: Workflow): TaskNode[] { return graph.nodes.map(node => ({ id: node.id, type: 'task', data: node, position: node.position })) }
function graphEdges(graph: Workflow): Edge[] { return graph.edges.map(edge => ({ id: `${edge.source}-${edge.outcome}`, source: edge.source, target: edge.target, sourceHandle: edge.outcome, label: edge.outcome, markerEnd: { type: MarkerType.ArrowClosed }, className: `outcome-${edge.outcome}` })) }

function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange: (value: never) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2))
  const [error, setError] = useState('')
  useEffect(() => { setText(JSON.stringify(value, null, 2)); setError('') }, [JSON.stringify(value)])
  return <label>{label}<textarea className="studio-code" rows={5} value={text} aria-invalid={!!error} onChange={event => { setText(event.target.value); try { const parsed = JSON.parse(event.target.value); if (!Array.isArray(parsed)) throw new Error('Enter an array'); onChange(parsed as never); setError('') } catch { setError('Enter a valid JSON array before saving') } }} />{error && <small role="alert">{error}</small>}</label>
}

function Connections({ list, refresh, report }: { list: ConnectionList; refresh: () => Promise<void>; report: (text: string) => void }) {
  const [editing, setEditing] = useState<Partial<AgentConnection>>({ ...list.presets[0] })
  const [args, setArgs] = useState(JSON.stringify(editing.args ?? []))
  const [env, setEnv] = useState('')
  const [terminalArgs, setTerminalArgs] = useState('')
  const [probe, setProbe] = useState('')
  const [busy, setBusy] = useState(false)
  const select = (value: Partial<AgentConnection>) => { setEditing({ ...value }); setArgs(JSON.stringify(value.args ?? [])); setEnv(Object.entries(value.env ?? {}).map(([key, reference]) => `${key}=${reference}`).join('\n')); setTerminalArgs(value.terminalArgs ? JSON.stringify(value.terminalArgs) : ''); setProbe('') }
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      const references = Object.fromEntries(env.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const [key, reference, extra] = line.split('='); if (!key || !reference || extra) throw new Error('Use TARGET_ENV=SOURCE_ENV, one per line'); return [key.trim(), reference.trim()] }))
      const saved = await api<AgentConnection>('/connections', { ...editing, args: JSON.parse(args), env: references, terminalArgs: terminalArgs ? JSON.parse(terminalArgs) : undefined })
      select(saved); await refresh(); report('Connection saved. Sign in with the agent CLI before running it.')
    } catch (error) { report((error as Error).message) } finally { setBusy(false) }
  }
  return <div className="studio-connections"><aside className="studio-library"><h2>Agent connections</h2><p>Native subscriptions, API providers, and local models.</p><h3>Built in</h3>{list.builtins.map(id => <div className="studio-list-row" key={id}>{id}<small>Native CLI</small></div>)}<h3>Configured</h3>{list.connections.map(connection => <button key={connection.id} className="studio-list-row" onClick={() => select(connection)}>{connection.name}<small>{connection.adapter}</small></button>)}<h3>Add a connection</h3>{list.presets.map(preset => <button key={preset.id} className="studio-list-row" onClick={() => select(preset)}>{preset.name}</button>)}</aside>
    <form className="studio-connection-form" onSubmit={save}><h2>{editing.name || 'New connection'}</h2><p>Install and sign in to the agent locally. Subscription eligibility depends on the provider. ACP agents advertise their capabilities when probed.</p>
      <div className="studio-fields"><label>Name<input required value={editing.name ?? ''} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label><label>Connection ID<input required value={editing.id ?? ''} onChange={event => setEditing({ ...editing, id: event.target.value })} /></label></div>
      <label>Adapter<select value={editing.adapter ?? 'acp'} onChange={event => setEditing({ ...editing, adapter: event.target.value as AgentConnection['adapter'] })}><option value="acp">ACP coding agent</option><option value="opencode">OpenCode · API / local models</option><option value="cli">Headless CLI</option></select></label>
      <label>Executable<input required value={editing.command ?? ''} placeholder="qwen" onChange={event => setEditing({ ...editing, command: event.target.value })} /></label>
      <label>Arguments · JSON array<input required value={args} onChange={event => setArgs(event.target.value)} /><small>CLI slots: {'{{prompt}}'}, {'{{model}}'}, {'{{session}}'}. Arguments are passed directly, without a shell.</small></label>
      <label>Available model IDs · one per line<textarea rows={3} value={(editing.models ?? []).join('\n')} onChange={event => setEditing({ ...editing, models: event.target.value.split('\n').filter(Boolean) })} /></label>
      <label>Model family<input value={editing.family ?? ''} placeholder="qwen, grok, llama…" onChange={event => setEditing({ ...editing, family: event.target.value || undefined })} /><small>Used for independent review when a model ID has no recognized family.</small></label>
      {editing.adapter === 'opencode' && <fieldset><legend>Custom OpenAI-compatible endpoint (optional)</legend><label>Base URL<input type="url" value={editing.baseUrl ?? ''} placeholder="http://localhost:11434/v1" onChange={event => setEditing({ ...editing, baseUrl: event.target.value || undefined })} /></label><label>Provider ID<input value={editing.provider ?? 'custom'} onChange={event => setEditing({ ...editing, provider: event.target.value })} /></label><label>API key environment variable<input value={editing.apiKeyEnv ?? ''} placeholder="OPENROUTER_API_KEY" onChange={event => setEditing({ ...editing, apiKeyEnv: event.target.value || undefined })} /></label><small>Leave the endpoint blank to use OpenCode's configured providers. Use provider/model IDs for those providers.</small></fieldset>}
      <label>Environment references<textarea rows={3} value={env} placeholder="API_KEY=MY_PROVIDER_KEY" onChange={event => setEnv(event.target.value)} /><small>Names of variables available to the MC server. Never enter credential values here.</small></label>
      <label>Authentication method (optional)<input value={editing.authMethod ?? ''} onChange={event => setEditing({ ...editing, authMethod: event.target.value || undefined })} /><small>Use a method ID from the capability probe, or leave blank to use the agent's existing sign-in.</small></label>
      {editing.adapter === 'cli' && <label>Output format<select value={editing.output ?? 'text'} onChange={event => setEditing({ ...editing, output: event.target.value as AgentConnection['output'] })}><option value="text">Plain text</option><option value="claude">Claude stream JSON</option><option value="codex">Codex JSON</option></select></label>}
      <label>Interactive terminal arguments · optional JSON array<input value={terminalArgs} onChange={event => setTerminalArgs(event.target.value)} placeholder="[]" /><small>Configure these to also open this agent in an MC terminal.</small></label>
      <label className="studio-check"><input type="checkbox" checked={editing.autoApprove === true} onChange={event => setEditing({ ...editing, autoApprove: event.target.checked })} />Allow unattended tool permissions for this trusted agent</label>
      <div className="studio-actions"><button disabled={busy} type="submit">Save connection</button><button disabled={busy || editing.adapter === 'cli' || !list.connections.some(connection => connection.id === editing.id)} type="button" onClick={async () => { setBusy(true); try { setProbe(JSON.stringify(await api(`/connections/${editing.id}/probe`, {}), null, 2)); report('Capability probe completed. No task was sent.') } catch (error) { report((error as Error).message) } finally { setBusy(false) } }}>Probe capabilities</button></div>{probe && <pre className="studio-output">{probe}</pre>}
    </form></div>
}

function Studio() {
  const [workflows, setWorkflows] = useState<WorkflowRevision[]>([])
  const [selectedDefault, setSelectedDefault] = useState<{ id: string; revision: string } | null>(null)
  const [graph, setGraph] = useState<WorkflowRevision | null>(null)
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([])
  const [nodes, setNodes, onNodesChange] = useNodesState<TaskNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [list, setList] = useState<ConnectionList>({ builtins: ['claude', 'glm', 'codex'], connections: [], presets: [], models: {} })
  const [tab, setTab] = useState<'blueprint' | 'connections' | 'runs' | 'policy'>('blueprint')
  const [policy, setPolicy] = useState<PolicyRevision | null>(null)
  const [policyText, setPolicyText] = useState('')
  const [policyRevisions, setPolicyRevisions] = useState<PolicyRevision[]>([])
  const [message, setMessage] = useState('Loading workflows…')
  const [busy, setBusy] = useState(false)
  const [runForm, setRunForm] = useState(false)
  const [cwd, setCwd] = useState('')
  const [request, setRequest] = useState('')
  const [label, setLabel] = useState('')
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [run, setRun] = useState<WorkflowRun | null>(null)
  const [preview, setPreview] = useState('')
  const locked = graph?.id === 'default'
  const selectedNode = nodes.find(node => node.id === selected)?.data
  const refreshConnections = useCallback(async () => setList(await api<ConnectionList>('/connections')), [])
  const load = useCallback((workflow: WorkflowRevision) => { setGraph(workflow); setNodes(graphNodes(workflow)); setEdges(graphEdges(workflow)); setSelected(workflow.entry); setDirty(false); setPreview(''); void api<{ revisions: WorkflowRevision[] }>(`/workflows/${workflow.id}/revisions`).then(result => setRevisions(result.revisions)).catch(() => setRevisions([])) }, [setNodes, setEdges])
  const refreshWorkflows = useCallback(async () => { const result = await api<{ workflows: WorkflowRevision[]; selected: WorkflowRevision }>('/workflows'); setWorkflows(result.workflows); setSelectedDefault(result.selected); return result }, [])
  const refreshRuns = useCallback(async () => setRuns((await api<{ runs: RunSummary[] }>('/runs')).runs), [])
  useEffect(() => {
    let active = true
    Promise.all([refreshWorkflows(), refreshConnections(), api<PolicyRevision>('/policy'), refreshRuns()]).then(([result, , policy]) => { if (!active) return; load(result.selected); setPolicy(policy); setPolicyText(policy.template); setMessage('Ready. Duplicate the default to make it your own.') }).catch(error => setMessage(error.message))
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const timer = setInterval(() => { if (document.hidden) return; void api<WorkflowRun>(`/runs/${run.id}`).then(setRun).catch(error => setMessage(error.message)) }, 1500)
    return () => clearInterval(timer)
  }, [run?.id, run?.status])
  useEffect(() => { if (tab === 'runs') void refreshRuns().catch(error => setMessage(error.message)); if (tab === 'policy') void api<{ revisions: PolicyRevision[] }>('/policy/revisions').then(result => setPolicyRevisions(result.revisions)).catch(error => setMessage(error.message)) }, [tab, run?.status])
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault() }; addEventListener('beforeunload', guard); return () => removeEventListener('beforeunload', guard) }, [dirty])
  function patchNode(patch: Partial<WorkflowNode>) { setNodes(current => current.map(node => node.id === selected ? { ...node, data: { ...node.data, ...patch } } : node)); setDirty(true) }
  function wire(source: string, outcome: Outcome, target: string) {
    setEdges(current => [...current.filter(edge => !(edge.source === source && edge.sourceHandle === outcome)), ...(target ? [{ id: `${source}-${outcome}`, source, target, sourceHandle: outcome, label: outcome, markerEnd: { type: MarkerType.ArrowClosed }, className: `outcome-${outcome}` }] : [])]); setDirty(true)
  }
  const connect = useCallback((connection: Connection) => { if (connection.source && connection.target && outcomes.includes(connection.sourceHandle as Outcome)) wire(connection.source, connection.sourceHandle as Outcome, connection.target) }, [])
  function draft(): Workflow {
    return { id: graph!.id, name: graph!.name, entry: graph!.entry, nodes: nodes.map(node => ({ ...node.data, position: node.position })), edges: edges.map(edge => ({ source: edge.source, target: edge.target, outcome: edge.sourceHandle as Outcome })) }
  }
  async function action(task: () => Promise<void>) { setBusy(true); try { await task() } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) } }
  function duplicate() {
    if (!graph) return
    const copy = { ...draft(), id: `workflow-${crypto.randomUUID().slice(0, 8)}`, name: `${graph.name} copy`, revision: '', createdAt: 0 }
    load(copy); setDirty(true); setMessage('Editing a new blueprint. Core rules remain protected.')
  }
  function addTask(jev = false) {
    const id = `task-${crypto.randomUUID().slice(0, 8)}`
    const node: WorkflowNode = { id, title: jev ? 'E2E with Jev' : 'New AI task', kind: 'task', instructions: jev ? 'Use the installed Jev browser harness to test the requested user journey. Verify the actual browser state with independent assertions. Save screenshots and a test report. Report missing Jev setup or access as blocked. Do not claim success from a browser DONE signal alone.' : 'Describe the task, constraints, and evidence required for success.', agent: { role: 'execute' }, skills: [], mcpServers: [], checks: [], maxVisits: 3, position: { x: nodes.length * 100, y: 330 } }
    setNodes(current => [...current, { id, type: 'task', data: node, position: node.position }]); setSelected(id); setDirty(true)
  }
  const modelOptions = selectedNode ? list.models[selectedNode.agent.engine ?? ''] ?? list.connections.find(connection => connection.id === selectedNode.agent.engine)?.models ?? [] : []
  return <div className="studio-shell">
    <header className="studio-heading"><div><h1>Studio</h1><p>Build the way your agents work.</p></div><nav aria-label="Studio sections">{(['blueprint', 'connections', 'runs', 'policy'] as const).map(view => <button key={view} aria-current={tab === view ? 'page' : undefined} onClick={() => setTab(view)}>{({ blueprint: 'Blueprints', connections: 'Connections', runs: 'Runs', policy: 'Core prompt' })[view]}</button>)}</nav></header>
    <div className="studio-message" role="status" aria-live="polite">{message}</div>
    {tab === 'blueprint' && graph && <>
      <div className="studio-toolbar"><label>Blueprint<select aria-label="Blueprint" value={workflows.some(workflow => workflow.id === graph.id) ? graph.id : ''} onChange={event => { if (dirty && !confirm('Discard unsaved blueprint edits?')) return; const workflow = workflows.find(workflow => workflow.id === event.target.value); if (workflow) load(workflow) }}><option value="" disabled>Unsaved blueprint</option>{workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}{selectedDefault?.id === workflow.id ? ' · default' : ''}</option>)}</select></label>
        <label>Revision<select aria-label="Revision" value={graph.revision} onChange={event => { if (dirty && !confirm('Discard unsaved blueprint edits?')) return; const revision = revisions.find(revision => revision.revision === event.target.value); if (revision) load(revision) }}><option value="" disabled>Unsaved</option>{revisions.map(revision => <option key={revision.revision} value={revision.revision}>{revision.revision.slice(0, 8)}</option>)}</select></label>
        <button onClick={duplicate} disabled={busy}>Duplicate</button><button disabled={locked || !dirty || busy} onClick={() => void action(async () => { if (document.querySelector('.studio-editor [aria-invalid="true"]')) throw new Error('Fix the invalid tool or check configuration before saving'); const saved = await api<WorkflowRevision>('/workflows', { workflow: draft(), ...(graph.revision ? { expectedRevision: graph.revision } : {}) }); await refreshWorkflows(); load(saved); setMessage('Revision saved. Existing runs keep their original revision.') })}>Save revision</button>
        <button disabled={dirty || busy || (selectedDefault?.id === graph.id && selectedDefault.revision === graph.revision)} onClick={() => void action(async () => { await api('/default', { id: graph.id, revision: graph.revision }); await refreshWorkflows(); setMessage('Default updated for future runs.') })}>Make default</button><button className="studio-primary" disabled={dirty || busy} onClick={() => setRunForm(!runForm)}>Run workflow</button>
      </div>
      {runForm && <form className="studio-run-form" onSubmit={event => { event.preventDefault(); void action(async () => { const started = await api<WorkflowRun>('/runs', { workflowId: graph.id, revision: graph.revision, cwd, label, request }); setRun(started); setTab('runs'); setRunForm(false); setMessage('Run started with pinned workflow and core prompt.') }) }}><label>Run title<input required value={label} onChange={event => setLabel(event.target.value)} /></label><label>Project directory<input required value={cwd} placeholder="/Users/you/code/project" onChange={event => setCwd(event.target.value)} /></label><label className="studio-request">What should this workflow accomplish?<textarea required rows={3} value={request} onChange={event => setRequest(event.target.value)} /></label><p>The run works in this directory. It may execute configured tools and acceptance commands.</p><button disabled={busy} type="submit">Start run</button></form>}
      <div className="studio-editor"><aside className="studio-library"><h2>{locked ? 'Default workflow' : 'Your blueprint'}</h2><p>{locked ? 'Ready to run. Duplicate it to change the steps.' : 'Add tasks, then connect each outcome to its next step.'}</p><label>Name<input value={graph.name} disabled={locked} onChange={event => { setGraph({ ...graph, name: event.target.value }); setDirty(true) }} /></label><label>Start at<select disabled={locked} value={graph.entry} onChange={event => { setGraph({ ...graph, entry: event.target.value }); setDirty(true) }}>{nodes.map(node => <option key={node.id} value={node.id}>{node.data.title}</option>)}</select></label><div className="studio-node-list" aria-label="Workflow steps">{nodes.map(node => <button key={node.id} className={`studio-list-row ${node.id === selected ? 'is-selected' : ''}`} onClick={() => setSelected(node.id)}>{node.data.title}<small>{kindLabels[node.data.kind]}</small></button>)}</div><button disabled={locked} onClick={() => addTask()}>Add AI task</button><button disabled={locked} onClick={() => addTask(true)}>Add Jev E2E task</button><div className="studio-core-badge"><strong>Core rules protected</strong><p>Worker scope, honest evidence, and implementation review apply to every blueprint.</p></div></aside>
        <section className="studio-canvas" aria-label="Workflow graph"><ReactFlow<TaskNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes => { onNodesChange(changes); if (changes.some(change => change.type === 'position' && change.dragging)) setDirty(true) }} onEdgesChange={changes => { onEdgesChange(changes); if (changes.some(change => change.type === 'remove')) setDirty(true) }} onNodeClick={(_, node) => setSelected(node.id)} onConnect={connect} nodesDraggable={!locked} nodesConnectable={!locked} elementsSelectable fitView minZoom={0.2} maxZoom={1.5} deleteKeyCode={locked ? null : ['Backspace', 'Delete']} colorMode="dark"><Background color="var(--mc-border)" gap={24} /><Controls showInteractive={false} /></ReactFlow><div className="studio-canvas-note">Connect pass, fail, or blocked. Each outcome follows one path.</div></section>
        <aside className="studio-inspector" aria-label="Task settings">{selectedNode ? <><h2>Task settings</h2><fieldset disabled={locked}><label>Title<input value={selectedNode.title} onChange={event => patchNode({ title: event.target.value })} /></label><label>Task purpose<select value={selectedNode.kind} onChange={event => patchNode({ kind: event.target.value as WorkflowNode['kind'] })}>{Object.entries(kindLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><label>Agent<select value={selectedNode.agent.engine ?? `role:${selectedNode.agent.role}`} onChange={event => patchNode({ agent: event.target.value.startsWith('role:') ? { role: event.target.value.slice(5) as WorkflowNode['agent']['role'] } : { role: selectedNode.agent.role, engine: event.target.value } })}>{['plan', 'execute', 'review'].map(role => <option key={role} value={`role:${role}`}>{role} default</option>)}{list.builtins.map(id => <option key={id} value={id}>{id}</option>)}{list.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label><label>Model<input list="studio-models" value={selectedNode.agent.model ?? ''} placeholder="Agent default" onChange={event => patchNode({ agent: { ...selectedNode.agent, model: event.target.value || undefined } })} /><datalist id="studio-models">{modelOptions.map(model => <option key={model} value={model} />)}</datalist></label><label>Instructions<textarea rows={7} value={selectedNode.instructions} onChange={event => patchNode({ instructions: event.target.value })} /></label>
          <div className="studio-routes"><h3>Next step by outcome</h3>{outcomes.map(outcome => <label key={outcome}>{outcome}<select aria-label={`Next on ${outcome}`} value={edges.find(edge => edge.source === selectedNode.id && edge.sourceHandle === outcome)?.target ?? ''} onChange={event => wire(selectedNode.id, outcome, event.target.value)}><option value="">End with this outcome</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.data.title}</option>)}</select></label>)}</div>
          <label>Maximum visits<input type="number" min={1} max={10} value={selectedNode.maxVisits} onChange={event => patchNode({ maxVisits: Number(event.target.value) })} /></label>
          <details><summary>Skills, tools, and acceptance checks</summary><label>Skill Markdown paths · one per line<textarea rows={3} value={selectedNode.skills.join('\n')} onChange={event => patchNode({ skills: event.target.value.split('\n').filter(Boolean) })} /><small>Relative to the project or absolute paths. Skill contents are pinned at run start.</small></label><JsonField key={`${selected}-mcp`} label="MCP servers" value={selectedNode.mcpServers} onChange={value => patchNode({ mcpServers: value })} /><small>{'Example: [{"name":"browser","command":"browser-mcp","args":[],"env":{}}]. Environment values are variable names. Requires an ACP connection.'}</small><JsonField key={`${selected}-checks`} label="Acceptance commands" value={selectedNode.checks} onChange={value => patchNode({ checks: value })} /><small>{'Example: [{"command":"bun","args":["test"],"timeoutSeconds":300}]. Commands must exit zero for this task to pass.'}</small><label>Model family override<input value={selectedNode.agent.family ?? ''} onChange={event => patchNode({ agent: { ...selectedNode.agent, family: event.target.value || undefined } })} /></label></details>
          <button className="studio-danger" disabled={nodes.length < 2} onClick={() => { setNodes(current => current.filter(node => node.id !== selected)); setEdges(current => current.filter(edge => edge.source !== selected && edge.target !== selected)); setSelected(null); setDirty(true) }}>Remove task</button></fieldset>
          <button disabled={dirty || busy} onClick={() => void action(async () => { setPreview((await api<{ prompt: string }>('/preview', { id: graph.id, revision: graph.revision, nodeId: selectedNode.id, request: request || 'Preview request' })).prompt) })}>Preview composed instructions</button>{preview && <details open><summary>Prompt preview · live inputs added at run time</summary><pre className="studio-output">{preview}</pre></details>}</> : <p>Select a task to edit its instructions and connections.</p>}</aside>
      </div></>}
    {tab === 'connections' && <Connections list={list} refresh={refreshConnections} report={setMessage} />}
    {tab === 'policy' && policy && <section className="studio-policy"><h2>Core prompt</h2><p>Independent of blueprints. New revisions apply to future runs; existing runs keep their original instructions.</p><details><summary>Mandatory rules · read only</summary><pre className="studio-output">{policy.coreRules}</pre></details><label>Load an earlier prompt revision<select value="" onChange={event => { const earlier = policyRevisions.find(item => item.revision === event.target.value); if (earlier) setPolicyText(earlier.template) }}><option value="">Choose a revision to edit</option>{policyRevisions.map(item => <option key={item.revision} value={item.revision}>{item.revision.slice(0, 8)}{item.revision === policy.revision ? ' · current' : ''}</option>)}</select></label><label>Prompt template<textarea aria-label="Prompt template" className="studio-code" rows={18} value={policyText} onChange={event => setPolicyText(event.target.value)} /></label><p>Keep one each of {'{{core_rules}}'}, {'{{workflow}}'}, and {'{{assignment}}'}. These slots compose the protected rules, selected workflow, and node inputs.</p><button disabled={busy || policyText === policy.template} onClick={() => void action(async () => { const next = await api<PolicyRevision>('/policy', { template: policyText }); setPolicy(next); setPolicyText(next.template); setPolicyRevisions((await api<{ revisions: PolicyRevision[] }>('/policy/revisions')).revisions); setMessage(`Core prompt revision ${next.revision.slice(0, 8)} saved for future runs.`) })}>Save prompt revision</button></section>}
    {tab === 'runs' && <div className="studio-runs"><aside className="studio-library"><h2>Workflow runs</h2><button onClick={() => void action(refreshRuns)}>Refresh runs</button>{runs.length === 0 && <p>No runs yet. Choose a saved blueprint and select Run workflow.</p>}{runs.map(item => <button key={item.id} className={`studio-list-row ${run?.id === item.id ? 'is-selected' : ''}`} onClick={() => void action(async () => setRun(await api<WorkflowRun>(`/runs/${item.id}`)))}>{item.label}<small>{item.status} · {item.workflowName}</small></button>)}</aside><section className="studio-run-detail">{run ? <><div className="studio-run-heading"><div><h2>{run.label}</h2><span className="studio-status" data-status={run.status}>{run.status}</span></div><div className="studio-actions">{run.status === 'running' ? <button disabled={busy} onClick={() => void action(async () => setRun(await api<WorkflowRun>(`/runs/${run.id}/stop`, {})))}>Stop run</button> : run.status !== 'done' && <button disabled={busy} onClick={() => void action(async () => setRun(await api<WorkflowRun>(`/runs/${run.id}/retry`, {})))}>Retry current step</button>}</div></div><p>{run.cwd}</p><p>Workflow {run.workflow.revision.slice(0, 8)} · Core prompt {run.policy.revision.slice(0, 8)} · versions pinned</p>{run.error && <p role="alert" className="studio-run-error">{run.error}</p>}<p>{run.request}</p><ol className="studio-attempts">{run.attempts.map(attempt => <li key={attempt.number}><h3>{run.workflow.nodes.find(node => node.id === attempt.nodeId)?.title} <span>{attempt.result?.outcome ?? attempt.status}</span></h3><p>{run.agents[attempt.nodeId]?.engine} · {run.agents[attempt.nodeId]?.model ?? 'agent default'}</p>{attempt.result && <><p>{attempt.result.summary}</p><ul>{attempt.result.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul></>}{attempt.checks.map((check, index) => <details key={index}><summary>{check.command} {check.args.join(' ')} · exit {check.exitCode ?? 'unknown'}{check.timedOut ? ' · timed out' : ''}</summary><pre className="studio-output">{check.output}</pre></details>)}{attempt.jobId && <p><a href={`/api/jobs/${attempt.jobId}/log`} target="_blank" rel="noreferrer">Open job log</a></p>}<details><summary>Rendered instructions</summary><pre className="studio-output">{attempt.prompt}</pre></details></li>)}</ol></> : <p>Select a run to inspect its tasks, evidence, and pinned revisions.</p>}</section></div>}
  </div>
}


export default Studio
