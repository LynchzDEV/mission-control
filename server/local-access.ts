const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function hostname(host: string | null): string | null {
  if (host === null || host === '') return null
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(host)
  if (bracketed) return bracketed[1]!
  return host.split(':')[0]!
}

function requestHost(request: Request): string {
  return request.headers.get('host') ?? new URL(request.url).host
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return false
  try { return new URL(origin).host === requestHost(request) } catch { return false }
}

export function localRequestAllowed(request: Request): boolean {
  const host = hostname(requestHost(request))
  if (host === null || !LOCAL_HOSTS.has(host)) return false
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'null') {
    let originHost: string | null
    try { originHost = hostname(new URL(origin).host) } catch { return false }
    if (originHost === null || !LOCAL_HOSTS.has(originHost)) return false
  }
  const site = request.headers.get('sec-fetch-site')
  if (site === null || site === 'same-origin' || site === 'none') return true
  const topLevelDocument = request.method === 'GET'
    && request.headers.get('sec-fetch-mode') === 'navigate'
    && request.headers.get('sec-fetch-dest') === 'document'
  return topLevelDocument
}
