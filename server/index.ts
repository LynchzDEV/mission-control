import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { staticPlugin } from '@elysiajs/static'
import { cookie } from '@elysiajs/cookie'
import { Elysia } from 'elysia'

import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  attemptLogin,
  completeSetup,
  isSetupComplete,
  requireSession,
  verifyCookieHeader,
} from './auth'
import { quotaRoutes } from './routes/quota'
import { DEFAULT_BIND, parseBind, readConfig } from './secrets'
import { createJobManager } from './jobs'
import { createTerminalRegistry } from './terminals'
import { realEngineResolver } from './jobs-engine-iface'
import { jobsRoutes } from './routes/jobs'
import { terminalsRoutes } from './routes/terminals'
import { flowRoutes } from './routes/flow'
import { currentView, secretsRoutes } from './routes/secrets'
import { DispatchPage } from './views/dispatch'
import { LanesPage } from './views/lanes'
import { LoginPage, SetupPage } from './views/login'
import { ReviewPage } from './views/review'
import { SettingsPage } from './views/settings'
import { TerminalsPage } from './views/terminals'

const ROOT = resolve(import.meta.dir, '..')
const CLIENT_DIR = join(ROOT, 'client')
const PUBLIC_DIR = join(ROOT, 'public')

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' }
const JS_HEADERS = { 'content-type': 'text/javascript; charset=utf-8' }

const MODULE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

type CachedModule = {
  mtimeMs: number
  code: string
}

const transpileCache = new Map<string, CachedModule>()

export async function transpileClientModule(requested: string): Promise<string | null> {
  if (!requested.endsWith('.js')) return null
  const name = requested.slice(0, -3)
  if (!MODULE_NAME_PATTERN.test(name)) return null

  const path = join(CLIENT_DIR, `${name}.ts`)
  let info
  try {
    info = await stat(path)
  } catch {
    return null
  }
  if (!info.isFile()) return null

  const cached = transpileCache.get(name)
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs) return cached.code

  const built = await Bun.build({ entrypoints: [path], target: 'browser', write: false })
  if (!built.success || built.outputs.length === 0) return null

  const code = await built.outputs[0]!.text()
  transpileCache.set(name, { mtimeMs: info.mtimeMs, code })
  return code
}

function page(markup: string): Response {
  return new Response(markup, { headers: HTML_HEADERS })
}

function setupPage(): Response {
  return page(SetupPage({ minPasswordLength: MIN_PASSWORD_LENGTH }))
}

function loginPage(): Response {
  return page(LoginPage())
}

function appShellPage(): Response {
  return page(LanesPage())
}

async function settingsPage(): Promise<string> {
  const view = await currentView()
  return SettingsPage({ ...view, minPasswordLength: MIN_PASSWORD_LENGTH })
}

const TAB_PAGES: Record<string, () => string | Promise<string>> = {
  '/lanes': LanesPage,
  '/dispatch': DispatchPage,
  '/terminals': TerminalsPage,
  '/review': ReviewPage,
  '/settings': settingsPage,
}

function tabPages() {
  const instance = new Elysia()
  for (const [path, view] of Object.entries(TAB_PAGES)) {
    instance.get(path, async ({ request, set }) => {
      if (!(await verifyCookieHeader(request.headers.get('cookie')))) {
        set.status = 302
        set.headers.location = '/'
        return ''
      }
      return page(await view())
    })
  }
  return instance
}

type CookieJar = Record<
  string,
  {
    set(options: {
      value: string
      httpOnly?: boolean
      sameSite?: 'lax' | 'strict' | 'none'
      path?: string
      maxAge?: number
    }): void
    remove(): void
  }
>

function grantSession(jar: CookieJar, token: string): void {
  jar[SESSION_COOKIE]?.set({
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

type IpResolver = { requestIP?: (request: Request) => { address: string } | null } | null

export function rateLimitKey(request: Request, server: IpResolver): string {
  const address = server?.requestIP?.(request)?.address
  if (typeof address === 'string' && address !== '') return address
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded !== null && forwarded !== '') return forwarded.split(',')[0]!.trim()
  return 'local'
}

async function publicDirExists(): Promise<boolean> {
  try {
    return (await stat(PUBLIC_DIR)).isDirectory()
  } catch {
    return false
  }
}

function guardedApi() {
  return new Elysia().onBeforeHandle(requireSession).get('/api/health', () => ({ ok: true }))
}

export async function createApp(): Promise<Elysia> {
  const app = new Elysia()
    .use(cookie())
    .get('/', async ({ request }) => {
      if (!(await isSetupComplete())) return setupPage()
      if (await verifyCookieHeader(request.headers.get('cookie'))) return appShellPage()
      return loginPage()
    })
    .get('/js/:file', async ({ params, set }) => {
      const code = await transpileClientModule(params.file)
      if (code === null) {
        set.status = 404
        return { error: 'not found' }
      }
      return new Response(code, { headers: JS_HEADERS })
    })
    .post('/api/setup', async ({ body, cookie: jar, set }) => {
      const result = await completeSetup((body as { password?: unknown } | null)?.password)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      grantSession(jar as unknown as CookieJar, result.token)
      return { ok: true }
    })
    .post('/api/login', async ({ body, cookie: jar, request, server, set }) => {
      const result = await attemptLogin(
        (body as { password?: unknown } | null)?.password,
        rateLimitKey(request, server as IpResolver),
      )
      if (!result.ok) {
        set.status = result.status
        if (result.retryAfterMs !== undefined) {
          set.headers['retry-after'] = String(Math.ceil(result.retryAfterMs / 1000))
        }
        return { error: result.error }
      }
      grantSession(jar as unknown as CookieJar, result.token)
      return { ok: true }
    })
    .post('/api/logout', ({ cookie: jar }) => {
      ;(jar as unknown as CookieJar)[SESSION_COOKIE]?.remove()
      return { ok: true }
    })
    .use(tabPages())
    .use(guardedApi())
    .use(quotaRoutes)
    .use(jobsRoutes(createJobManager(), realEngineResolver))
    .use(terminalsRoutes(createTerminalRegistry()))
    .use(flowRoutes)
    .use(secretsRoutes)

  if (await publicDirExists()) {
    app.use(staticPlugin({ assets: PUBLIC_DIR, prefix: '' }))
  }

  return app
}

if (import.meta.main) {
  const config = await readConfig().catch(() => ({ bind: DEFAULT_BIND }))
  const target = parseBind(config.bind)
  const app = await createApp()
  app.listen({ hostname: target.hostname, port: target.port })
  console.log(`mission-control listening on http://${target.hostname}:${target.port}`)
}
