import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useNodesState, useEdgesState, MarkerType, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Workflow, WorkflowNode, WorkflowRevision, PolicyRevision, Outcome } from '../server/workflows'
import type { WorkflowRun } from '../server/workflow-runner'
import type { DraftJob, WorkflowDraft } from '../server/workflow-builder'
import { api } from './studio-api'
import { type ConnectionList } from './studio-settings'
import { agentLabel, insertWorkflowStep, removeWorkflowStep, taskPreset, workflowTemplates, type Provider } from './studio-graph'

type TaskNode = Node<WorkflowNode & { agentLabel: string; branches: Outcome[] }, 'task'>
type Screen = 'home' | 'templates' | 'editor' | 'connections' | 'runs' | 'rules'
type Panel = 'assistant' | 'picker' | 'step' | 'history' | null
type RunSummary = Pick<WorkflowRun, 'id' | 'label' | 'status' | 'error' | 'currentNodeId' | 'createdAt'> & { workflowName: string; revision: string }
const outcomeLabels: Record<Outcome, string> = { pass: 'When it succeeds', fail: 'If it fails', blocked: 'If it needs help' }
const NAV: Array<[Screen, string]> = [['home', 'Workflows'], ['connections', 'Manage AIs'], ['runs', 'Runs'], ['rules', 'Rules']]
const EXAMPLES = ['Plan the work, verify the plan, then implement and get an independent review using my configured AIs.', 'Research my question, then have another AI check the sources and findings.']

