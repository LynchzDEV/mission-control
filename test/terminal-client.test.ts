import { beforeAll, describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

let code = ''
beforeAll(async () => {
  const result = await Bun.build({ entrypoints: ['client/terminal.ts'], target: 'browser', format: 'iife', write: false })
  expect(result.success).toBe(true)
  code = await result.outputs[0]!.text()
})

class Node {
  children: Node[] = []
  parentElement: Node | null = null
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  style = { setProperty() {}, order: '' }
  hidden = false
  textContent = ''
  className = ''
  value = ''
  id = ''
  title = ''
  namespaceURI = 'http://www.w3.org/2000/svg'
  tagName: string
  onclick?: (event: any) => void
  listeners = new Map<string, Array<(event: any) => void>>()
  classList = {
    add: (...names: string[]) => { this.className += ' ' + names.join(' ') },
    remove: (...names: string[]) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' ') },
    toggle: (name: string, on: boolean) => { if (on) this.classList.add(name); else this.classList.remove(name) },
  }
  constructor(tag = 'div') { this.tagName = tag.toUpperCase() }
  append(...nodes: Node[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node) } }
  appendChild(node: Node) { this.append(node); return node }
  insertBefore(node: Node, before: Node) { node.parentElement = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node) }
  replaceChildren(...nodes: Node[]) { this.children = []; this.append(...nodes) }
  replaceWith(node: Node) { if (this.parentElement) this.parentElement.insertBefore(node,this); this.remove() }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this) }
  setAttribute(key: string, value: string) { this.attrs[key] = value }
  removeAttribute(key: string) { delete this.attrs[key] }
  toggleAttribute(key: string, force: boolean) { if (force) this.setAttribute(key, ''); else this.removeAttribute(key); return force }
  hasAttribute(key: string) { return key in this.attrs }
  addEventListener(name: string, fn: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]) }
  fire(name = 'click') { const event = { preventDefault() {}, stopPropagation() {}, target: this }; if (name === 'click') this.onclick?.(event); for (const listener of this.listeners.get(name) ?? []) listener(event) }
  querySelectorAll(selector: string): Node[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')])
    if (selector === '*') return descendants
    if (selector === 'a[data-term]') return descendants.filter((node) => node.tagName === 'A' && node.dataset.term)
    if (selector === 'input.rename') return descendants.filter((node) => node.tagName === 'INPUT' && node.className === 'rename')
    if (selector.startsWith('.')) return descendants.filter(node => node.className.split(' ').includes(selector.slice(1)))
    if (selector === 'button') return descendants.filter((node) => node.tagName === 'BUTTON')
    return []
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  getBoundingClientRect() { return { width: this.hidden ? 0 : 600, height: 400, left: 0, top: 0 } }
  focus() {}
  select() {}
}

