import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM, VirtualConsole } from 'jsdom'

import { ShellPage } from '../server/views/shell'
import type { InstalledPlugin } from '../client/plugins/types'

const markup = `<div class="sb-shell" id="sb-shell">
  <aside id="sidebar" class="sb" aria-label="Chats and terminals">
    <div class="sb-open">
      <button type="button" id="new-chat" class="sb-new">New chat</button>
      <nav id="sidebar-list" class="sb-list" aria-label="Recent chats and terminals"></nav>
      <div class="sb-foot"><button type="button" id="all-history" class="sb-link">All history</button><button type="button" id="open-marketplace" class="sb-link">Marketplace</button></div>
    </div>
    <div class="sb-strip"><nav id="sidebar-mini" class="sb-mini-list" aria-label="Live chats and terminals"></nav></div>
  </aside>
  <main class="canvas">
    <header class="toolbar"><nav aria-label="Session activity"><span id="agents-count" class="count" hidden></span></nav></header>
    <div class="workspace">
    <div class="chat-container">
    <section id="flow" class="inline-flow" inert></section>
    <div class="toast" id="toast" role="status" hidden></div>
    <section id="live" class="live-workspace" aria-label="Live terminals" hidden>
      <div class="live-main" id="live-main">
        <template id="term-bar"><div class="term-bar"><span class="term-bar-logo"><img alt=""></span><span class="term-bar-name"></span><button class="term-bar-status" type="button" data-kind="muted" disabled><i></i><span>Connecting…</span></button><span class="term-bar-sep"></span><button class="term-bar-find" type="button" aria-label="Find in this terminal"><svg aria-hidden="true"><use href="#search-icon"/></svg></button><div class="find" id="find" hidden><input id="find-input" type="text"><span id="find-count" role="status"></span><button class="round" id="find-prev" type="button"></button><button class="round" id="find-next" type="button"></button><button class="round" id="find-close" type="button"></button></div></div></template>
        <div class="drop-stage" id="drop-stage" data-dragging="false"><div id="live-stage" class="live-stage"></div><div class="drop-zone right" id="drop-right" data-hot="false">Drop to open beside</div><div class="drop-zone bottom" id="drop-bottom" data-hot="false">Drop to open below</div><div class="drop-over" id="drop-over" hidden><strong id="drop-over-title">Drop to add files</strong></div></div>
        <div id="term-park" hidden></div>
      </div>
    </section>
    <div class="stage">
      <section id="welcome" class="welcome" aria-labelledby="welcome-title"><h1 id="welcome-title">A little space to build.</h1></section>
      <section id="history" class="history content-width" aria-labelledby="history-title" hidden><header class="history-heading"><h1 id="history-title">History <span id="history-count"></span></h1></header><div class="history-list" id="history-list"></div></section>
      <section id="conversation" class="conversation content-width" aria-label="Conversation" hidden>
        <div id="messages" class="chat" role="log" aria-live="polite"></div>
        <div id="queued" class="queued" aria-label="Queued messages"></div>
      </section>
      <section id="studio" class="studio" aria-label="Workflow Studio" hidden><div id="studio-root"></div></section>
      <section id="plugin" class="studio" aria-label="Plugin" hidden></section>
      <section id="marketplace" class="studio" aria-label="Marketplace" hidden></section>
    </div>
    <div class="composer-area content-width">
      <form id="composer" class="composer"><div class="composer-banner" id="composer-banner" hidden><span id="composer-banner-text"></span><button type="button" class="text-button" id="composer-banner-cancel">Cancel</button></div><textarea id="message" rows="1" placeholder="Write a message here…" aria-label="Message"></textarea><span class="ctx-meter" id="ctx-meter" hidden><span id="ctx-text"></span></span><button type="submit" class="round send" aria-label="Send message"><svg><use href="#arrow-icon"/></svg></button></form>
    </div>
    </div>
    <dialog id="live-launch" class="access-dialog flat" aria-labelledby="live-launch-title">
      <p id="live-error" role="status"></p>
      <form id="live-create" class="field-stack" hidden>
        <label>Workflow<select id="live-workflow" disabled></select></label>
        <div id="live-engine-fields" class="launcher-fields"><label>Engine<select id="live-engine"></select></label><label>Model<input id="live-model" list="live-models"><datalist id="live-models"></datalist></label></div>
        <label>Working directory<input id="live-cwd" list="live-cwd-recents"><datalist id="live-cwd-recents"></datalist></label>
        <button id="live-submit" class="pill">Open terminal</button>
      </form>
    </dialog>
  </div>
  </main>
  <dialog id="plugin-launch" class="access-dialog flat" aria-labelledby="plugin-launch-title">
    <header class="dialog-heading"><div><h2 id="plugin-launch-title">Start chat</h2><p class="muted" id="plugin-launch-sub"></p></div><form method="dialog"><button class="round" type="submit" aria-label="Close"><svg><use href="#close-icon"/></svg></button></form></header>
    <p class="muted" id="plugin-launch-error" role="status"></p>
    <div class="mk-ctx" id="plugin-launch-ctx" hidden><span><svg><use href="#file-icon"/></svg></span><strong id="plugin-launch-ctx-name"></strong><small id="plugin-launch-ctx-size"></small></div>
    <form id="plugin-launch-form" class="field-stack">
      <div class="launcher-fields plugin-launch-fields"><label class="mk-field">AI<select id="plugin-launch-engine"></select></label><label class="mk-field">Model<input id="plugin-launch-model" list="plugin-launch-models" placeholder="Engine default" maxlength="100" autocomplete="off"><datalist id="plugin-launch-models"></datalist></label></div>
      <label class="mk-field">Working directory<input id="plugin-launch-cwd" list="plugin-launch-recents" required autocomplete="off"><datalist id="plugin-launch-recents"></datalist></label>
      <label class="mk-field">First message (optional)<input id="plugin-launch-message" placeholder="Read the task, then propose a plan"><small class="muted" id="plugin-launch-message-hint" hidden>Type a first message</small></label>
      <button id="plugin-launch-start" class="pill">Start chat</button>
    </form>
  </dialog>
  <template id="team-card"><article class="team-card"><header><strong>Team for this task</strong><span class="muted"></span></header><ol></ol></article></template>`

