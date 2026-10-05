const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const DATA_PATH_PREFIXES = ['/api/', '/ws/']
const TAILSCALE_HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/
const LOOPBACK_PEER_PATTERN = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

export type PeerServer = { requestIP(request: Request): { address: string } | null }

export function peerAddress(server: PeerServer | null | undefined, request: Request): string | null {
  return server?.requestIP(request)?.address ?? null
}

let warnedHostsValue: string | null = null

function listFromEnv(value: string | undefined): string[] {
  return (value ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(entry => entry !== '')
}

export function allowedRemoteHosts(): string[] {
  const raw = process.env.MISSION_CONTROL_ALLOWED_HOSTS
  const entries = listFromEnv(raw)
  const ignored = entries.filter(entry => !TAILSCALE_HOST_PATTERN.test(entry))
  if (ignored.length > 0 && raw !== warnedHostsValue) {
    warnedHostsValue = raw ?? null
    console.warn(`MISSION_CONTROL_ALLOWED_HOSTS ignores entries that are not Tailscale names (*.ts.net): ${ignored.join(', ')}`)
  }
  return entries.filter(entry => TAILSCALE_HOST_PATTERN.test(entry))
}

export function remoteAccessEnabled(): boolean {
  return allowedRemoteHosts().length > 0
}

function allowedRemoteUser(request: Request): boolean {
  const login = request.headers.get('tailscale-user-login')?.trim().toLowerCase()
  if (login === undefined || login === '') return false
  return listFromEnv(process.env.MISSION_CONTROL_ALLOWED_USERS).includes(login)
}

function remoteRequestAllowed(request: Request, name: string, peer: string | null | undefined): boolean {
  return allowedRemoteHosts().includes(name.toLowerCase())
    && peer !== null && peer !== undefined && LOOPBACK_PEER_PATTERN.test(peer)
    && allowedRemoteUser(request)
}

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

export function fromBrowser(request: Request): boolean {
  return request.headers.get('sec-fetch-site') === 'same-origin' && !request.headers.has('authorization')
}

export function localRequestAllowed(request: Request, peer?: string | null): boolean {
  const host = requestHost(request)
  const name = hostname(host)
  if (name === null) return false
  if (!LOCAL_HOSTS.has(name) && !remoteRequestAllowed(request, name, peer)) return false
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'null' && originHost(origin) !== host) return false
  const site = request.headers.get('sec-fetch-site')
  if (site === null || site === 'same-origin' || site === 'none') return true
  return isTopLevelPageNavigation(request)
}

export function localHostRequest(request: Request): boolean {
  const name = hostname(requestHost(request))
  return name !== null && LOCAL_HOSTS.has(name)
}
