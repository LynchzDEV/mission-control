const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const DATA_PATH_PREFIXES = ['/api/', '/ws/']

function hostname(host: string | null): string | null {
  if (host === null || host === '') return null
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(host)
  if (bracketed) return bracketed[1]!
  return host.split(':')[0]!
}

function requestHost(request: Request): string {
  return request.headers.get('host') ?? new URL(request.url).host
}

function originHost(origin: string): string | null {
  try { return new URL(origin).host } catch { return null }
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return false
  return originHost(origin) === requestHost(request)
}

function isTopLevelPageNavigation(request: Request): boolean {
  const path = new URL(request.url).pathname
  return request.method === 'GET'
    && request.headers.get('sec-fetch-mode') === 'navigate'
    && request.headers.get('sec-fetch-dest') === 'document'
    && !DATA_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
}

export function localRequestAllowed(request: Request): boolean {
  const host = requestHost(request)
  const name = hostname(host)
  if (name === null || !LOCAL_HOSTS.has(name)) return false
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'null' && originHost(origin) !== host) return false
  const site = request.headers.get('sec-fetch-site')
  if (site === null || site === 'same-origin' || site === 'none') return true
  return isTopLevelPageNavigation(request)
}
