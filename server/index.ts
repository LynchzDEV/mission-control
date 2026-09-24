import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { staticPlugin } from '@elysiajs/static'
import { Elysia } from 'elysia'

import { maybeAutoReview } from './auto-review'
import { localRequestAllowed } from './local-access'
import { quotaRoutes } from './routes/quota'
import { DEFAULT_BIND, parseBind, readConfig } from './secrets'
import { createJobManager } from './jobs'
import { notifySlowJob } from './notify'
import { createTerminalRegistry } from './terminals'
import { realEngineResolver } from './jobs-engine-iface'
import { createPlanRunner } from './plan-runner'
import { createPlanStore } from './plans'
import { createWorkflowStore } from './workflows'
import { createWorkflowBuilder } from './workflow-builder'
import { createWorkflowRunner } from './workflow-runner'
import { studioRoutes } from './routes/studio'
import { StudioPage } from './views/studio'
import { runsRoutes } from './routes/runs'
import { jobsRoutes } from './routes/jobs'
import { metaRoutes } from './routes/meta'
import { modelsCache, modelsRoutes } from './routes/models'
import { terminalsRoutes } from './routes/terminals'
import { flowRoutes } from './routes/flow'
import { currentView, secretsRoutes } from './routes/secrets'
import { readRoles, rolesRoutes } from './routes/roles'
import { claudeSkillsDir, describeSkillInstall, installSkills } from './skill-install'
import { syncEngineAssets } from './engine-assets'
import { DispatchPage } from './views/dispatch'
import { LanesPage } from './views/lanes'
import { ReviewPage } from './views/review'
import { SettingsPage } from './views/settings'
import { TerminalsPage } from './views/terminals'

const ROOT = resolve(import.meta.dir, '..')
const CLIENT_DIR = join(ROOT, 'client')
const PUBLIC_DIR = join(ROOT, 'public')

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' }
const JS_HEADERS = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }

const MODULE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

type CachedModule = {
  stamp: string
  code: string
  css: string
}

const transpileCache = new Map<string, CachedModule>()

export async function transpileClientModule(requested: string): Promise<string | null> {
  if (!requested.endsWith('.js')) return null
  const name = requested.slice(0, -3)
  if (!MODULE_NAME_PATTERN.test(name)) return null

  let path = join(CLIENT_DIR, `${name}.ts`)
  let info
  try {
    info = await stat(path)
  } catch {
    path = join(CLIENT_DIR, `${name}.tsx`)
    try { info = await stat(path) } catch { return null }
  }
  if (!info.isFile()) return null

  const files = [...new Bun.Glob('*.{ts,tsx}').scanSync(CLIENT_DIR)].sort()
  const stamp = (await Promise.all(files.map(async (file) => { const value = await stat(join(CLIENT_DIR, file)); return `${file}:${value.mtimeMs}:${value.size}` }))).join('|')
  const cached = transpileCache.get(name)
  if (cached !== undefined && cached.stamp === stamp) return cached.code

  const built = await Bun.build({ entrypoints: [path], target: 'browser', write: false, ...(name === 'studio' ? { minify: true, define: { 'process.env.NODE_ENV': '"production"' } } : {}) })
  if (!built.success || built.outputs.length === 0) return null

  const code = await built.outputs.find(output => output.path.endsWith('.js'))!.text()
  const css = await built.outputs.find(output => output.path.endsWith('.css'))?.text() ?? ''
  transpileCache.set(name, { stamp, code, css })
  return code
}

export async function transpileClientStyles(requested: string): Promise<string | null> {
  if (!requested.endsWith('.css')) return null
  const name = requested.slice(0, -4)
  if (!MODULE_NAME_PATTERN.test(name) || await transpileClientModule(`${name}.js`) === null) return null
  return transpileCache.get(name)?.css || null
}

function page(markup: string): Response {
  return new Response(markup, { headers: HTML_HEADERS })
}

async function appShellPage(): Promise<Response> {
  return page(await terminalsPage())
}

async function settingsPage(embedded = false): Promise<string> {
  const [view, config, models] = await Promise.all([currentView(), readConfig(), modelsCache.get()])
  return SettingsPage({ ...view, embedded, roles: config.roles, autoReview: config.autoReview, models })
}

async function dispatchPage(embedded = false): Promise<string> {
  const [roles, models] = await Promise.all([readRoles(), modelsCache.get()])
  return DispatchPage({ embedded, defaultEngine: roles.execute.engine, defaultModel: roles.execute.model, models })
}

async function terminalsPage(): Promise<string> {
  const [roles, models] = await Promise.all([readRoles(), modelsCache.get()])
  return TerminalsPage({ defaultEngine: roles.plan.engine, defaultModel: roles.plan.model, models })
}