const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', () => {})
const { window } = new JSDOM(`<body>${markup}</body>`, { url: 'http://127.0.0.1:7777/', pretendToBeVisual: true, virtualConsole })
const doc = window.document

type Sent = { url: string; method: string; body: Record<string, unknown> | null }
const sent: Sent[] = []
const realFetch = globalThis.fetch
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
// client modules register quiet:* listeners on the shared global bus, which outlives this file; route them to a private bus
const bus = new EventTarget()
const realBus = {
  addEventListener: globalThis.addEventListener.bind(globalThis),
  removeEventListener: globalThis.removeEventListener.bind(globalThis),
  dispatchEvent: globalThis.dispatchEvent.bind(globalThis),
}
const clipboardWrites: string[] = []
let clipboardResolves = true
let installedPlugins: InstalledPlugin[] = []
let marketplaceSyncOk = true
let previewBody: Record<string, unknown> = {}
let updateResponses: Array<{ status: number; body: Record<string, unknown> }> = []
let updateGate: Promise<void> | null = null
let terminalCreate: (() => Response) | null = null

const providers = { providers: [{ id: 'claude', name: 'Claude', models: ['opus', 'sonnet'] }, { id: 'glm', name: 'GLM', models: ['glm-5.3'] }] }
let catalogName = 'KlangTech marketplace'
let addLinkReply: { status: number; body: Record<string, unknown> } = { status: 200, body: { kind: 'marketplace' } }
let brokenMarketplace: { marketplace: string; error: string } | null = null
const catalogBody = () => ({ entries: [...(brokenMarketplace ? [brokenMarketplace] : []), { marketplace: 'https://github.com/LynchzDEV/mc-marketplace', name: catalogName, plugins: [{ id: 'hello-board', repo: 'https://github.com/LynchzDEV/mc-plugin-template', ref: 'v2.0.0', name: 'Hello board', description: 'Template: a trusted plugin', runtime: 'trusted' }], skipped: [] }] })

