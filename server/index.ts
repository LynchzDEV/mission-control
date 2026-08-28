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
import { realEngineResolver } from './jobs-engine-iface'
import { jobsRoutes } from './routes/jobs'

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

function page(title: string, body: string): Response {
  const markup = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body>${body}</body>
</html>
`
  return new Response(markup, { headers: HTML_HEADERS })
}

function setupPage(): Response {
  return page(
    'Mission Control — Setup',
    `<main data-page="setup"><h1>MISSION CONTROL</h1><p>First run. Choose a password (min ${MIN_PASSWORD_LENGTH} characters).</p><form id="setup-form"><input type="password" name="password" autocomplete="new-password"><button type="submit">CREATE</button></form></main>`,
  )
}

function loginPage(): Response {
  return page(
    'Mission Control — Login',
    '<main data-page="login"><h1>MISSION CONTROL</h1><form id="login-form"><input type="password" name="password" autocomplete="current-password"><button type="submit">LOG IN</button></form></main>',
  )
}

function appShellPage(): Response {
  return page(
    'Mission Control',
    '<main data-page="app"><h1>MISSION CONTROL</h1><nav>LANES | DISPATCH | TERMINALS | REVIEW | SETTINGS</nav><p>Signed in.</p></main>',
  )
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
    .use(guardedApi())
    .use(quotaRoutes)
    .use(jobsRoutes(createJobManager(), realEngineResolver))

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