const TAB_PAGES: Record<string, (embedded?: boolean) => string | Promise<string>> = {
  '/lanes': LanesPage,
  '/dispatch': dispatchPage,
  '/terminals': terminalsPage,
  '/review': ReviewPage,
  '/settings': settingsPage,
  '/studio': (embedded = false) => StudioPage({ embedded }),
}

function tabPages() {
  const instance = new Elysia()
  for (const [path, view] of Object.entries(TAB_PAGES)) {
    instance.get(path, async ({ request, set }) => {
      if (!localRequestAllowed(request)) { set.status = 403; return 'local access only' }
      const embedded = new URL(request.url).searchParams.get('embed') === '1'
      return page(await (embedded || path === '/terminals' ? view(embedded) : terminalsPage()))
    })
  }
  return instance
}

async function publicDirExists(): Promise<boolean> {
  try {
    return (await stat(PUBLIC_DIR)).isDirectory()
  } catch {
    return false
  }
}

// Health is deliberately public: probes (mc-dispatch skill, double-bind check) read liveness only.
function healthApi() {
  return new Elysia().get('/api/health', () => ({ ok: true }))
}

export async function createApp(): Promise<Elysia> {
  const skills = await installSkills()
  const assets = await syncEngineAssets()
  if (assets.linked.length > 0 || assets.written.length > 0 || assets.movedAside.length > 0) {
    console.error(`codex assets — linked ${assets.linked.length}, written ${assets.written.length}, moved aside ${assets.movedAside.length}, skipped ${assets.skipped.length}`)
  }
  if (skills.linked.length > 0 || skills.movedAside.length > 0) {
    console.error(`skills: ${describeSkillInstall(skills)} -> ${claudeSkillsDir()}`)
  }
  const planStore = createPlanStore()
  const workflowStore = createWorkflowStore()
  const jobManager = createJobManager({
    onJobSlow: notifySlowJob,
    onJobSettled: (record) => {
      if (record.purpose === 'workflow-design') {
        void workflowBuilder.cleanup(record).catch(error => console.error('Workflow designer cleanup failed', error))
        return
      }
      if (record.workflowRunId) {
        void workflowRunner.onJobSettled(record).catch(error => console.error('Workflow settlement failed', error))
        return
      }
      void planRunner.onJobSettled(record).catch(() => {})
      void maybeAutoReview(record, jobManager, { resolver: realEngineResolver }).catch(() => {})
    },
  })
  const planRunner = createPlanRunner({ manager: jobManager, resolver: realEngineResolver, plans: planStore })
  const terminalRegistry = createTerminalRegistry()
  const workflowRunner = createWorkflowRunner({ manager: jobManager, resolver: realEngineResolver, store: workflowStore, terminals: terminalRegistry })
  const workflowBuilder = createWorkflowBuilder({ manager: jobManager, resolver: realEngineResolver, store: workflowStore })
  await workflowRunner.recover()
  await workflowBuilder.recover()

  const app = new Elysia()
    .get('/', async ({ request, set }) => {
      if (!localRequestAllowed(request)) { set.status = 403; return 'local access only' }
      return appShellPage()
    })
    .get('/js/:file', async ({ params, set }) => {
      if (params.file.endsWith('.css')) {
        const css = await transpileClientStyles(params.file)
        if (css === null) { set.status = 404; return { error: 'not found' } }
        return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } })
      }
      const code = await transpileClientModule(params.file)
      if (code === null) {
        set.status = 404
        return { error: 'not found' }
      }
      return new Response(code, { headers: JS_HEADERS })
    })
    .use(tabPages())
    .use(healthApi())
    .use(quotaRoutes)
    .use(metaRoutes(jobManager))
    .use(jobsRoutes(jobManager, realEngineResolver))
    .use(terminalsRoutes(terminalRegistry))
    .use(flowRoutes(jobManager, terminalRegistry, planStore))
    .use(runsRoutes(planRunner))
    .use(studioRoutes(workflowStore, workflowRunner, workflowBuilder))
    .use(secretsRoutes)
    .use(rolesRoutes)
    .use(modelsRoutes)

  if (await publicDirExists()) {
    app.use(staticPlugin({ assets: PUBLIC_DIR, prefix: '', headers: { 'cache-control': 'no-cache' } }))
  }

  return app
}

if (import.meta.main) {
  const config = await readConfig().catch(() => ({ bind: DEFAULT_BIND }))
  const target = parseBind(config.bind)
  const occupied = await fetch(`http://${target.hostname}:${target.port}/api/health`, { signal: AbortSignal.timeout(800) })
    .then(() => true, () => false)
  if (occupied) {
    console.error(`mission-control: ${target.hostname}:${target.port} already answers — another instance is running, refusing to double-bind`)
    process.exit(1)
  }
  const app = await createApp()
  app.listen({ hostname: target.hostname, port: target.port, reusePort: false })
  console.log(`mission-control listening on http://${target.hostname}:${target.port}`)
}