const reply = (request: Sent): Response => {
  const { url, method } = request
  if (method === 'GET' && url === '/api/history') return Response.json({ items: [{ kind: 'chat', id: 'c1', title: 'Chat one', updatedAt: Date.now(), project: null, running: false, agents: [] }] })
  if (method === 'GET' && url === '/api/plugins') return Response.json({ plugins: installedPlugins })
  if (method === 'GET' && url === '/api/plugins/catalog') return Response.json(catalogBody())
  if (method === 'POST' && url === '/api/plugins/add-link') return Response.json(addLinkReply.body, { status: addLinkReply.status })
  if (method === 'DELETE' && url === '/api/plugins/marketplaces') { brokenMarketplace = null; return Response.json({ marketplaces: [] }) }
  if (method === 'GET' && url === '/api/providers') return Response.json(providers)
  if (method === 'GET' && url === '/api/terminals') return Response.json({ sessions: [] })
  if (method === 'POST' && url === '/api/jobs') return Response.json({ id: 'job-9' })
  if (method === 'GET' && url.startsWith('/api/jobs/') && url.endsWith('/thread')) return Response.json({ error: 'no such chat' }, { status: 404 })
  if (method === 'POST' && url === '/api/terminals') return terminalCreate === null ? Response.json({ id: 't-1', engine: 'claude', cwd: '/w', title: 'T' }) : terminalCreate()
  if (method === 'POST' && url === '/api/plugins/marketplaces') {
    return marketplaceSyncOk ? Response.json({ marketplaces: [{ url: 'https://github.com/LynchzDEV/mc-marketplace' }] }) : Response.json({ error: "Couldn't reach this marketplace: no such host" }, { status: 400 })
  }
  if (method === 'POST' && url === '/api/plugins/preview') return Response.json(previewBody)
  if (method === 'POST' && url === '/api/plugins/hello-board/update') {
    const answer = (): Response => {
      const next = updateResponses.shift()
      return next === undefined ? Response.json({ plugin: installedPlugins[0] }) : Response.json(next.body, { status: next.status })
    }
    return updateGate === null ? answer() : updateGate.then(answer)
  }
  if (method === 'POST' && url === '/api/plugins/hello-board/context') return Response.json({ path: '/x/y.md' })
  return Response.json({})
}

const helloPlugin: InstalledPlugin = {
  id: 'hello-board', name: 'Hello board', version: '0.1.0', description: 'Template: a trusted plugin',
  runtime: 'isolated', source: { repo: 'https://github.com/LynchzDEV/mc-plugin-template', ref: 'v0.1.0', marketplace: 'https://github.com/LynchzDEV/mc-marketplace' },
  commit: '111111', permissions: { sessions: ['chat'], settings: true }, settingsFields: [], icon: 'icon.svg', screen: 'src/screen.ts',
  enabled: true, installedAt: '2026-10-04T10:00:00Z', updatedAt: '2026-10-04T10:00:00Z',
}
const clickupPlugin: InstalledPlugin = {
  id: 'clickup-board', name: 'ClickUp board', version: '1.0.0', description: 'See a ClickUp board',
  runtime: 'isolated', source: { repo: 'https://github.com/LynchzDEV/mc-plugin-clickup', ref: 'v1.0.0' },
  commit: '999999', permissions: { network: ['api.clickup.com'], sessions: ['chat', 'terminal'], settings: true },
  settingsFields: [{ key: 'token', label: 'ClickUp token', type: 'secret' }], screen: 'src/screen.ts',
  enabled: true, installedAt: '2026-10-04T10:00:00Z', updatedAt: '2026-10-04T10:00:00Z',
}

let hostApi: typeof import('../client/plugins/host-api')
let launchDialog: typeof import('../client/plugins/launch-dialog')
let pluginScreen: typeof import('../client/plugins/plugin-screen')

const flush = async (times = 3): Promise<void> => { for (let index = 0; index < times; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const byId = (id: string) => doc.getElementById(id) as HTMLElement
const input = (id: string) => doc.getElementById(id) as HTMLInputElement
const buttonNamed = (text: string, root: ParentNode = doc): HTMLButtonElement => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
const detailOf = <T,>(event: Event): T => (event as CustomEvent<T>).detail

beforeAll(async () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof matchMedia
  const dialogProto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>
  dialogProto.showModal = function (this: HTMLDialogElement): void { this.open = true }
  dialogProto.close = function (this: HTMLDialogElement): void {
    if (!this.open) return
    this.open = false
    this.dispatchEvent(new window.Event('close'))
  }
  Object.assign(globalThis, {
    window, document: doc, Node: window.Node, HTMLElement: window.HTMLElement, HTMLCanvasElement: window.HTMLCanvasElement,
    Option: window.Option, localStorage: window.localStorage, location: window.location, history: window.history,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame ?? window.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame ?? window.cancelAnimationFrame,
    ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} },
    setInterval: ((handler: () => void, ms: number) => ({ handler, ms })) as unknown as typeof setInterval,
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus),
  })
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { clipboardWrites.push(text); if (!clipboardResolves) throw new Error('denied'); return undefined } } })
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const request = { url: String(url).replace('http://127.0.0.1:7777', ''), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null }
    sent.push(request)
    return reply(request)
  }) as typeof fetch
  await Promise.all([import('../client/sidebar'), import('../client/chat'), import('../client/terminals'), import('../client/plugins')])
  hostApi = await import('../client/plugins/host-api')
  launchDialog = await import('../client/plugins/launch-dialog')
  pluginScreen = await import('../client/plugins/plugin-screen')
  await flush()
})

