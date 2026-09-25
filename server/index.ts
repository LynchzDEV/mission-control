import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { staticPlugin } from '@elysiajs/static'
import { Elysia } from 'elysia'

import { maybeAutoReview } from './auto-review'
import { localRequestAllowed } from './local-access'
import { quotaRoutes } from './routes/quota'
import { historyRoutes } from './routes/history'
import { createExternalSessionsCache, ownedPids } from './history'
import { listenTarget } from './secrets'
import { createJobManager } from './jobs'
import { notifyChat, notifySlowJob } from './notify'
import { createReportPoster } from './chat-reports'
import { redactedTailReader } from './log-redaction'
import { createTerminalRegistry } from './terminals'
import { realEngineResolver } from './jobs-engine-iface'
import { createPlanRunner } from './plan-runner'
import { createPlanStore } from './plans'
import { createWorkflowStore } from './workflows'
import { createWorkflowBuilder } from './workflow-builder'
import { createWorkflowRunner } from './workflow-runner'
import { studioRoutes } from './routes/studio'
import { runsRoutes } from './routes/runs'
import { jobsRoutes } from './routes/jobs'
import { chatRoutes } from './routes/chat'
import { metaRoutes } from './routes/meta'
import { modelsRoutes } from './routes/models'
import { providersRoutes } from './routes/providers'
import { terminalsRoutes } from './routes/terminals'
import { flowRoutes } from './routes/flow'
import { secretsRoutes } from './routes/secrets'
import { rolesRoutes } from './routes/roles'
import { claudeSkillsDir, describeSkillInstall, installSkills } from './skill-install'
import { syncEngineAssets } from './engine-assets'
import { ShellPage } from './views/shell'

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

function appShellPage(): Response {
  return page(ShellPage({ workspaceDir: homedir() }))
}

const RETIRED_PAGES: Record<string, string> = {
  '/lanes': '/',
  '/dispatch': '/',
  '/terminals': '/',
  '/review': '/',
  '/settings': '/',
  '/studio': '/?screen=studio',
}

function retiredPageRedirects() {
  const instance = new Elysia()
  for (const [path, location] of Object.entries(RETIRED_PAGES)) {
    instance.get(path, ({ request, set }) => {
      if (!localRequestAllowed(request)) { set.status = 403; return 'local access only' }
      set.status = 302
      set.headers['location'] = location
      return ''
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
      if (record.chatId) {
        void reportPoster(record).catch(error => console.error('Chat report failed', error))
        return
      }
      void maybeAutoReview(record, jobManager, { resolver: realEngineResolver }).catch(() => {})
    },
  })
  const reportPoster = createReportPoster(jobManager, realEngineResolver, {
    notify: notifyChat,
    logReader: async () => {
      const read = await redactedTailReader()
      return id => read(jobManager.logPath(id))
    },
  })
  const planRunner = createPlanRunner({ manager: jobManager, resolver: realEngineResolver, plans: planStore })
  const terminalRegistry = createTerminalRegistry()
  const workflowRunner = createWorkflowRunner({ manager: jobManager, resolver: realEngineResolver, store: workflowStore, terminals: terminalRegistry })
  const workflowBuilder = createWorkflowBuilder({ manager: jobManager, resolver: realEngineResolver, store: workflowStore })
  await workflowRunner.recover()
  await workflowBuilder.recover()
  const knownDirectories = () => [...jobManager.listJobs().map(job => job.baseRepo ?? job.cwd), ...terminalRegistry.list().map(session => session.cwd)]
  const externalSessionsCache = createExternalSessionsCache(() => ownedPids(jobManager.listJobs(), terminalRegistry.list()))

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
    .use(retiredPageRedirects())
    .use(healthApi())
    .use(quotaRoutes({ externalSessions: () => externalSessionsCache.get() }))
    .use(metaRoutes(jobManager))
    .use(jobsRoutes(jobManager, realEngineResolver))
    .use(chatRoutes({ knownDirectories }))
    .use(historyRoutes({ manager: jobManager, registry: terminalRegistry, knownDirectories, external: () => externalSessionsCache.get() }))
    .use(terminalsRoutes(terminalRegistry))
    .use(flowRoutes(jobManager, terminalRegistry, planStore))
    .use(runsRoutes(planRunner))
    .use(studioRoutes(workflowStore, workflowRunner, workflowBuilder))
    .use(secretsRoutes)
    .use(rolesRoutes)
    .use(modelsRoutes)
    .use(providersRoutes)

  if (await publicDirExists()) {
    app.use(staticPlugin({ assets: PUBLIC_DIR, prefix: '', headers: { 'cache-control': 'no-cache' } }))
  }

  return app
}

if (import.meta.main) {
  const target = listenTarget()
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
