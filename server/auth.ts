import { timingSafeEqual } from 'node:crypto'

import { localRequestAllowed } from './local-access'
import { readApiToken } from './secrets'

const TOKEN_SCOPED_GET_ONLY_PATHS = new Set(['/api/flow', '/api/quota', '/api/meta', '/api/roles', '/api/models'])
const TOKEN_SCOPED_PREFIX = '/api/jobs'

// The one shared gate for what a Bearer API token may touch — extend this, not requireLocal's callers.
export function allowToken(pathname: string, method: string): boolean {
  const upperMethod = method.toUpperCase()
  if (pathname === '/api/studio/workflows' || pathname === '/api/studio/policy' || /^\/api\/studio\/workflows\/[^/]+\/revisions$/.test(pathname)) return upperMethod === 'GET'
  if (pathname === '/api/studio/runs' || /^\/api\/studio\/runs\/[^/]+$/.test(pathname)) return upperMethod === 'GET' || (pathname === '/api/studio/runs' && upperMethod === 'POST')
  if (/^\/api\/studio\/runs\/[^/]+\/(stop|retry)$/.test(pathname)) return upperMethod === 'POST'
  if (pathname === TOKEN_SCOPED_PREFIX || pathname.startsWith(`${TOKEN_SCOPED_PREFIX}/`)) {
    return upperMethod === 'GET' || upperMethod === 'POST'
  }
  if (/^\/api\/flow\/[^/]+\/plan(\/\d+)?$/.test(pathname)) {
    return upperMethod === 'POST' || upperMethod === 'PATCH'
  }
  if (/^\/api\/flow\/[^/]+\/run(\/stop)?$/.test(pathname)) {
    return upperMethod === 'POST' || upperMethod === 'GET'
  }
  if (/^\/api\/flow\/[^/]+\/(archive|unarchive)$/.test(pathname)) {
    return upperMethod === 'POST'
  }
  return TOKEN_SCOPED_GET_ONLY_PATHS.has(pathname) && upperMethod === 'GET'
}

function extractBearerToken(header: string | null): string | null {
  if (header === null) return null
  const match = /^Bearer (.+)$/.exec(header)
  return match?.[1] ?? null
}

export async function verifyBearerToken(header: string | null): Promise<boolean> {
  const provided = extractBearerToken(header)
  if (provided === null || provided === '') return false
  const expected = await readApiToken()
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

export type GuardContext = { request: Request; set: { status?: number | string } }

export async function requireLocal(context: GuardContext) {
  if (localRequestAllowed(context.request)) return
  const { pathname } = new URL(context.request.url)
  if (allowToken(pathname, context.request.method) && (await verifyBearerToken(context.request.headers.get('authorization')))) return
  context.set.status = 403
  return { error: 'local access only' }
}