afterAll(() => {
  globalThis.fetch = realFetch
  Object.assign(globalThis, realBus)
  Object.assign(globalThis, { setInterval: realSetInterval, clearInterval: realClearInterval })
  Reflect.deleteProperty(globalThis.navigator, 'clipboard')
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'HTMLCanvasElement', 'Option', 'localStorage', 'location', 'matchMedia', 'ResizeObserver']) Reflect.deleteProperty(globalThis, key)
  window.close()
})

test('the sidebar lists enabled plugins with a screen under a Plugins heading, before the day groups', async () => {
  installedPlugins = [helloPlugin, { ...clickupPlugin, enabled: false }]
  dispatchEvent(new Event('quiet:plugins-changed'))
  await flush()
  const list = byId('sidebar-list')
  const headings = [...list.querySelectorAll('.sb-day')].map(day => day.textContent)
  expect(headings).toEqual(['Plugins', 'Today'])
  const rows = [...list.querySelectorAll('a.sb-row[data-kind="plugin"]')]
  expect(rows).toHaveLength(1)
  expect(rows[0]!.dataset.key).toBe('plugin:hello-board')
  expect(rows[0]!.querySelector('.sb-t')!.textContent).toBe('Hello board')
  expect(rows[0]!.querySelector('.sb-ic img')!.getAttribute('src')).toBe('/api/plugins/hello-board/icon')
  const rail = byId('sidebar-mini')
  expect([...rail.querySelectorAll('a.sb-mini[data-kind="plugin"]')].map(row => row.dataset.key)).toEqual(['plugin:hello-board'])
})

test('clicking a plugin row asks for its screen, and a refreshed list repaints', async () => {
  const shown: string[] = []
  addEventListener('quiet:show-plugin', (event) => shown.push(detailOf<string>(event)))
  ;(byId('sidebar-list').querySelector('a.sb-row[data-kind="plugin"]') as HTMLElement).click()
  expect(shown).toEqual(['hello-board'])
  installedPlugins = [{ ...helloPlugin, enabled: false }, clickupPlugin]
  dispatchEvent(new Event('quiet:plugins-changed'))
  await flush()
  const row = byId('sidebar-list').querySelector('a.sb-row[data-kind="plugin"]') as HTMLElement
  expect(row.dataset.key).toBe('plugin:clickup-board')
  expect(row.querySelector('.sb-ic svg use')!.getAttribute('href')).toBe('#auto-icon')
  installedPlugins = [helloPlugin, clickupPlugin]
  dispatchEvent(new Event('quiet:plugins-changed'))
  await flush()
})

test('the Marketplace button sits in the sidebar footer and above history in the rail, with the new screens and launch dialog in the shell', () => {
  const page = ShellPage({ workspaceDir: '/home/dev' })
  const foot = page.slice(page.indexOf('class="sb-foot"'), page.indexOf('</div>', page.indexOf('class="sb-foot"')))
  expect(foot).toContain('id="open-marketplace"')
  expect(foot.indexOf('id="open-marketplace"')).toBeLessThan(foot.indexOf('id="all-history"'))
  const strip = page.slice(page.indexOf('class="sb-strip"'), page.indexOf('</aside>'))
  expect(strip).toContain('data-click="open-marketplace"')
  expect(strip.indexOf('data-click="open-marketplace"')).toBeLessThan(strip.indexOf('data-click="all-history"'))
  for (const marker of ['<symbol id="store-icon"', '<section id="plugin" class="studio"', '<section id="marketplace" class="studio"', '<dialog id="plugin-launch" class="access-dialog flat"', '/js/plugins.js']) expect(page).toContain(marker)
})

test('the bundled plugins island opens the marketplace through the shell event', async () => {
  sent.length = 0
  installedPlugins = [helloPlugin]
  byId('open-marketplace').click()
  await flush(4)
  const gets = sent.filter(request => request.method === 'GET').map(request => request.url)
  expect(gets).toContain('/api/plugins')
  expect(gets).toContain('/api/plugins/catalog')
  const screen = byId('marketplace')
  expect(screen.querySelector('.connection-list')).not.toBeNull()
  expect(screen.querySelector('.connection-list [data-plugin="hello-board"]')).not.toBeNull()
  expect(screen.querySelector('.connection-settings')).not.toBeNull()
})