async function harness(initial: string[] = ['a', 'b'], saved?: object) {
  const nodes = new Map<string, Node>()
  for (const id of ['directory-nav', 'directory-toggle', 'term-strip', 'term-none', 'term-new', 'term-pane', 'term-msg', 'terminal-welcome', 'workspace-name', 'workspace-path', 'term-focus', 'directory-list', 'split-horizontal', 'split-vertical', 'term-reconnect', 'term-find', 'term-form', 'term-cwd', 'term-engine', 'term-model', 'term-cancel']) {
    const node = new Node(id.includes('split-') || id === 'term-focus' ? 'button' : 'div')
    node.id = id
    nodes.set(id, node)
  }
  nodes.get('directory-nav')!.hidden = true
  nodes.get('term-pane')!.append(nodes.get('terminal-welcome')!)
  nodes.get('term-strip')!.append(nodes.get('term-new')!)
  nodes.get('term-engine')!.value = 'claude'
  nodes.get('term-cwd')!.value = '/work'
  const requests: Array<{ url: string; method: string }> = []
  const state = { sessions: initial, titles:{} as Record<string,string>, failList: false, failCreate: false }
  const sockets: Socket[] = []
  const terms: Terminal[] = []
  const intervals: Array<() => void> = []
  const events: string[] = []
  const listeners = new Map<string, () => void>()
  class Socket {
    static OPEN = 1
    readyState = 1
    closed = false
    onopen?: () => void
    onclose?: (event: { code: number }) => void
    onmessage?: (event: { data: string }) => void
    onerror?: () => void
    sent: unknown[] = []
    constructor(public url: string) { sockets.push(this); queueMicrotask(() => this.onopen?.()) }
    send(data: unknown) { this.sent.push(data) }
    close() { this.closed = true; this.readyState = 3 }
  }
  class Terminal {
    disposed = false
    output = ''
    cols = 80
    rows = 24
    handler?: (event: any) => boolean
    constructor() { terms.push(this) }
    loadAddon() {}
    open() {}
    write(text: string) { this.output += text }
    dispose() { this.disposed = true }
    onData() {}
    clear() { this.output = '' }
    getSelection() { return '' }
    focus() {}
    attachCustomKeyEventHandler(fn: (event: any) => boolean) { this.handler = fn }
  }
  const storage = new Map<string, string>(saved ? [['mc.term.layout.v2',JSON.stringify(saved)]] : [])
  const context: Record<string, any> = {
    document: { hidden: false, querySelector: (selector: string) => selector.startsWith('#') ? nodes.get(selector.slice(1)) ?? null : null, createElement: (tag: string) => new Node(tag), createElementNS: (_ns:string, tag:string) => new Node(tag) },
    Terminal, FitAddon: { FitAddon: class { fit() {} } }, WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost' },
    ResizeObserver: class { observe() {}; disconnect() {} },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    fetch: async (url: string, options?: { method?: string; body?: string }) => {
      requests.push({ url, method: options?.method ?? 'GET' })
      if (options?.method === 'PATCH') state.titles[url.split('/').at(-1)!] = JSON.parse(options.body!).title
      const creating = options?.method === 'POST'
      const failed = creating ? state.failCreate : state.failList
      return { ok: !failed, status: failed ? 503 : 200, json: async () => failed ? { error: 'offline' } : { sessions: state.sessions.map((id) => ({ id, cwd: '/work', title: state.titles[id] ?? id, engine: 'claude' })) } }
    },
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), dispatchEvent: (event: { type: string }) => { events.push(event.type) },
    CustomEvent: class { constructor(public type: string, public detail: any) {} },
    requestAnimationFrame: (fn: () => void) => { fn(); return 1 }, setInterval: (fn: () => void) => { intervals.push(fn) }, setTimeout,
    TextEncoder, TextDecoder, innerWidth: 1200, confirm: () => false, console,
  }
  context.window = context
  runInNewContext(code, context)
  if (saved) listeners.get('resize')?.()
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  await flush()
  const select = (id: string) => nodes.get('term-strip')!.querySelectorAll('a[data-term]').find((tab) => tab.dataset.term === id)!.fire()
  return { resize: (width: number) => { context.innerWidth = width; listeners.get('resize')?.() }, nodes, sockets, terms, state, requests, context, intervals, events, select, flush }
}

