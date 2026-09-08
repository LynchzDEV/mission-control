import { beforeAll, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
let code = ''
beforeAll(async () => { const result = await Bun.build({ entrypoints:['client/work.ts'],target:'browser',format:'iife',write:false }); expect(result.success).toBe(true); code = await result.outputs[0]!.text() })
class Element {
  children: Element[] = []
  dataset: Record<string,string> = {}
  attrs: Record<string,string> = {}
  textContent = ''; className = ''; value = ''; type = ''; hidden = false; disabled = false; checked = false; open = false
  ontoggle?: () => void
  onclick?: () => void; oninput?: () => void; onchange?: () => void; onsubmit?: (event: { preventDefault(): void }) => Promise<void>
  remove() {}
  get firstChild() { return this.children[0] ?? null }
  contains(node: Element): boolean { return this.children.some(child => child === node || child.contains(node)) }
  appendChild(node: Element) { this.append(node); return node }
  append(...nodes: Element[]) { this.children.push(...nodes) }
  replaceChildren(...nodes: Element[]) { this.children = nodes }
  setAttribute(key: string,value: string) { this.attrs[key] = value }
  addEventListener(name: string, callback: () => void) { if (name === 'click') this.onclick = callback }
}
async function harness(compose: boolean, failure = false, threads = false, options: { requested?: string; deferInitial?: boolean } = {}) {
  const nodes = new Map<string,Element>()
  for (const name of ['work-view','work-list','work-selected','work-filter','work-search','work-status','dispatch-msg','draft-clear']) nodes.set('#'+name,new Element())
  nodes.get('#work-view')!.dataset.mode = compose ? 'compose' : 'all'; nodes.get('#work-filter')!.value = 'all'
  const fields = new Map<string,Element>()
  for (const name of ['prompt','label','cwd','engine','model','worktree']) fields.set(name,new Element())
  fields.get('worktree')!.type = 'checkbox'; fields.get('worktree')!.checked = true
  const submit = new Element()
  const form = Object.assign(new Element(), { elements:{ namedItem:(name:string) => fields.get(name) }, querySelector:() => submit, reset:() => {} })
  if (compose) nodes.set('#dispatch-form',form)
  const storage = new Map<string,string>([['mc.job.draft.v1',JSON.stringify({prompt:'Saved prompt',cwd:'/repo',worktree:false})]])
  const requests: string[] = []
  const jobs = threads ? ['a','b'].map((id, index) => ({id,threadRoot:id,label:id,cwd:'/repo',engine:'codex',status:'done',startedAt:2-index,endedAt:4-index,reviewedAt:null})) : []
  const ticks: Array<() => void> = []
  const streams: Array<{url:string;closed:boolean;onmessage?: (event:{data:string}) => void}> = []
  let resolveInitial!: () => void
  const initial = options.deferInitial ? new Promise<void>(resolve => { resolveInitial = resolve }) : Promise.resolve()
  let resolvePost: ((value: unknown) => void) | undefined
  const response = (ok:boolean,data:unknown) => ({ok,status:ok ? 200 : 503,json:async () => data})
  const listeners = new Map<string,(event:any) => void>()
  const parentWindow = {}
  const context = {
    addEventListener:(name:string,callback:any) => listeners.set(name,callback),window:{parent:parentWindow},
    document:{hidden:false,querySelector:(selector:string) => nodes.get(selector) ?? null,createElement:() => new Element()},
    location:{search:options.requested ? '?job=' + options.requested : '',origin:'http://localhost'},URLSearchParams,Date,console,
    localStorage:{getItem:(key:string) => storage.get(key) ?? null,setItem:(key:string,value:string) => storage.set(key,value),removeItem:(key:string) => storage.delete(key)},
    FormData:class { *[Symbol.iterator]() { for (const [name,field] of fields) if (field.type !== 'checkbox' || field.checked) yield [name,field.type === 'checkbox' ? 'on' : field.value] } },
    fetch:async (url:string,options?:{method?:string}) => { requests.push(options?.method ?? 'GET'); if (options?.method === 'POST') return new Promise(resolve => { resolvePost = resolve }); if (!url.endsWith('/thread')) await initial; return response(!failure,failure ? {error:'offline'} : url.endsWith('/thread') ? {messages:[],canReply:true,running:false,engine:'codex'} : url.includes('/jobs') ? {jobs} : {sessions:{}}) },
    EventSource:class { closed = false; constructor(public url:string) { streams.push(this) } close() { this.closed = true } },
    setInterval:(tick:() => void) => { ticks.push(tick); return 1 },clearTimeout:() => {},setTimeout:() => 1,
  }
  runInNewContext(code,context)
  const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve() }
  await flush()
  return { resolveInitial, nodes,fields,form,submit,storage,requests,jobs,streams,poll:async () => { ticks.forEach(tick => tick()); await flush() },flush,newJob:() => listeners.get('message')?.({origin:'http://localhost',source:parentWindow,data:{type:'mc:new-job'}}),succeedPost:() => resolvePost?.(response(true,{job:{id:'new'}})),failPost:() => resolvePost?.(response(false,{error:'dispatch offline'})) }
}
test('open raw output follows new thread jobs and ignores the previous stream', async () => {
  const h = await harness(false, false, true)
  const log = h.nodes.get('#work-selected')!.children.find(node => node.className === 'work-log')!
  const output = log.children[1]!
  log.open = true; log.ontoggle?.()
  const first = h.streams[0]!
  first.onmessage?.({data:'First job'})
  h.jobs.push({...h.jobs[0]!,id:'reply',threadRoot:'a',startedAt:5})
  await h.poll()
  expect(h.streams.map(stream => stream.url)).toEqual(['/api/jobs/a/stream','/api/jobs/reply/stream'])
  expect(first.closed).toBe(true)
  first.onmessage?.({data:'Stale output'})
  h.streams[1]!.onmessage?.({data:'New job'})
  expect(output.textContent).toBe('New job\n')
  log.open = false; log.ontoggle?.(); await h.poll()
  expect(h.streams[1]!.closed).toBe(true)
  expect(h.streams).toHaveLength(2)
})
test('failed work requests show errors and never invent work', async () => {
  const h = await harness(false,true)
  expect(h.nodes.get('#work-status')!.textContent).toContain('offline')
  expect(h.nodes.get('#work-list')!.textContent).toBe('Work unavailable')
  expect(h.nodes.get('#work-list')!.children).toHaveLength(1)
  expect(h.requests).toEqual(['GET','GET'])
})
test('empty work has explicit feedback', async () => {
  const h = await harness(false)
  expect(h.nodes.get('#work-list')!.children[0]!.textContent).toBe('No work matches this view.')
  expect(h.nodes.get('#work-selected')!.children[0]!.textContent).toBe('No work selected')
})
test('draft survives failed submission and duplicate pending submits are blocked', async () => {
  const h = await harness(true)
  expect(h.fields.get('prompt')!.value).toBe('Saved prompt')
  expect(h.fields.get('worktree')!.checked).toBe(false)
  h.fields.get('prompt')!.value = 'Edited prompt'; h.form.oninput?.()
  expect(JSON.parse(h.storage.get('mc.job.draft.v1')!).prompt).toBe('Edited prompt')
  const pending = h.form.onsubmit!({preventDefault(){}})
  await h.flush()
  expect(h.submit.disabled).toBe(true)
  await h.form.onsubmit!({preventDefault(){}})
  expect(h.requests.filter(method => method === 'POST')).toHaveLength(1)
  h.failPost(); await pending
  expect(h.submit.disabled).toBe(false)
  expect(h.nodes.get('#dispatch-msg')!.textContent).toContain('dispatch offline')
  expect(JSON.parse(h.storage.get('mc.job.draft.v1')!).prompt).toBe('Edited prompt')
})