test('a plugin link opens the install prompt for that plugin at the version found', async () => {
  addLinkReply = { status: 200, body: { kind: 'plugin', ref: 'v1.1.0', manifest: { id: 'clickup-board', name: 'ClickUp board', version: '1.1.0' }, commit: 'abc123', permissions: { network: ['api.clickup.com'], sessions: ['chat'], settings: true }, runtime: 'isolated' } }
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))
  await flush(4)
  buttonNamed('Add from a link', byId('marketplace')).click()
  await flush()
  const link = byId('marketplace').querySelector('input[aria-label="Plugin or marketplace link"]') as HTMLInputElement
  link.value = 'https://github.com/LynchzDEV/mc-plugin-clickup'
  sent.length = 0
  buttonNamed('Add', byId('marketplace')).click()
  await flush(4)
  expect(sent.find(request => request.url === '/api/plugins/add-link')!.body).toEqual({ url: 'https://github.com/LynchzDEV/mc-plugin-clickup' })
  expect(byId('marketplace').querySelector('.mk-dialog h2')!.textContent).toBe('Install ClickUp board?')
  expect(byId('marketplace').querySelector('.mk-dialog')!.textContent).toContain('api.clickup.com')
  buttonNamed('Cancel', byId('marketplace').querySelector('.mk-dialog') as HTMLElement).click()
  await flush()
})

test('a marketplace link is added and its listing loads; a bad link says why', async () => {
  addLinkReply = { status: 200, body: { kind: 'marketplace' } }
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))
  await flush(4)
  buttonNamed('Add from a link', byId('marketplace')).click()
  await flush()
  ;(byId('marketplace').querySelector('input[aria-label="Plugin or marketplace link"]') as HTMLInputElement).value = 'https://github.com/LynchzDEV/mc-marketplace'
  sent.length = 0
  buttonNamed('Add', byId('marketplace')).click()
  await flush(4)
  expect(sent.map(request => request.url)).toContain('/api/plugins/catalog')
  expect(byId('marketplace').querySelector('input[aria-label="Plugin or marketplace link"]')).toBeNull()
  addLinkReply = { status: 400, body: { error: "This repo isn't a Mission Control plugin or marketplace." } }
  buttonNamed('Add from a link', byId('marketplace')).click()
  await flush()
  ;(byId('marketplace').querySelector('input[aria-label="Plugin or marketplace link"]') as HTMLInputElement).value = 'https://github.com/someone/notes'
  buttonNamed('Add', byId('marketplace')).click()
  await flush(4)
  expect(byId('marketplace').textContent).toContain("This repo isn't a Mission Control plugin or marketplace.")
  addLinkReply = { status: 200, body: { kind: 'marketplace' } }
})

test('a marketplace that fails to load shows its error and can be removed', async () => {
  brokenMarketplace = { marketplace: 'https://github.com/LynchzDEV/mc-plugin-clickup', error: 'marketplace.json is missing — sync this marketplace first' }
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))
  await flush(4)
  const row = byId('marketplace').querySelector('.mk-market-broken[data-marketplace="https://github.com/LynchzDEV/mc-plugin-clickup"]') as HTMLElement
  expect(row.textContent).toContain('marketplace.json is missing')
  sent.length = 0
  buttonNamed('Remove', row).click()
  await flush(4)
  expect(sent.find(request => request.method === 'DELETE')).toEqual({ url: '/api/plugins/marketplaces', method: 'DELETE', body: { url: 'https://github.com/LynchzDEV/mc-plugin-clickup' } })
  expect(byId('marketplace').querySelector('.mk-market-broken')).toBeNull()
})

test('a marketplace name from the catalog renders as text, never as markup', async () => {
  catalogName = '<img src=x onerror="window.__pwned=1">'
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))
  await flush(4)
  const heading = [...byId('marketplace').querySelectorAll('.connection-list h2')].find(h2 => h2.textContent!.startsWith('Available'))!
  expect(heading.querySelector('.muted')!.textContent).toBe('<img src=x onerror="window.__pwned=1">')
  expect(byId('marketplace').querySelectorAll('img[onerror], img[src="x"]')).toHaveLength(0)
  catalogName = 'KlangTech marketplace'
})

test('the host api refuses sessions and settings the plugin never asked for', async () => {
  const chatOnly = hostApi.createScreenApi(helloPlugin, () => Promise.resolve())
  const terminalError = await chatOnly.sessions.startTerminal({ title: 'T', cwd: '/w' }).then(() => null, (error: Error) => error.message)
  expect(terminalError).toBe('This plugin did not ask to start terminals')
  const terminalOnly = hostApi.createScreenApi({ ...helloPlugin, permissions: { sessions: ['terminal'] } }, () => Promise.resolve())
  const chatError = await terminalOnly.sessions.startChat({ title: 'T', cwd: '/w' }).then(() => null, (error: Error) => error.message)
  expect(chatError).toBe('This plugin did not ask to start chats')
  const settingsError = await hostApi.createScreenApi({ ...helloPlugin, permissions: { sessions: ['chat'] } }, () => Promise.resolve()).settings.view().then(() => null, (error: Error) => error.message)
  expect(settingsError).toBe('This plugin did not ask to keep settings')
})