describe('terminal client lifecycle with inert API and socket doubles', () => {
  test('switches and splits without disposing xterms, sockets, or output', async () => {
    const h = await harness()
    h.sockets[0]!.onmessage?.({ data: 'working input and output' })
    h.select('b')
    h.select('a')
    expect(h.terms).toHaveLength(2)
    expect(h.terms[0]!.output).toBe('working input and output')
    expect(h.terms.every((term) => !term.disposed)).toBe(true)
    expect(h.sockets.every((socket) => !socket.closed)).toBe(true)
    h.nodes.get('split-horizontal')!.fire()
    expect(h.nodes.get('term-pane')!.dataset.count).toBe('2')
    h.nodes.get('term-focus')!.fire()
    expect(h.nodes.get('term-pane')!.dataset.count).toBe('1')
    h.nodes.get('term-focus')!.fire()
    expect(h.nodes.get('term-pane')!.dataset.count).toBe('2')
    expect(h.events).toContain('mc:terminal-scope')
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true)
  })
  test('zero sessions never creates a PTY and failed create remains visible', async () => {
    const h = await harness([])
    expect(h.sockets).toHaveLength(0)
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true)
    expect(h.nodes.get('terminal-welcome')!.hidden).toBe(false)
    h.state.failCreate = true
    h.nodes.get('term-form')!.fire('submit')
    await h.flush()
    expect(h.nodes.get('term-msg')!.textContent).toContain('OFFLINE')
    expect(h.sockets).toHaveLength(0)
  })
  test('failed list preserves live connections; ended session removes only its own view', async () => {
    const h = await harness()
    h.nodes.get('split-horizontal')!.fire()
    h.state.failList = true
    h.intervals[0]!()
    await h.flush()
    expect(h.sockets.every((socket) => !socket.closed)).toBe(true)
    expect(h.nodes.get('term-msg')!.textContent).toContain('Existing terminals are preserved')
    h.state.failList = false
    h.state.sessions = ['b']
    h.sockets[0]!.onclose?.({ code: 4410 })
    await h.flush()
    expect(h.terms[0]!.disposed).toBe(true)
    expect(h.terms[1]!.disposed).toBe(false)
  })
  test('failed attach can reconnect explicitly without creating a PTY', async () => {
    const h = await harness(['a'])
    h.sockets[0]!.onerror?.()
    expect(h.nodes.get('term-msg')!.textContent).toContain('Reconnect')
    h.nodes.get('term-reconnect')!.fire()
    expect(h.sockets).toHaveLength(2)
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true)
  })
})

test('late callbacks from a replaced socket cannot change the active connection', async () => {
  const h = await harness(['a'])
  const old = h.sockets[0]!
  h.nodes.get('term-reconnect')!.fire()
  await h.flush()
  const message = h.nodes.get('term-msg')!.textContent
  old.onclose?.({ code: 4410 })
  old.onerror?.()
  old.onmessage?.({ data: 'stale output' })
  old.onopen?.()
  expect(h.nodes.get('term-msg')!.textContent).toBe(message)
  expect(h.terms[0]!.output).toBe('')
  expect(h.terms[1]!.disposed).toBe(false)
})
test('empty terminal commands explain their required target and Find creates no overlay', async () => {
  const h = await harness([])
  for (const id of ['term-focus','term-find','term-reconnect']) {
    h.nodes.get(id)!.fire()
    expect(h.nodes.get('term-msg')!.textContent).toContain('Open a terminal')
  }
  expect(h.nodes.get('term-pane')!.children).toHaveLength(1)
  expect(h.requests.every(request => request.method === 'GET')).toBe(true)
})

test('session activation and polling retain the double-click rename target', async () => {
  const h = await harness()
  const tab = h.nodes.get('term-strip')!.querySelectorAll('a[data-term]')[0]!
  const name = tab.querySelector('.name')!
  tab.fire()
  h.intervals[0]!()
  await h.flush()
  expect(h.nodes.get('term-strip')!.querySelectorAll('a[data-term]')[0]).toBe(tab)
  expect(tab.querySelector('.name')).toBe(name)
})