function graphEdges(graph: Workflow): Edge[] { return graph.edges.map(edge => ({ id: `${edge.source}-${edge.outcome}`, source: edge.source, target: edge.target, sourceHandle: edge.outcome, label: edge.outcome === 'pass' ? undefined : outcomeLabels[edge.outcome], markerEnd: { type: MarkerType.ArrowClosed }, className: `outcome-${edge.outcome}` })) }
function fresh(graph: Workflow): WorkflowRevision { return { ...graph, id: `workflow-${crypto.randomUUID().slice(0, 8)}`, revision: '', createdAt: 0 } }
function dateLabel(time: number): string { return time ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Built-in version' }
const Icon = ({ id }: { id: string }) => <svg aria-hidden="true"><use href={`#${id}`} /></svg>

function Studio() {
  const [screen, setScreen] = useState<Screen>('home')
  const [panel, setPanel] = useState<Panel>(null)
  const [workflows, setWorkflows] = useState<WorkflowRevision[]>([])
  const [defaultFlow, setDefaultFlow] = useState<WorkflowRevision | null>(null)
  const [graph, setGraph] = useState<WorkflowRevision | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<TaskNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [list, setList] = useState<ConnectionList>({ builtins: ['claude', 'glm', 'codex'], connections: [], presets: [], models: {} })
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [description, setDescription] = useState('')
  const [builderEngine, setBuilderEngine] = useState('')
  const [draftJob, setDraftJob] = useState<DraftJob | null>(null)
  const [aiSummary, setAiSummary] = useState('')
  const [setup, setSetup] = useState<string[]>([])
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [run, setRun] = useState<WorkflowRun | null>(null)
  const [policy, setPolicy] = useState<PolicyRevision | null>(null)
  const generationBase = useRef<WorkflowRevision | null>(null)
  const building = draftJob?.status === 'running'
  const disabled = busy || building
  const builtin = workflows.find(item => item.id === 'default')
  const templates = builtin ? workflowTemplates(builtin) : []
  const label = (node: WorkflowNode) => agentLabel(node, providers)
  const toast = (text: string) => dispatchEvent(new CustomEvent('quiet:toast', { detail: text }))

  function nodesFor(value: Workflow): TaskNode[] { return value.nodes.map(node => ({ id: node.id, type: 'task', position: node.position, data: { ...node, agentLabel: label(node), branches: value.edges.filter(edge => edge.source === node.id).map(edge => edge.outcome) } })) }
  function load(value: WorkflowRevision, edited = false) { setGraph(value); setNodes(nodesFor(value)); setEdges(graphEdges(value)); setSelected(null); setDirty(edited); setRevisions([]) }
  function draft(): Workflow { return { id: graph!.id, name: graph!.name, entry: graph!.entry, nodes: nodes.map(node => { const { agentLabel: _label, branches: _branches, ...spec } = node.data; return { ...spec, position: node.position } }), edges: edges.map(edge => ({ source: edge.source, target: edge.target, outcome: (edge.sourceHandle ?? 'pass') as Outcome })) } }
  function markDirty() { if (graph?.id === 'default') setGraph(current => current ? fresh({ ...current, name: `${current.name} copy` }) : current); setDirty(true); setError('') }
  function adopt(value: Workflow) { markDirty(); setGraph(current => current ? { ...current, entry: value.entry } : current); setNodes(nodesFor(value)); setEdges(graphEdges(value)) }
  function addStep(id: string) { if (disabled || !graph) return; const step = taskPreset(id); adopt(insertWorkflowStep(draft(), step, selected ?? undefined)); setSelected(step.id); setPanel('step') }
  async function action(task: () => Promise<void>) { setBusy(true); setError(''); try { await task() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  const refreshConnections = useCallback(async () => { setList(await api<ConnectionList>('/connections')); const result = await fetch('/api/providers').then(response => response.json()) as { providers: Provider[] }; setProviders(result.providers ?? []) }, [])
  const refreshWorkflows = useCallback(async () => { const result = await api<{ workflows: WorkflowRevision[]; selected: WorkflowRevision }>('/workflows'); setWorkflows(result.workflows); setDefaultFlow(result.selected); return result }, [])
  const refreshRuns = useCallback(async () => setRuns((await api<{ runs: RunSummary[] }>('/runs')).runs), [])
  useEffect(() => { let active = true; Promise.all([refreshWorkflows(), refreshConnections(), api<PolicyRevision>('/policy'), api<{ draft: DraftJob | null }>('/drafts')]).then(([, , policy, drafting]) => { if (active) { setPolicy(policy); if (drafting.draft) setDraftJob(drafting.draft) } }).catch(error => setError(error.message)); return () => { active = false } }, [])
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty || building) event.preventDefault() }; addEventListener('beforeunload', guard); return () => removeEventListener('beforeunload', guard) }, [dirty, building])
  useEffect(() => { if (screen === 'runs') void refreshRuns().catch(error => setError(error.message)) }, [screen, run?.status])
  useEffect(() => {
    if (!building || !draftJob) return
    let stopped = false, pending = false
    const poll = async () => { if (pending) return; pending = true; try { const result = await api<DraftJob>(`/drafts/${draftJob.id}`); if (stopped) return; if (result.status === 'done' && result.draft) { applyAiDraft(result.draft); setDraftJob(result) } else if (result.status === 'failed') { setDraftJob(result); setError(result.error ?? 'Could not build this workflow. Try again.') } } catch (error) { if (!stopped) setError((error as Error).message) } finally { pending = false } }
    const timer = setInterval(() => void poll(), 1200); void poll(); return () => { stopped = true; clearInterval(timer) }
  }, [draftJob?.id, building])
  function applyAiDraft(result: WorkflowDraft) { const base = generationBase.current; const next = base && base.id !== 'default' ? { ...result.workflow, id: base.id, revision: base.revision, createdAt: base.createdAt } : fresh(result.workflow); load(next, true); setAiSummary(result.summary); setSetup(result.setup); setScreen('editor'); setPanel('assistant'); setDescription(''); toast('Workflow draft ready. Review the steps before saving or running.') }
  async function generate() { if (!description.trim() || disabled) return; if (screen !== 'editor' && dirty && !confirm('Replace your unsaved draft with a new AI workflow?')) return; await action(async () => { generationBase.current = screen === 'editor' && graph ? { ...graph, ...draft() } : null; const base = generationBase.current; const job = await api<DraftJob>('/drafts', { description, ...(builderEngine ? { engine: builderEngine } : {}), ...(base?.nodes.length ? { workflow: base } : {}) }); setDraftJob(job); setPanel('assistant') }) }
  async function stopDraft() { if (!draftJob) return; await action(async () => { await api(`/drafts/${draftJob.id}/stop`, {}); setDraftJob({ ...draftJob, status: 'failed' }); toast('Workflow drafting stopped. Your existing flow is unchanged.') }) }
  function open(value: WorkflowRevision, copy = false) { if (building) return; if (dirty && !confirm('Discard unsaved changes and open this workflow?')) return; load(copy ? fresh(value) : value, copy); setScreen('editor'); setPanel(null); setAiSummary(''); setSetup([]) }
  function openTemplate(value: Workflow) { open({ ...value, revision: '', createdAt: 0 }, true) }
  function blank() { if (building) return; if (dirty && !confirm('Discard unsaved changes and start a new workflow?')) return; load(fresh({ id: 'new', name: 'Untitled workflow', entry: '', nodes: [], edges: [] }), true); setScreen('editor'); setPanel('picker'); setAiSummary(''); setSetup([]) }
  function go(next: Screen) { setScreen(next); setError('') }

  const nav = document.getElementById('studio-nav')
  const heading = nav ? createPortal(screen === 'editor'
    ? <button type="button" className="text-button" onClick={() => go('home')}><Icon id="back-icon" />Workflows</button>
    : NAV.map(([id, text]) => <button key={id} type="button" className="text-button" aria-current={screen === id || (screen === 'templates' && id === 'home') ? 'page' : undefined} onClick={() => go(id)}>{text}</button>), nav) : null

  const providerOptions = providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)
  const promptBox = (small = false) => <form className="workflow-prompt" onSubmit={event => { event.preventDefault(); void generate() }}>
    <textarea aria-label={small ? 'Ask AI to change the workflow' : 'Describe your workflow'} rows={small ? 6 : 4} value={description} disabled={disabled} onChange={event => setDescription(event.target.value)} placeholder={small ? 'Add a testing step before the review…' : 'Plan the work, build it, then ask another AI to review…'} required />
    <div><label><span className="visually-hidden">Planning AI</span><select aria-label="Planning AI" disabled={disabled} value={builderEngine} onChange={event => setBuilderEngine(event.target.value)}><option value="">Chat default</option>{providerOptions}</select></label>{building ? <button type="button" className="pill" onClick={() => void stopDraft()}>Stop drafting</button> : <button className="pill" type="submit" disabled={busy || !description.trim()}><Icon id="spark-icon" />{small ? 'Update draft' : 'Build workflow'}</button>}</div>
    {building && <p className="muted" role="status">Your AI is drafting the workflow… This can take a minute.</p>}
  </form>
  const strip = (value: Workflow) => <span className="strip" aria-hidden="true">{value.nodes.slice(0, 5).map(node => <i key={node.id} />)}</span>

  return <>
    {heading}
    {error && <div className="studio-error" role="alert"><span>{error}</span><button type="button" className="round" aria-label="Dismiss error" onClick={() => setError('')}><Icon id="close-icon" /></button></div>}
    {screen === 'home' && <section className="studio-view describe-home">
      <h2>How should your team work?</h2><p className="muted">Describe the steps you have in mind. Shape them on the canvas.</p>
      {promptBox()}
      <div className="prompt-examples"><span className="muted">Try an example</span>{EXAMPLES.map((example, index) => <button key={example} type="button" className="example" disabled={disabled} onClick={() => setDescription(example)}>{index === 0 ? 'Plan, implement, review' : 'Research and verify'}</button>)}</div>
      <div className="starting-options">
        <button type="button" className="studio-option" disabled={!defaultFlow || building} onClick={() => defaultFlow && open(defaultFlow)}><Icon id="flow-icon" /><strong>Use the default</strong><small>{defaultFlow?.name ?? 'Loading your default…'}</small></button>
        <button type="button" className="studio-option" disabled={building} onClick={() => go('templates')}><Icon id="history-icon" /><strong>Browse templates</strong><small>A starting point to make yours</small></button>
        <button type="button" className="studio-option" disabled={building} onClick={blank}><Icon id="plus-icon" /><strong>Start from scratch</strong><small>One step at a time</small></button>
      </div>
      <div className="compact-templates">{templates.slice(1).map(item => <button key={item.id} type="button" disabled={building} onClick={() => openTemplate(item)}>{strip(item)}<span>{item.name}</span><small className="muted">{item.nodes.length} steps</small></button>)}</div>
      {graph && <button type="button" className="text-button continue-draft" onClick={() => go('editor')}>Continue editing {graph.name}{dirty ? ' · Unsaved changes' : ''}<Icon id="open-icon" /></button>}
      {workflows.some(item => item.id !== 'default') && <section className="saved-workflows"><h3>Your workflows</h3>{workflows.filter(item => item.id !== 'default').map(item => <button key={item.id} type="button" disabled={building} onClick={() => open(item)}><span><strong>{item.name}</strong><small>{item.nodes.length} steps · {dateLabel(item.createdAt)}</small></span><Icon id="open-icon" /></button>)}</section>}
    </section>}
    {screen === 'templates' && <section className="studio-view describe-home"><h2>Choose a starting point.</h2><div className="starting-options">
      {templates.map((item, index) => <button key={item.id} type="button" className="studio-option" disabled={building} onClick={() => index === 0 ? open({ ...item, revision: builtin!.revision, createdAt: 0 }) : openTemplate(item)}><strong>{index === 0 ? 'Plan, build & review' : item.name}</strong><small>{item.nodes.length} steps · {index === 0 ? 'Default workflow' : index === 1 ? 'Explore, then check the findings' : 'Check existing work and take a closer look'}</small></button>)}
      <button type="button" className="studio-option" disabled={building} onClick={blank}><strong>Blank workflow</strong><small>Start with your own task</small></button>
    </div></section>}
    {screen === 'editor' && <section className="studio-view"><p className="studio-placeholder">The editor for {graph?.name ?? 'this workflow'} lands in the next task. {nodes.length} steps loaded{dirty ? ' · Unsaved changes' : ''}.</p></section>}
    {screen === 'connections' && <section className="studio-view"><p className="studio-placeholder">Manage AIs lands in a later task. {list.connections.length} connections configured.</p></section>}
    {screen === 'runs' && <section className="studio-view"><p className="studio-placeholder">Runs lands in a later task. {runs.length} runs so far.</p></section>}
    {screen === 'rules' && <section className="studio-view"><p className="studio-placeholder">Rules lands in a later task.{policy ? ` Core prompt revision ${policy.revision}.` : ''}</p></section>}
  </>
}

const root = document.getElementById('studio-root')
if (root) createRoot(root).render(<Studio />)