test('the launch dialog attaches the task context and the first message to the chat prompt', async () => {
  sent.length = 0
  const started: Array<Record<string, unknown>> = []
  const listener = (event: Event): void => { started.push(detailOf<Record<string, unknown>>(event)) }
  addEventListener('quiet:start-chat', listener)
  const done = launchDialog.openPluginLaunch('chat', { id: 'hello-board', name: 'Hello board' }, {
    title: 'Read the plugin guide', cwd: '/work/app', context: { name: 'task-86d3j8w1c', markdown: '# HerMEZ kood queue stalls after deploy\n\n…' },
  })
  await flush()
  expect(byId('plugin-launch-ctx').hidden).toBe(false)
  expect(byId('plugin-launch-ctx-name').textContent).toBe('task-86d3j8w1c')
  expect(byId('plugin-launch-ctx-size').textContent).toContain('KB')
  expect(input('plugin-launch-cwd').value).toBe('/work/app')
  const engine = doc.getElementById('plugin-launch-engine') as HTMLSelectElement
  expect([...engine.options].map(option => option.value)).toEqual(['claude', 'glm'])
  input('plugin-launch-message').value = 'Plan it'
  ;(doc.getElementById('plugin-launch-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await done
  await flush()
  expect(sent.filter(request => request.url.endsWith('/context'))).toEqual([{ url: '/api/plugins/hello-board/context', method: 'POST', body: { name: 'task-86d3j8w1c', markdown: '# HerMEZ kood queue stalls after deploy\n\n…', cwd: '/work/app' } }])
  expect(started.at(-1)).toMatchObject({ engine: 'claude', cwd: '/work/app', prompt: 'Read the task context in /x/y.md before anything else.\n\nPlan it' })
  removeEventListener('quiet:start-chat', listener)
})

test('without a task context the chat launch needs a first message and sends it alone; a terminal may start with none', async () => {
  sent.length = 0
  const started: Array<Record<string, unknown>> = []
  const opened: Array<Record<string, unknown>> = []
  const startListener = (event: Event): void => { started.push(detailOf<Record<string, unknown>>(event)) }
  const openListener = (event: Event): void => { opened.push(detailOf<Record<string, unknown>>(event)) }
  addEventListener('quiet:start-chat', startListener)
  addEventListener('quiet:open-terminal', openListener)

  const chat = launchDialog.openPluginLaunch('chat', { id: 'hello-board', name: 'Hello board' }, { title: 'T', cwd: '/work/app' })
  await flush()
  expect(byId('plugin-launch-ctx').hidden).toBe(true)
  const start = byId('plugin-launch-start') as HTMLButtonElement
  expect(start.disabled).toBe(true)
  expect(byId('plugin-launch-message-hint').hidden).toBe(false)
  input('plugin-launch-message').value = 'Just go'
  input('plugin-launch-message').dispatchEvent(new window.Event('input', { bubbles: true }))
  expect(start.disabled).toBe(false)
  ;(doc.getElementById('plugin-launch-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await chat
  expect(sent.some(request => request.url.endsWith('/context'))).toBe(false)
  expect(started.at(-1)).toMatchObject({ prompt: 'Just go' })

  const terminal = launchDialog.openPluginLaunch('terminal', { id: 'hello-board', name: 'Hello board' }, { title: 'HerMEZ kood queue stalls after deploy', cwd: '/work/app' })
  await flush()
  expect((byId('plugin-launch-start') as HTMLButtonElement).disabled).toBe(false)
  ;(doc.getElementById('plugin-launch-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await terminal
  const launchDetail = opened.at(-1)!.launch as Record<string, unknown>
  expect(launchDetail).toMatchObject({ engine: 'claude', cwd: '/work/app', title: 'HerMEZ kood queue stalls after deploy' })
  expect(launchDetail.initialPrompt).toBeUndefined()
  removeEventListener('quiet:start-chat', startListener)
  removeEventListener('quiet:open-terminal', openListener)
})

test('a ~ folder is expanded with the workspace home before anything is sent', () => {
  expect(launchDialog.expandHome('~/Desktop/api', '/Users/me')).toBe('/Users/me/Desktop/api')
  expect(launchDialog.expandHome('~', '/Users/me/')).toBe('/Users/me')
  expect(launchDialog.expandHome('/work/app', '/Users/me')).toBe('/work/app')
  expect(launchDialog.expandHome('~/x', '')).toBe('~/x')
})

test('the launch dialog prefills the first message from the session request', async () => {
  sent.length = 0
  const started: Array<Record<string, unknown>> = []
  const listener = (event: Event): void => { started.push(detailOf<Record<string, unknown>>(event)) }
  addEventListener('quiet:start-chat', listener)
  const done = launchDialog.openPluginLaunch('chat', { id: 'hello-board', name: 'Hello board' }, { title: 'T', cwd: '/work/app', prompt: 'Plan this task' })
  await flush()
  expect(input('plugin-launch-message').value).toBe('Plan this task')
  expect((byId('plugin-launch-start') as HTMLButtonElement).disabled).toBe(false)
  ;(doc.getElementById('plugin-launch-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await done
  await flush()
  expect(sent.some(request => request.url.endsWith('/context'))).toBe(false)
  expect(started.at(-1)).toMatchObject({ engine: 'claude', cwd: '/work/app', prompt: 'Plan this task' })
  removeEventListener('quiet:start-chat', listener)
})

test('quiet:start-chat creates the chat job in the given folder', async () => {
  sent.length = 0
  dispatchEvent(new CustomEvent('quiet:start-chat', { detail: { engine: 'glm', model: 'glm-5.3', cwd: '/work/app', prompt: 'Read the task context in /x/y.md before anything else.' } }))
  await flush(4)
  const job = sent.find(request => request.url === '/api/jobs' && request.method === 'POST')
  expect(job).toBeDefined()
  expect(job!.body).toMatchObject({ engine: 'glm', model: 'glm-5.3', cwd: '/work/app', purpose: 'chat', prompt: 'Read the task context in /x/y.md before anything else.' })
})

test('opening a plugin again keeps its loaded screen; an update rebuilds it', async () => {
  await pluginScreen.openPluginScreen(clickupPlugin)
  const first = byId('plugin').querySelector('[data-plugin-view="clickup-board"] iframe')
  await pluginScreen.openPluginScreen(clickupPlugin)
  expect(byId('plugin').querySelectorAll('[data-plugin-view="clickup-board"]')).toHaveLength(1)
  expect(byId('plugin').querySelector('[data-plugin-view="clickup-board"] iframe')).toBe(first)
  expect((byId('plugin').querySelector('[data-plugin-view="clickup-board"]') as HTMLElement).hidden).toBe(false)
  await pluginScreen.openPluginScreen({ ...clickupPlugin, commit: 'aaaaaa', updatedAt: '2026-10-05T00:00:00.000Z' })
  expect(byId('plugin').querySelectorAll('[data-plugin-view="clickup-board"]')).toHaveLength(1)
  expect(byId('plugin').querySelector('[data-plugin-view="clickup-board"] iframe')).not.toBe(first)
})

test('an isolated plugin mounts in a sandboxed frame and only its window can call the host api', async () => {
  await pluginScreen.openPluginScreen(clickupPlugin)
  const frame = byId('plugin').querySelector('[data-plugin-view="clickup-board"] iframe') as HTMLIFrameElement
  expect(frame).not.toBeNull()
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('src')).toBe('/plugin-frame/clickup-board/')
  const probe = document.createElement('iframe')
  doc.body.append(probe)
  const target = probe.contentWindow!
  const posted: unknown[] = []
  Object.defineProperty(target, 'postMessage', { configurable: true, value: (data: unknown) => { posted.push(data) } })
  const calls: string[] = []
  const { endpoint, close } = pluginScreen.createFrameEndpoint(probe)
  const { expose } = await import('comlink')
  expose({ note: () => { calls.push('note'); return 'ok' } }, endpoint)
  const signal = (source: unknown, data: unknown): void => {
    const event = new window.MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: source })
    window.dispatchEvent(event)
  }
  signal(target, { id: 'one', type: 'APPLY', path: ['note'], argumentList: [] })
  await flush()
  expect(calls).toEqual(['note'])
  expect(posted).toHaveLength(1)
  signal(window, { id: 'two', type: 'APPLY', path: ['note'], argumentList: [] })
  signal(null, { id: 'three', type: 'APPLY', path: ['note'], argumentList: [] })
  await flush()
  expect(calls).toEqual(['note'])
  expect(posted).toHaveLength(1)
  close()
  probe.remove()
})

test('a dropped first message lands on the clipboard with a toast that explains it', async () => {
  sent.length = 0
  clipboardWrites.length = 0
  clipboardResolves = true
  const prompt = 'Read the task context in /x/y.md before anything else.'
  terminalCreate = () => Response.json({ id: 't-9', engine: 'claude', cwd: '/work/app', title: 'Task', firstMessageDropped: true })
  dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { launch: { engine: 'claude', cwd: '/work/app', title: 'Task', initialPrompt: prompt } } }))
  await flush(4)
  const created = sent.find(request => request.url === '/api/terminals' && request.method === 'POST')
  expect(created!.body).toMatchObject({ engine: 'claude', cwd: '/work/app', title: 'Task', initialPrompt: prompt })
  expect(clipboardWrites).toEqual([prompt])
  expect(byId('toast').textContent).toBe("The first message was not sent: this AI's terminal arguments have no {{prompt}} slot. It is on your clipboard.")

  clipboardWrites.length = 0
  clipboardResolves = false
  dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { launch: { engine: 'claude', cwd: '/work/app', title: 'Task', initialPrompt: prompt } } }))
  await flush(4)
  expect(byId('toast').textContent).toBe("The first message was not sent: this AI's terminal arguments have no {{prompt}} slot. Add one in Studio, Manage AIs.")
  clipboardResolves = true
  terminalCreate = null
})