test('older terminal refresh cannot dispose a session from a newer response', async () => {
  const h = await harness(['a'])
  let resolveOld!: (value: unknown) => void
  h.context.fetch = () => new Promise(resolve => { resolveOld = resolve })
  h.intervals[0]!()
  h.context.fetch = async () => ({ok:true,json:async () => ({sessions:['a','b'].map(id => ({id,cwd:'/work',title:id,engine:'claude'}))})})
  h.intervals[0]!(); await h.flush(); h.select('b'); await h.flush()
  resolveOld({ok:true,json:async () => ({sessions:[{id:'a',cwd:'/work',engine:'claude'}]})})
  await h.flush()
  expect(h.nodes.get('term-strip')!.querySelectorAll('a[data-term]').map(tab => tab.dataset.term)).toContain('b')
  expect(h.terms.every(term => !term.disposed)).toBe(true)
})
test('connection feedback follows selection despite another socket opening', async () => {
  const h = await harness()
  h.select('b'); await h.flush(); h.select('a'); h.sockets[1]!.onopen?.()
  expect(h.nodes.get('term-msg')!.textContent).toBe('Connected · a')
  h.select('b')
  expect(h.nodes.get('term-msg')!.textContent).toBe('Connected · b')
})

test('directories toggle once at 700px and retain visibility across mobile and desktop resizing', async () => {
  const h = await harness([])
  const directory = h.nodes.get('directory-nav')!
  const toggle = h.nodes.get('directory-toggle')!
  const expectOpen = (open: boolean) => {
    expect(directory.hidden).toBe(!open)
    expect(directory.hasAttribute('data-mobile-open')).toBe(open)
    expect(toggle.attrs['aria-expanded']).toBe(String(open))
  }
  expectOpen(false)
  h.resize(700)
  toggle.fire(); expectOpen(true)
  toggle.fire(); expectOpen(false)
  toggle.fire(); expectOpen(true)
  h.resize(1200); expectOpen(true)
  toggle.fire(); expectOpen(false)
  h.resize(700); expectOpen(false)
  toggle.fire(); expectOpen(true)
  h.resize(500); expectOpen(true)
  toggle.fire(); expectOpen(false)
  h.resize(1200); expectOpen(false)
  toggle.fire(); expectOpen(true)
  h.resize(500); expectOpen(true)
  toggle.fire(); expectOpen(false)
  expect(h.requests.every(request => request.method === 'GET')).toBe(true)
})

test('initial resize preserves a saved split before sessions finish loading', async () => {
  const h = await harness(['a','b'],{ids:['a','b'],active:'b',axis:'horizontal',ratio:45,focused:false})
  expect(h.nodes.get('term-pane')!.dataset.count).toBe('2')
  expect(h.sockets).toHaveLength(2)
  const panels = h.nodes.get('term-pane')!.children.filter(node => node.className.includes('terminal-panel'))
  expect(panels.map(panel => panel.dataset.divider)).toEqual(['true','false'])
  expect(panels[0]!.querySelector('.session-emblem')).not.toBeNull()
  expect(panels[0]!.querySelector('.connection-state')!.textContent).toBe('Connected')
})
test('repeated renames use the latest persisted name, including renaming back', async () => {
  const h = await harness(['a'])
  const tab = h.nodes.get('term-strip')!.querySelector('a[data-term]')! as any
  const rename = async (value:string, expected:string) => {
    tab.onkeydown({key:'F2',preventDefault(){}})
    const input = tab.querySelector('input.rename')
    expect(input.value).toBe(expected)
    input.value = value
    input.onkeydown({key:'Enter',preventDefault(){},stopPropagation(){}})
    await h.flush()
    expect(h.state.titles.a).toBe(value)
    expect(tab.querySelector('.name').textContent).toBe(value)
  }
  await rename('Second name','a')
  await rename('a','Second name')
})

test('four panes can change arrangement without adding another session', async () => {
  const h = await harness(['a','b','c','d'],{ids:['a','b','c','d'],active:'a',axis:'horizontal',ratio:50,focused:false})
  h.nodes.get('split-vertical')!.fire()
  expect(h.nodes.get('term-pane')!.dataset.axis).toBe('vertical')
  expect(h.nodes.get('term-pane')!.dataset.count).toBe('4')
  h.nodes.get('split-horizontal')!.fire()
  expect(h.nodes.get('term-pane')!.dataset.axis).toBe('horizontal')
  expect(h.sockets).toHaveLength(4)
})