test('cached composer reopens on same-origin New job request without losing draft', async () => {
  const h = await harness(true)
  h.form.hidden = true
  h.newJob()
  expect(h.form.hidden).toBe(false)
  expect(h.fields.get('prompt')!.value).toBe('Saved prompt')
})

test('successful deferred creation preserves newer unsent form edits and storage', async () => {
  const h = await harness(true)
  const pending = h.form.onsubmit!({preventDefault(){}})
  h.fields.get('prompt')!.value = 'Next job draft'; h.form.oninput?.()
  h.succeedPost(); await pending
  expect(h.fields.get('prompt')!.value).toBe('Next job draft')
  expect(JSON.parse(h.storage.get('mc.job.draft.v1')!).prompt).toBe('Next job draft')
  expect(h.submit.disabled).toBe(false)
})

test('deferred reply retains newer input/storage and pending state across thread switches', async () => {
  const h = await harness(false, false, true)
  const selected = h.nodes.get('#work-selected')!
  const reply = () => selected.children.find(node => node.className === 'reply-composer')!
  let composer = reply(), input = composer.children[0]!
  input.value = 'Submitted'; input.oninput?.()
  const pending = composer.onsubmit!({preventDefault(){}})
  h.nodes.get('#work-list')!.children[1]!.onclick?.(); await h.flush()
  h.nodes.get('#work-list')!.children[0]!.onclick?.(); await h.flush()
  composer = reply(); input = composer.children[0]!
  expect(composer.children[1]!.disabled).toBe(true)
  input.value = 'New unsent edit'; input.oninput?.()
  await composer.onsubmit!({preventDefault(){}})
  expect(h.requests.filter(method => method === 'POST')).toHaveLength(1)
  h.succeedPost(); await pending; await h.flush()
  expect(input.value).toBe('New unsent edit')
  expect(h.storage.get('mc.reply.a')).toBe('New unsent edit')
  expect(composer.children[1]!.disabled).toBe(false)
})

test('deferred initial load preserves an older requested thread then follows filtering and empty selection', async () => {
  const h = await harness(false, false, true, { requested: 'b', deferInitial: true })
  expect(h.nodes.get('#work-list')!.children[0]!.textContent).toBe('No work matches this view.')
  h.nodes.get('#work-search')!.oninput?.()
  h.resolveInitial(); await h.flush()
  const list = h.nodes.get('#work-list')!
  expect(list.children.map(entry => entry.children[0]!.textContent)).toEqual(['a', 'b'])
  expect(list.children.map(entry => entry.attrs['aria-pressed'])).toEqual(['false', 'true'])
  expect(h.nodes.get('#work-selected')!.children[0]!.children[0]!.textContent).toBe('b')
  const search = h.nodes.get('#work-search')!
  search.value = 'a'; search.oninput?.(); await h.flush()
  expect(list.children[0]!.attrs['aria-pressed']).toBe('true')
  search.value = 'missing'; search.oninput?.(); await h.flush()
  expect(h.nodes.get('#work-selected')!.children[0]!.textContent).toBe('No work selected')
  search.value = ''; search.oninput?.(); await h.flush()
  expect(list.children.map(entry => entry.attrs['aria-pressed'])).toEqual(['true', 'false'])
})