test('checking for an update re-syncs the marketplace, reads the catalog, then previews', async () => {
  installedPlugins = [helloPlugin]
  marketplaceSyncOk = true
  previewBody = { manifest: { id: 'hello-board', name: 'Hello board', version: '2.0.0', pluginApi: 1, runtime: 'isolated', permissions: { sessions: ['chat'] } }, commit: '222222', permissions: { sessions: ['chat'] }, runtime: 'isolated' }
  updateResponses = [{ status: 409, body: { needsConsent: true, added: ['Reach b.example.com'] } }]
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))
  await flush(4)
  const installedChoice = byId('marketplace').querySelector('.connection-list [data-plugin="hello-board"]') as HTMLElement
  installedChoice.click()
  await flush()
  sent.length = 0
  buttonNamed('Check for update', byId('marketplace')).click()
  await flush()
  expect(sent.map(request => request.url)).toEqual(['/api/plugins/marketplaces', '/api/plugins/catalog', '/api/plugins/preview'])
  expect(sent[0]!.body).toEqual({ url: 'https://github.com/LynchzDEV/mc-marketplace' })
  const update = buttonNamed('Update to 2.0.0', byId('marketplace'))
  update.click()
  await flush()
  expect(byId('marketplace').textContent).toContain('Reach b.example.com')
  buttonNamed('Accept and update', byId('marketplace')).click()
  await flush()
  const updates = sent.filter(request => request.url === '/api/plugins/hello-board/update')
  expect(updates.map(request => request.body)).toEqual([
    { ref: 'v2.0.0', commit: '222222' },
    { ref: 'v2.0.0', commit: '222222', accept: true },
  ])
})

