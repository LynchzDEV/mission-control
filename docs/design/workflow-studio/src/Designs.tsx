import { useEffect, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, useNodesState, useEdgesState, type NodeProps, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import CurrentStudio from './CurrentStudio'

type Variant = 'now' | 'a' | 'b' | 'c'
type Step = { title: string; description: string; agent: string; tone: string; symbol: string; instruction: string; added?: boolean }
type StepNode = Node<Step, 'step'>
type Panel = 'assistant' | 'picker' | 'step' | 'history' | null
const variants: Array<{ id:Variant; name:string; description:string }> = [
  { id:'now', name:'NOW · Current', description:'The current Studio, using its real components with fixture data.' },
  { id:'a', name:'A · Describe', description:'Describe the workflow first. Templates and a blank canvas are one click away.' },
  { id:'b', name:'B · Canvas', description:'Start with the workflow in view. Add steps or ask AI for a change alongside it.' },
  { id:'c', name:'C · Templates', description:'Start from a recognizable workflow, then make it your own.' },
]
const presets:Step[] = [
  {title:'Plan work',description:'Turn a request into a clear plan',agent:'Claude',tone:'ice',symbol:'plan',instruction:'Inspect the request and project. Outline the changes, constraints, and how to verify the result.'},
  {title:'Check a plan',description:'Catch gaps before work begins',agent:'Codex',tone:'coral',symbol:'check',instruction:'Check the plan against the request and project. Flag missing steps and unclear requirements.'},
  {title:'Implement changes',description:'Carry out the approved plan',agent:'Claude',tone:'lime',symbol:'code',instruction:'Implement the verified plan. Follow project conventions and check that the changes work.'},
  {title:'Review work',description:'Get an independent second opinion',agent:'Codex',tone:'coral',symbol:'review',instruction:'Review the changes against the plan. Inspect the actual work and report findings with evidence.'},
  {title:'Research',description:'Explore a question and collect sources',agent:'Claude',tone:'ice',symbol:'research',instruction:'Research the question. Compare sources and provide a concise, evidence-backed answer.'},
  {title:'Run tests',description:'Check that the result works as expected',agent:'Codex',tone:'lime',symbol:'test',instruction:'Run the relevant tests and inspect the result. Report what passed, what failed, and supporting evidence.'},
]
const custom:Step = {title:'Untitled step',description:'Describe any task',agent:'Workflow default',tone:'ice',symbol:'spark',instruction:'',added:true}
const templateInfo = [
  {id:'default',name:'Plan, build & review',tag:'MC default',description:'Plan the change, check the plan, implement, and get an independent review.',steps:[0,1,2,3]},
  {id:'research',name:'Research & summarize',tag:'2 steps',description:'Explore a question, then have another AI check the findings.',steps:[4,3]},
  {id:'quality',name:'Test & review',tag:'2 steps',description:'Check existing work and take a closer look at the results.',steps:[5,3]},
]
function Icon({name='spark',size=18}:{name?:string;size?:number}) {
  const paths:Record<string,React.ReactNode> = {
    spark:<><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z"/></>,
    plan:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    check:<><path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="10"/></>,
    code:<><path d="m7 6-5 6 5 6m10-12 5 6-5 6m-3-14-4 16"/></>,
    review:<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    research:<><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
    test:<><path d="m8 3 8 0M10 3v6L4 19q-1 2 2 2h12q3 0 2-2L14 9V3M7 15h10"/></>,
    plus:<path d="M12 5v14M5 12h14"/>,
    arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,
    back:<path d="M20 12H4m6-6-6 6 6 6"/>,
    close:<path d="m6 6 12 12M6 18 18 6"/>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    play:<path d="m8 4 12 8-12 8Z"/>,
    layers:<><path d="m12 3 10 5-10 5L2 8Zm-10 10 10 5 10-5M2 18l10 5 10-5"/></>,
    folder:<path d="M3 6h7l2 3h9v11H3Z"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.spark}</svg>
}
function StepCard({data,selected}:NodeProps<StepNode>) {
  return <div className={`flow-step ${selected?'selected':''} tone-${data.tone}`}>
    <Handle type="target" position={Position.Left}/>
    <div className="step-top"><span className="step-icon"><Icon name={data.symbol}/></span>{data.added&&<span className="new-tag">New</span>}</div>
    <strong>{data.title}</strong><p>{data.description}</p>
    <div className="step-person"><span className={`agent-avatar ${data.agent==='Claude'?'claude':'codex'}`}>{data.agent.slice(0,1)}</span>{data.agent}</div>
    <Handle type="source" position={Position.Right}/>
  </div>
}
const nodeTypes = {step:StepCard}
function makeGraph(indices:number[]) {
  const nodes:StepNode[] = indices.map((index,i)=>({id:`step-${i}`,type:'step',position:{x:i*276,y:130},data:{...presets[index]!}}))
  const edges:Edge[] = nodes.slice(0,-1).map((node,i)=>({id:`edge-${i}`,source:node.id,target:nodes[i+1]!.id,markerEnd:{type:MarkerType.ArrowClosed}}))
  return {nodes,edges}
}
function AppChrome() {
  return <div className="top masthead mock-chrome">
    <a className="l" href="#a">Mission Control<span className="brand-mark">_</span></a>
    <nav className="tabs" aria-label="Workspace"><span>Terminals</span><span>Main</span></nav>
    <div className="usage-summary" aria-label="Example provider usage">{['Claude','GLM','Codex'].map((name,i)=><section className="provider-usage" key={name}><div className="quota-heading"><span className="quota-provider">{name}</span><span className="quota-period">{i===2?'Weekly':'5h'}</span><strong>{[42,18,63][i]}<small>%</small></strong></div><span className="quota-track"><i style={{width:`${[42,18,63][i]}%`}}/></span></section>)}</div>
    <div className="global-actions"><span>New job</span><span>Review</span><span className="current-app">Studio</span><span>Settings</span></div>
  </div>
}
function PromptBox({value,onChange,onSubmit,label='Build workflow',small=false}:{value:string;onChange:(value:string)=>void;onSubmit:()=>void;label?:string;small?:boolean}) {
  return <div className={`prompt-box ${small?'small':''}`}><textarea aria-label={small?'Ask AI to change the workflow':'Describe your workflow'} value={value} onChange={event=>onChange(event.target.value)} placeholder={small?'Describe what you’d like to change…':'Tell us what should happen, which AIs to use, and what a good result looks like.'} rows={small?4:4}/><div className="prompt-actions"><span><Icon name="spark" size={14}/> {small?'AI assistant':'Build with your connected AI'}</span><button className="primary" onClick={onSubmit}><Icon name="spark" size={15}/>{label}</button></div></div>
}
function MiniFlow({steps}:{steps:number[]}) {return <div className="mini-flow">{steps.map((index,i)=><span key={i} className={`tone-${presets[index]!.tone}`}><i><Icon name={presets[index]!.symbol} size={16}/></i>{i<steps.length-1&&<em/>}</span>)}</div>}
function StudioDesign({variant}:{variant:Exclude<Variant,'now'>}) {
  const [screen,setScreen]=useState<'create'|'editor'>(variant==='b'?'editor':'create')
  const [catalog,setCatalog]=useState(variant==='c')
  const dialogRef=useRef<HTMLDialogElement>(null)
  const [name,setName]=useState('Plan, build & review')
  const initial=makeGraph([0,1,2,3])
  const [nodes,setNodes,onNodesChange]=useNodesState<StepNode>(initial.nodes)
  const [edges,setEdges,onEdgesChange]=useEdgesState(initial.edges)
  const [panel,setPanel]=useState<Panel>(variant==='b'?'assistant':null)
  const [selected,setSelected]=useState<string|null>(null)
  const [prompt,setPrompt]=useState('')
  const [query,setQuery]=useState('')
  const [generation,setGeneration]=useState(false)
  const [changed,setChanged]=useState(false)
  const [notice,setNotice]=useState('')
  const [modal,setModal]=useState<'rules'|'run'|'connect'|null>(null)
  const [tools,setTools]=useState(['Project files','Terminal'])
  const [criteria,setCriteria]=useState('')
  const [tab,setTab]=useState('All templates')
  const current=nodes.find(node=>node.id===selected)
  useEffect(()=>{if(modal) dialogRef.current?.showModal()},[modal])
  useEffect(()=>{ if (!notice) return;const timer=setTimeout(()=>setNotice(''),5000);return()=>clearTimeout(timer) },[notice])
  function openTemplate(id:string) {
    const chosen=templateInfo.find(item=>item.id===id)??templateInfo[0]!
    const graph=makeGraph(chosen.steps);setNodes(graph.nodes);setEdges(graph.edges);setName(chosen.name);setScreen('editor');setPanel(null);setGeneration(false);setSelected(null)
  }
  function blank(){setNodes([]);setEdges([]);setName('Untitled workflow');setScreen('editor');setPanel('picker');setGeneration(false)}
  function generate(){const graph=makeGraph([0,1,2,3]);setNodes(graph.nodes);setEdges(graph.edges);setName('Plan, build & review');setScreen('editor');setGeneration(true);setPanel('assistant');setSelected(null);setNotice('Example draft shown. This preview does not call AI.')}
  function addStep(step:Step){const id=`step-${crypto.randomUUID().slice(0,8)}`;const previous=selected??nodes.at(-1)?.id;const anchor=nodes.find(node=>node.id===previous);setNodes(old=>[...old,{id,type:'step',position:{x:(anchor?.position.x??-276)+276,y:(anchor?.position.y??130)+(edges.some(edge=>edge.source===previous)?225:0)},data:{...step,added:true}}]);setEdges(old=>{const after=old.find(edge=>edge.source===previous);return [...old.filter(edge=>edge!==after),...(previous?[{id:`edge-${id}`,source:previous,target:id,markerEnd:{type:MarkerType.ArrowClosed}}]:[]),...(after?[{...after,id:`edge-${id}-after`,source:id}]:[])]});setSelected(id);setPanel('step');setChanged(true);setNotice('Step added to the preview. Drag it to move it.')}
  function aiEdit(){addStep(presets[5]!);setPanel('assistant');setGeneration(true);setChanged(true);setNotice('Example AI edit: added a testing step. No AI was called.')}
  function updateStep(patch:Partial<Step>){setNodes(old=>old.map(node=>node.id===selected?{...node,data:{...node.data,...patch}}:node));setChanged(true)}
  function presetPicker(){setQuery('');setPanel('picker')}
  return <section className="design-product">
    {screen==='create'?<>
      <div className="product-heading"><div><h1>Workflows</h1><p>Give your AI team a way to work.</p></div><button className="quiet" onClick={()=>setModal('connect')}>Manage AIs <Icon name="arrow" size={14}/></button></div>
      {!catalog?<div className="describe-home"><div className="intro"><span className="new-tag">New · Describe to build</span><h2>How should your team work?</h2><p>Describe the steps you have in mind. You can change everything on the canvas.</p></div><PromptBox value={prompt} onChange={setPrompt} onSubmit={generate}/><div className="prompt-examples"><span>Try an example</span><button onClick={()=>setPrompt('Plan the work with Claude, verify it with Codex, then implement and get an independent review.')}>Plan, implement, review</button><button onClick={()=>setPrompt('Research my question, then have another AI check the sources and findings.')}>Research and verify</button></div><div className="alternate-heading"><h3>Or choose a starting point</h3><span>Every step is editable</span></div><div className="starting-options"><button className="start-option" onClick={()=>openTemplate('default')}><Icon name="layers"/><strong>Use the default workflow</strong><span>Plan → verify → execute → review</span><Icon name="arrow"/></button><button className="start-option" onClick={()=>{setTab('All templates');setCatalog(true);setScreen('create')}}><Icon name="folder"/><strong>Browse templates</strong><span>Start with a proven sequence</span><Icon name="arrow"/></button><button className="start-option" onClick={blank}><Icon name="plus"/><strong>Start from scratch</strong><span>Build one step at a time</span><Icon name="arrow"/></button></div><div className="compact-templates">{templateInfo.slice(1).map(item=><button key={item.id} onClick={()=>openTemplate(item.id)}><MiniFlow steps={item.steps}/><span>{item.name}</span><Icon name="arrow" size={14}/></button>)}</div></div>:
      <div className="templates-home"><div className="template-heading"><div><span className="new-tag">New · Workflow templates</span><h2>Start with a workflow.<br/>Make it yours.</h2><p>Choose a starting point, then change the steps, AIs, and instructions.</p></div><div className="template-prompt"><label htmlFor="template-description">Have something else in mind?</label><textarea id="template-description" rows={3} value={prompt} onChange={event=>setPrompt(event.target.value)} placeholder="Describe a workflow…"/><button className="primary" onClick={generate}><Icon name="spark" size={15}/>Build with AI</button></div></div><div className="template-tabs" role="tablist" aria-label="Template categories">{['All templates','Built in','My templates'].map(label=><button key={label} role="tab" aria-selected={tab===label} onClick={()=>setTab(label)}>{label}</button>)}<button className="blank-link" onClick={blank}><Icon name="plus" size={14}/>Start blank</button></div>{tab==='My templates'?<div className="empty-templates"><Icon name="layers" size={32}/><h3>Your reusable workflows go here</h3><p>Customize a workflow and save it as a template.</p><button onClick={()=>setTab('All templates')}>Explore starting points</button></div>:<div className="template-grid">{templateInfo.map(item=><button className={`template-card ${item.id==='default'?'featured':''}`} key={item.id} onClick={()=>openTemplate(item.id)}><div className="template-card-top"><span>{item.tag}</span><Icon name="arrow"/></div><MiniFlow steps={item.steps}/><h3>{item.name}</h3><p>{item.description}</p><div className="template-bottom"><span>{item.steps.length} steps · Editable</span><strong>Use template</strong></div></button>)}</div>}</div>}
    </>:<>
      <div className="editor-heading"><button className="icon-button" aria-label="Back to workflows" onClick={()=>{setScreen('create');setPanel(null)}}><Icon name="back"/></button><div className="workflow-name"><input aria-label="Workflow name" value={name} onChange={event=>setName(event.target.value)}/><span>{changed?'Draft changes':'Draft'}<i/> {nodes.length} steps</span></div><div className="editor-actions"><button className="quiet" onClick={()=>setPanel(panel==='history'?null:'history')}><Icon name="clock" size={16}/>History</button><button onClick={()=>{setNotice('Preview only. In the product, this saves a new version.');setChanged(false)}}>Save</button><button className="primary" onClick={()=>setModal('run')}><Icon name="play" size={15}/>Run workflow</button></div></div>
      <div className="editor-body">
        <div className="design-canvas"><div className="canvas-toolbar"><button onClick={presetPicker}><Icon name="plus" size={16}/>Add step</button><button className={panel==='assistant'?'active-tool':''} onClick={()=>setPanel(panel==='assistant'?null:'assistant')}><Icon name="spark" size={16}/>Ask AI</button></div>
          {generation&&<div className="draft-notice"><span className="new-tag">Example AI draft</span><span>{changed?'Added a testing step. Every detail is editable.':'Four connected steps, ready for you to customize.'}</span><button onClick={()=>setGeneration(false)} aria-label="Dismiss draft message"><Icon name="close" size={14}/></button></div>}
          <ReactFlow<StepNode> key={`${variant}-${screen}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_,node)=>{setSelected(node.id);setPanel('step')}} onPaneClick={()=>setSelected(null)} onConnect={connection=>setEdges(old=>[...old,{...connection,id:`edge-${crypto.randomUUID()}`,markerEnd:{type:MarkerType.ArrowClosed}}])} fitView fitViewOptions={{padding:.18,maxZoom:1}} minZoom={.3} maxZoom={1.3} colorMode="dark" proOptions={{hideAttribution:false}}><Background color="var(--mc-border)" gap={24}/><Controls showInteractive={false}/></ReactFlow>
          {!nodes.length&&<div className="empty-canvas"><span className="empty-node"><Icon name="plus" size={30}/></span><h2>Your workflow starts here</h2><p>Add a step, or describe the whole workflow to AI.</p><div><button onClick={presetPicker}>Add first step</button><button className="primary" onClick={()=>setPanel('assistant')}><Icon name="spark" size={16}/>Build with AI</button></div></div>}
          <div className="canvas-foot"><button onClick={()=>setModal('rules')}><Icon name="lock" size={13}/>Core rules always apply</button><span>Drag to arrange · connect to set the order</span></div>
        </div>
        {panel&&<aside className="design-panel" aria-label={panel==='picker'?'Add a step':panel==='step'?'Edit step':panel==='history'?'Workflow history':'AI assistant'}><div className="panel-heading"><h2>{panel==='picker'?'Add a step':panel==='step'?'Edit step':panel==='history'?'History':'Build with AI'}</h2>{panel!=='history'&&<span className="new-tag">New</span>}<button className="icon-button" onClick={()=>setPanel(null)} aria-label="Close panel"><Icon name="close" size={17}/></button></div>
          {panel==='assistant'&&<div className="assistant-panel"><div className="assistant-intro"><span className="assistant-icon"><Icon name="spark" size={22}/></span><h3>{generation?'A starting point for your workflow':'What would you like to change?'}</h3><p>{generation?'The example is on the canvas. Open any step to adjust its instructions, AI, or tools.':'Describe a change, add a step, or ask for a different approach.'}</p></div>{generation&&prompt&&<div className="user-bubble">{prompt}</div>}{generation&&<div className="assistant-answer"><Icon name="spark" size={16}/><div><strong>{changed?'Example change':'Example response'}</strong><p>{changed?'Added Run tests to the workflow. You can move it or edit its instructions.':'I’ve connected planning, plan verification, implementation, and an independent review.'}</p><small>Illustrative response · no AI call</small></div></div>}<div className="suggested-edits"><span>Try a change</span>{['Add a testing step','Change who reviews the work','Explain this workflow'].map((suggestion,i)=><button key={suggestion} onClick={()=>i===0?aiEdit():i===1?(setSelected(nodes.at(-1)?.id??null),setPanel('step')):setNotice('Example: plan the work, verify the plan, implement, and independently review it.')}>{suggestion}<Icon name="arrow" size={14}/></button>)}</div><div className="assistant-composer"><PromptBox small value={prompt} onChange={setPrompt} onSubmit={nodes.length?aiEdit:generate} label={nodes.length?'Update flow':'Build flow'}/><p>Preview uses a fixed example response.</p></div></div>}
          {panel==='picker'&&<div className="picker-panel"><p>Start with a preset or describe your own task.</p><label className="search-box"><Icon name="research" size={17}/><input aria-label="Find a step" placeholder="Find a step…" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="preset-list">{presets.filter(step=>`${step.title} ${step.description}`.toLowerCase().includes(query.toLowerCase())).map(step=><button key={step.title} className={`preset-row tone-${step.tone}`} onClick={()=>addStep(step)}><span className="preset-icon"><Icon name={step.symbol}/></span><span><strong>{step.title}</strong><small>{step.description}</small></span><Icon name="plus" size={15}/></button>)}</div><button className="custom-step" onClick={()=>addStep(custom)}><span><Icon name="spark"/></span><div><strong>Custom task</strong><small>Write your own instructions. Use any connected AI and its tools.</small></div><Icon name="arrow" size={16}/></button><p className="picker-tip">Presets are starting points. Every field stays editable.</p></div>}
          {panel==='step'&&(current?<div className="step-editor"><label>Step name<input value={current.data.title} onChange={event=>updateStep({title:event.target.value})}/></label><label>What should happen?<textarea rows={5} value={current.data.instruction} placeholder="Describe the task and what you want back…" onChange={event=>updateStep({instruction:event.target.value,description:'Custom instructions'})}/></label><label>Who should do it?<select value={current.data.agent} onChange={event=>event.target.value==='connect'?setModal('connect'):updateStep({agent:event.target.value})}>{['Workflow default','Claude','Codex','GLM','Qwen'].map(agent=><option key={agent}>{agent}</option>)}<option value="connect">+ Connect another AI</option></select></label><div className="capabilities"><span>What can it use?</span><div>{tools.map(tool=><button key={tool} onClick={()=>setTools(old=>old.filter(item=>item!==tool))}>{tool}<Icon name="close" size={11}/></button>)}<button className="add-tool" onClick={()=>setTools(old=>old.includes('Browser')?old:[...old,'Browser'])}><Icon name="plus" size={13}/>Add tool or skill</button></div><small>Example attachments. Availability depends on the chosen AI.</small></div><label>What does success look like?<textarea rows={2} value={criteria} onChange={event=>setCriteria(event.target.value)} placeholder="Describe what should be checked…"/></label><details><summary>More options</summary><label>If this step fails<select><option>Stop and let me know</option><option>Try again</option><option>Return to an earlier step</option></select></label><label>Model<select><option>Use this AI’s default model</option><option>Choose a model…</option></select></label></details><div className="step-editor-actions"><button onClick={presetPicker}><Icon name="plus" size={14}/>Add next step</button><button className="primary" onClick={()=>setPanel(null)}>Done</button></div></div>:<p className="panel-placeholder">Select a step on the canvas to edit it.</p>)}
          {panel==='history'&&<div className="history-panel"><p>Your saved versions live here.</p><div className="history-entry"><i/><div><strong>Current draft</strong><span>Working on it now</span><small>{nodes.length} connected steps</small></div></div><div className="history-entry"><i/><div><strong>Default workflow</strong><span>Starting version</span><small>Plan, verify, implement, review</small><button onClick={()=>openTemplate('default')}>View example version</button></div></div><p className="history-note">Saving creates a new version. Work already running keeps the version it started with.</p></div>}
        </aside>}
      </div>
    </>}
    {notice&&<div className="design-toast" role="status">{notice}<button aria-label="Dismiss notification" onClick={()=>setNotice('')}><Icon name="close" size={14}/></button></div>}
    {modal&&<dialog ref={dialogRef} className="modal-scrim" onCancel={()=>setModal(null)} onClick={event=>{if(event.target===event.currentTarget)setModal(null)}}><section className="design-dialog" aria-label={modal==='rules'?'Core rules':modal==='run'?'Run preview':'Connect an AI'} onClick={event=>event.stopPropagation()}><button className="dialog-close icon-button" aria-label="Close dialog" onClick={()=>setModal(null)}><Icon name="close"/></button>{modal==='rules'?<><Icon name="lock" size={28}/><h2>Room to customize.<br/>Rules you can rely on.</h2><p>Every workflow follows your project instructions, reports actual evidence, and requires a verified plan and independent review for implementation work.</p><p>These rules stay in place when you edit a workflow or ask AI to change it.</p></>:modal==='run'?<><Icon name="play" size={28}/><h2>Ready to run</h2><p>In the product, you would choose a project and give this workflow its task here.</p><label>Project<select><option>Mission Control · example project</option></select></label><label>What should this run accomplish?<textarea rows={3} placeholder="Describe the work…"/></label><div className="simulation-note">This is a design preview. Nothing will run.</div></>:<><Icon name="plus" size={28}/><h2>Connect an AI</h2><p>Choose a provider or add your own. The product would guide you through the setup it needs.</p><div className="connect-options">{['Claude','Codex','Qwen','Grok','OpenRouter','Local model','Custom connection'].map(agent=><button key={agent} onClick={()=>setNotice(`${agent} setup is illustrative. No connection was created.`)}>{agent}<Icon name="arrow" size={14}/></button>)}</div></>}<button className="primary" onClick={()=>setModal(null)}>Back to workflow</button></section></dialog>}
  </section>
}
export default function Designs() {
  const fromHash=():Variant=>['now','a','b','c'].includes(location.hash.slice(1))?location.hash.slice(1) as Variant:'a'
  const [variant,setVariant]=useState<Variant>(fromHash)
  useEffect(()=>{const onHash=()=>setVariant(fromHash());addEventListener('hashchange',onHash);return()=>removeEventListener('hashchange',onHash)},[])
  return <><div className="comparison-bar"><div className="comparison-title"><strong>Workflow Studio</strong><span>Design comparison</span></div><nav aria-label="Design variants">{variants.map(item=><a key={item.id} href={`#${item.id}`} aria-current={variant===item.id?'page':undefined}>{item.name}</a>)}</nav><span className="preview-label"><i/>Static preview · no agents run</span></div><div className="variant-description"><span>{variants.find(item=>item.id===variant)!.description}</span><small>Same capabilities. Different starting points.</small></div><AppChrome/>{variant==='now'?<main id="studio-root"><CurrentStudio/></main>:<StudioDesign key={variant} variant={variant}/>}<footer className="source-footer"><span>{variant==='now'?'Current components, unchanged layout':'Proposed interaction · real Mission Control theme'}</span><span>Sources: <a href="/source/studio.tsx" target="_blank">client/studio.tsx</a><a href="/source/studio.css" target="_blank">studio.css</a><a href="/source/theme-tokens.css" target="_blank">theme-tokens.css</a><a href="/source/layout.tsx" target="_blank">layout.tsx</a></span></footer></>
}
