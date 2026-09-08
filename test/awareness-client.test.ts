import { beforeAll, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
let code = ''
beforeAll(async () => { const built = await Bun.build({entrypoints:['client/awareness.ts'],target:'browser',format:'iife'}); expect(built.success).toBe(true); code = await built.outputs[0]!.text() })
class Node {
  children: Node[] = []; dataset: Record<string,string> = {}; value = ''; textContent = ''; className = ''; hidden = false; disabled = false; parent: Node | null = null
  onchange?: () => void
  onclick?: () => void
  open = true
  attributes: Record<string,string> = {}; title = ''; namespaceURI = 'http://www.w3.org/2000/svg'
  style = {setProperty: (key:string, value:string) => { this.attributes[key] = value }}
  rect = {left:0,top:0,right:100,width:100,height:20}
  getBoundingClientRect() { return this.rect }
  setAttribute(key:string, value:string) { this.attributes[key] = value }
  get firstChild() { return this.children[0] ?? null }
  get nextSibling() { const nodes = this.parent?.children ?? []; return nodes[nodes.indexOf(this)+1] ?? null }
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  appendChild(node: Node) { this.append(node) }
  replaceChildren(...nodes: Node[]) { this.children = []; this.append(...nodes) }
  insertBefore(node: Node, cursor: Node | null) { node.remove(); node.parent = this; const index = cursor ? this.children.indexOf(cursor) : this.children.length; this.children.splice(index,0,node) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this) }
  replaceWith(node: Node) { this.parent?.insertBefore(node,this); this.remove() }
  after(node: Node) { this.parent?.insertBefore(node,this.nextSibling) }
  closest() { return this.parent ?? this }
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function harness(legacy = false) {
  const nodes = new Map(['awareness-select','awareness-flow','awareness-status','active-agent-windows','active-agent-status','active-agents-left','active-agents-right','awareness-open'].map(id => ['#'+id,new Node()]))
  const main = new Node(), row = new Node(), legacyWindow = new Node()
  main.append(row); row.append(nodes.get('#awareness-flow')!, legacyWindow)
  if (legacy) {
    for (const id of ['active-agent-windows','active-agent-status','active-agents-left','active-agents-right']) nodes.delete('#'+id)
    nodes.set('.awareness-row .agent-window', legacyWindow)
  }
  const listeners = new Map<string,(event:any) => void>(), intervals: Array<() => void> = [], timers = new Map<number,() => void>()
  const events: any[] = [], reads: string[] = []
  const pending: Array<() => void> = []
  const observers: Array<{callback:() => void; disconnected:boolean}> = []
  let timerId = 0
  const state = {jobs:['a','b','c'].map(id => ({id,threadRoot:id,label:id,terminalId:'terminal',cwd:'/repo',engine:'codex',status:'running',startedAt:1,endedAt:null})), flows:{} as Record<string,unknown>, messages:[] as Record<string,unknown>[], failed:false, feedFailed:false, delayFeed:false}
  runInNewContext(code, {
    ResizeObserver:class { disconnected = false; constructor(public callback:() => void) { observers.push(this) } observe() {} disconnect() { this.disconnected = true } },
    document:{hidden:false,createElementNS:() => new Node(),querySelector:(selector:string) => nodes.get(selector) ?? null,createElement:() => {
      const node = new Node()
      Object.defineProperty(node,'id',{set:(id:string) => nodes.set('#'+id,node)})
      return node
    }},
    location:{search:''},URLSearchParams,Date,
    CustomEvent:class { constructor(public type:string, public detail:any) { this.detail = detail.detail } },
    addEventListener:(name:string,fn:any) => listeners.set(name,fn),dispatchEvent:(event:any) => events.push(event),
    setInterval:(fn:() => void) => intervals.push(fn),setTimeout:(fn:() => void) => { timers.set(++timerId,fn); return timerId },clearTimeout:(id:number) => timers.delete(id),
    fetch:async (url:string) => {
      const thread = url.endsWith('/thread'); if (thread) reads.push(url)
      if (thread && state.delayFeed) await new Promise<void>(resolve => pending.push(resolve))
      const failed = thread ? state.feedFailed : state.failed
      return {ok:!failed,status:failed ? 503 : 200,json:async () => thread ? {messages:state.messages,canReply:true,running:true,engine:'codex'} : url === '/api/jobs' ? {jobs:state.jobs} : {sessions:state.flows}}
    },
  })
  return {nodes, state, observers, timers, reads, events, pending, main, row, legacyWindow,
    scope:async (id:string|null = 'terminal') => { listeners.get('mc:terminal-scope')!({detail:{id,cwd:id ? '/repo' : null}}); await flush() },
    poll:async () => { intervals[0]!(); await flush() },
    cards:() => ['left','right'].flatMap(side => nodes.get('#active-agents-'+side)!.children),
  }
}
test('the running server single-window markup upgrades without restarting terminals', async () => {
  const h = harness(true); await flush(); await h.scope()
  expect(h.row.children).toContain(h.nodes.get('#active-agent-windows'))
  expect(h.row.children).not.toContain(h.legacyWindow)
  expect(h.cards()).toHaveLength(3)
  expect(h.nodes.get('#active-agent-status')!.textContent).toBe('3 active agents')
})
test('all active cards retain DOM, collapse and flow independence; drawer uses current metadata', async () => {
  const h = harness(); await flush()
  expect(h.cards()).toHaveLength(0)
  await h.scope()
  expect(h.cards()).toHaveLength(3)
  const cards = h.cards(), a = cards.find(card => card.dataset.thread === 'a')!
  const feed = a.children[1]!.children[0]!.children[0]
  a.open = false
  const select = h.nodes.get('#awareness-select')!
  select.value = 'b'; select.onchange!(); await h.poll(); await h.scope()
  expect(select.value).toBe('b'); expect(h.cards()).toEqual(cards)
  expect(a.open).toBe(false); expect(a.children[1]!.children[0]!.children[0]).toBe(feed)
  h.state.jobs[0]!.label = 'Renamed'
  await h.poll()
  a.children[1]!.children[1]!.children[1]!.onclick!()
  expect(h.events[0].detail).toEqual({id:'a',label:'Renamed',engine:'codex',elapsed:'running'})
})
test('scope, completion, removal and same-thread new activity replace only the correct feeds', async () => {
  const h = harness(); await flush(); await h.scope()
  const a = h.cards().find(card => card.dataset.thread === 'a')!
  const old = a.children[1]!.children[0]!.children[0]!
  h.state.jobs[0]!.id = 'a-reply'
  await h.poll()
  expect(h.cards()).toContain(a)
  expect(a.children[1]!.children[0]!.children[0]).not.toBe(old)
  h.state.jobs[0]!.status = 'done'
  h.state.jobs = h.state.jobs.filter(job => job.id !== 'b')
  await h.poll()
  expect(h.cards().map(card => card.dataset.thread)).toEqual(['c'])
  await h.scope('other')
  expect(h.cards()).toHaveLength(0); expect(h.timers.size).toBe(0)
  await h.scope(); expect(h.cards()).toHaveLength(1)
  await h.scope(null); expect(h.cards()).toHaveLength(0); expect(h.timers.size).toBe(0)
})
test('feed errors retry and list failures stop feeds then recover with collapse preserved', async () => {
  const h = harness(); await flush(); await h.scope()
  const card = h.cards()[0]!, host = card.children[1]!.children[0]!
  card.open = false
  h.state.feedFailed = true
  await h.poll()
  expect(host.children[0]!.dataset.state).toBe('error')
  h.state.feedFailed = false
  await h.poll()
  expect(host.children[0]!.dataset.state).toBe('empty')
  h.state.failed = true; await h.poll()
  expect(h.timers.size).toBe(0); expect(host.children).toHaveLength(0)
  expect(h.nodes.get('#active-agent-status')!.textContent).toContain('unavailable')
  card.children[1]!.children[1]!.children[1]!.onclick!()
  expect(h.events[0]?.detail.id).toBe(card.dataset.thread)
  h.state.failed = false; await h.poll()
  expect(h.cards()).toContain(card); expect(card.open).toBe(false)
  expect(host.children[0]!.dataset.state).toBe('empty'); expect(h.timers.size).toBe(3)
})

test('late responses from stopped feeds cannot populate a new scope or replacement activity', async () => {
  const h = harness(); await flush()
  h.state.delayFeed = true
  await h.scope()
  const old = h.cards()[0]!.children[1]!.children[0]!.children[0]!
  expect(h.pending).toHaveLength(3)
  await h.scope('other')
  h.state.delayFeed = false
  await h.scope()
  const fresh = h.cards()[0]!.children[1]!.children[0]!.children[0]!
  for (const resolve of h.pending) resolve()
  await flush()
  expect(old.dataset.state).toBeUndefined()
  expect(fresh.dataset.state).toBe('empty')
  expect(h.timers.size).toBe(3)
})

test('manual branches render measured SVG, preserve nodes on polling, and release old observers', async () => {
  const h = harness(); await flush()
  h.state.flows = {a:{plan:{next:'Long technical next action stays in the tooltip',steps:[
    {title:'Direction',assignee:'user',status:'done'},
    {title:'Components',assignee:'codex',status:'active'},
    {title:'Visual check',assignee:'glm',status:'active'},
    {title:'Your review',assignee:'user',status:'pending'},
  ]}}}
  await h.poll()
  const flow = h.nodes.get('#awareness-flow')!, graph = flow.children[0]!, svg = graph.children[0]!
  expect(flow.tabIndex).toBe(0)
  expect(graph.children[1]!.children[0]!.attributes.role).toBe('group')
  expect(graph.children.slice(1).map(column => column.children.length)).toEqual([1,2,1])
  expect(svg.attributes['aria-hidden']).toBe('true')
  expect(svg.children.filter(path => path.attributes.class !== 'signal')).toHaveLength(4)
  expect(svg.children.filter(path => path.attributes.class === 'signal').map(path => path.attributes['data-engine'])).toEqual(['codex','glm','codex','glm'])
  const status = h.nodes.get('#awareness-status')!
  expect(status.textContent).toBe('Work flow · 1 agent working')
  expect(status.title).toBe('Long technical next action stays in the tooltip')
  const source = graph.children[1]!.children[0]!, target = graph.children[2]!.children[0]!
  graph.rect = {left:10,top:20,right:810,width:800,height:100}
  source.rect = {left:10,top:50,right:110,width:100,height:40}
  source.children[0]!.rect = {left:10,top:60,right:30,width:20,height:20}
  target.children[0]!.rect = {left:310,top:30,right:330,width:20,height:20}
  const observer = h.observers.at(-1)!
  observer.callback()
  expect(svg.attributes.viewBox).toBe('0 0 800 100')
  expect(svg.children[0]!.attributes.d).toBe('M20 50H195Q220 50 220 20H300')
  target.children[0]!.rect.left = 410
  observer.callback()
  expect(svg.children[0]!.attributes.d).toBe('M20 50H295Q320 50 320 20H400')
  await h.poll()
  expect(flow.children[0]).toBe(graph)
  expect(h.observers.at(-1)).toBe(observer)
  ;(h.state.flows.a as any).plan.steps[1].status = 'done'
  await h.poll()
  expect(flow.children[0]).toBe(graph)
  expect(graph.children[2]!.children[0]!.className).toContain('done')
  expect(graph.children.slice(1).map(column => column.children.length)).toEqual([1,2,1])
  h.state.flows = {a:{plan:{steps:[]}}}; h.state.jobs = []; await h.poll()
  expect(observer.disconnected).toBe(true)
  expect(flow.children[0]!.textContent).toBe('No steps reported for this work.')
  h.state.flows = {}; h.state.jobs = []; await h.poll()
  expect(flow.children[0]!.textContent).toBe('Select a session or create work to see its flow.')
  await h.poll()
  expect(flow.children[0]!.textContent).toBe('Select a session or create work to see its flow.')
})

test('compact activity excludes old turns and exposes a failed tool after a thought', async () => {
  const h = harness(); await flush(); await h.scope()
  const card = h.cards().find(card => card.dataset.thread === 'a')!
  const feed = card.children[1]!.children[0]!.children[0]!
  h.state.messages = [{jobId:'old',kind:'text',text:'Old completed work'}, {jobId:'a',kind:'thinking',text:'Inspecting files'}, {jobId:'a',kind:'tool',title:'Read',detail:'missing.ts',result:'File not found',isError:true}]
  await h.poll()
  const rows = feed.children[0]!
  expect(rows.children[0]!.children[0]!.textContent).toBe('Read')
  expect(rows.children[1]!.textContent).toBe('Tool failed: File not found')
  h.state.messages = [{jobId:'old',kind:'text',text:'Old completed work'}]
  await h.poll()
  expect(rows.children).toHaveLength(1)
  expect(rows.children[0]!.textContent).toBe('Waiting for activity…')
})