test('an update in flight shows its progress and ignores a second click', async () => {
  installedPlugins = [helloPlugin]
  marketplaceSyncOk = true
  previewBody = { manifest: { id: 'hello-board', name: 'Hello board', version: '2.0.0', pluginApi: 1, runtime: 'isolated', permissions: { sessions: ['chat'] } }, commit: '222222', permissions: { sessions: ['chat'] }, runtime: 'isolated' }
  updateResponses = []
  let release: () => void = () => {}
  updateGate = new Promise<void>(resolve => { release = resolve })
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))
  await flush(4)
  ;(byId('marketplace').querySelector('.connection-list [data-plugin="hello-board"]') as HTMLElement).click()
  await flush()
  buttonNamed('Check for update', byId('marketplace')).click()
  await flush()
  sent.length = 0
  const update = buttonNamed('Update to 2.0.0', byId('marketplace'))
  update.click()
  update.click()
  await flush()
  expect(byId('marketplace').textContent).toContain('Updating to 2.0.0…')
  expect(sent.filter(request => request.url === '/api/plugins/hello-board/update')).toHaveLength(1)
  release()
  updateGate = null
  await flush()
  expect(byId('marketplace').textContent).not.toContain('Updating to 2.0.0…')
})

test('a marketplace that cannot be reached stops the update check with an inline note', async () => {
  installedPlugins = [helloPlugin]
  marketplaceSyncOk = false
  dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))
  await flush(4)
  ;(byId('marketplace').querySelector('.connection-list [data-plugin="hello-board"]') as HTMLElement).click()
  await flush()
  sent.length = 0
  buttonNamed('Check for update', byId('marketplace')).click()
  await flush()
  expect(sent.map(request => request.url)).toEqual(['/api/plugins/marketplaces'])
  expect(byId('marketplace').textContent).toContain("Couldn't reach this marketplace")
  marketplaceSyncOk = true
})
