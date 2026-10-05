import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { requireLocal } from '../server/auth'
import { allowedRemoteHosts, localHostRequest, localRequestAllowed, proxied, remoteAccessEnabled } from '../server/local-access'

const HOST = 'lynchzpc-wsl.tail1234.ts.net'
const USER = 'lynchz@example.com'

function remote(headers: Record<string, string> = {}, path = '/api/jobs', method = 'GET'): Request {
  return new Request(`http://127.0.0.1:7777${path}`, {
    method,
    headers: { host: HOST, 'tailscale-user-login': USER, 'sec-fetch-site': 'same-origin', ...headers },
  })
}

function withoutHeader(request: Request, name: string): Request {
  const headers = new Headers(request.headers)
  headers.delete(name)
  return new Request(request.url, { method: request.method, headers })
}

let savedHosts: string | undefined
let savedUsers: string | undefined

beforeEach(() => {
  savedHosts = process.env.MISSION_CONTROL_ALLOWED_HOSTS
  savedUsers = process.env.MISSION_CONTROL_ALLOWED_USERS
  process.env.MISSION_CONTROL_ALLOWED_HOSTS = HOST
  process.env.MISSION_CONTROL_ALLOWED_USERS = USER
})

afterEach(() => {
  if (savedHosts === undefined) delete process.env.MISSION_CONTROL_ALLOWED_HOSTS
  else process.env.MISSION_CONTROL_ALLOWED_HOSTS = savedHosts
  if (savedUsers === undefined) delete process.env.MISSION_CONTROL_ALLOWED_USERS
  else process.env.MISSION_CONTROL_ALLOWED_USERS = savedUsers
})

describe('allowedRemoteHosts', () => {
  test('is empty and remote access off when the variable is unset', () => {
    delete process.env.MISSION_CONTROL_ALLOWED_HOSTS
    expect(allowedRemoteHosts()).toEqual([])
    expect(remoteAccessEnabled()).toBe(false)
  })

  test('trims and lowercases Tailscale MagicDNS names', () => {
    process.env.MISSION_CONTROL_ALLOWED_HOSTS = ` LynchzPC-WSL.Tail1234.TS.NET , other.tail1234.ts.net`
    expect(allowedRemoteHosts()).toEqual([HOST, 'other.tail1234.ts.net'])
    expect(remoteAccessEnabled()).toBe(true)
  })

  test('ignores wildcards, IPs, ports, other domains and inner whitespace with one warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      process.env.MISSION_CONTROL_ALLOWED_HOSTS = `*.tail1234.ts.net,100.64.0.1,${HOST}:443,example.com,bad host.ts.net,ts.net,.ts.net,${HOST}`
      expect(allowedRemoteHosts()).toEqual([HOST])
      expect(allowedRemoteHosts()).toEqual([HOST])
      expect(warn).toHaveBeenCalledTimes(1)
      const message = String(warn.mock.calls[0]?.[0])
      for (const entry of ['*.tail1234.ts.net', '100.64.0.1', `${HOST}:443`, 'example.com', 'bad host.ts.net']) expect(message).toContain(entry)
    } finally {
      warn.mockRestore()
    }
  })

  test('only invalid entries leaves remote access off', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      process.env.MISSION_CONTROL_ALLOWED_HOSTS = 'example.com'
      expect(remoteAccessEnabled()).toBe(false)
      expect(localRequestAllowed(new Request('http://example.com/api/jobs', { headers: { 'tailscale-user-login': USER } }), '127.0.0.1')).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('localRequestAllowed for an allowed Tailscale host', () => {
  test('accepts an allowed user arriving through the local proxy', () => {
    expect(localRequestAllowed(remote(), '127.0.0.1')).toBe(true)
    expect(localRequestAllowed(remote(), '::1')).toBe(true)
    expect(localRequestAllowed(remote(), '::ffff:127.0.0.1')).toBe(true)
  })

  test('matches the host and the login case-insensitively', () => {
    expect(localRequestAllowed(remote({ host: HOST.toUpperCase(), 'tailscale-user-login': USER.toUpperCase() }), '127.0.0.1')).toBe(true)
  })

  test('accepts a POST whose Origin matches the host', () => {
    expect(localRequestAllowed(remote({ origin: `https://${HOST}` }, '/api/jobs', 'POST'), '127.0.0.1')).toBe(true)
  })

  test('refuses a wrong or missing user', () => {
    expect(localRequestAllowed(remote({ 'tailscale-user-login': 'someone@example.com' }), '127.0.0.1')).toBe(false)
    expect(localRequestAllowed(remote({ 'tailscale-user-login': '' }), '127.0.0.1')).toBe(false)
    expect(localRequestAllowed(withoutHeader(remote(), 'tailscale-user-login'), '127.0.0.1')).toBe(false)
  })

  test('refuses everyone when no users are allowed', () => {
    delete process.env.MISSION_CONTROL_ALLOWED_USERS
    expect(localRequestAllowed(remote(), '127.0.0.1')).toBe(false)
    process.env.MISSION_CONTROL_ALLOWED_USERS = ' , '
    expect(localRequestAllowed(remote(), '127.0.0.1')).toBe(false)
  })

  test('refuses a host that is not allowed', () => {
    expect(localRequestAllowed(remote({ host: 'otherpc.tail1234.ts.net' }), '127.0.0.1')).toBe(false)
    delete process.env.MISSION_CONTROL_ALLOWED_HOSTS
    expect(localRequestAllowed(remote(), '127.0.0.1')).toBe(false)
  })

  test('refuses an Origin that does not match the host', () => {
    expect(localRequestAllowed(remote({ origin: 'https://evil.example' }, '/api/jobs', 'POST'), '127.0.0.1')).toBe(false)
    expect(localRequestAllowed(remote({ origin: 'http://127.0.0.1:7777' }, '/api/jobs', 'POST'), '127.0.0.1')).toBe(false)
  })

  test('keeps the Sec-Fetch-Site rules', () => {
    expect(localRequestAllowed(remote({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }), '127.0.0.1')).toBe(false)
    const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    expect(localRequestAllowed(remote(navigation, '/'), '127.0.0.1')).toBe(true)
    expect(localRequestAllowed(remote(navigation, '/api/jobs'), '127.0.0.1')).toBe(false)
  })

  test('refuses a peer that is not loopback or is unknown', () => {
    expect(localRequestAllowed(remote(), '100.64.0.2')).toBe(false)
    expect(localRequestAllowed(remote(), '192.168.1.10')).toBe(false)
    expect(localRequestAllowed(remote(), null)).toBe(false)
    expect(localRequestAllowed(remote())).toBe(false)
  })

  test('leaves localhost behaviour unchanged, with or without a peer', () => {
    const local = new Request('http://127.0.0.1:7777/api/jobs', { headers: { host: '127.0.0.1:7777', 'sec-fetch-site': 'same-origin' } })
    expect(localRequestAllowed(local)).toBe(true)
    expect(localRequestAllowed(local, '100.64.0.2')).toBe(true)
  })
})

describe('requireLocal for an allowed Tailscale host', () => {
  const server = (address: string) => ({ requestIP: () => ({ address }) })

  test('passes with a loopback peer', async () => {
    const set: { status?: number | string } = {}
    expect(await requireLocal({ request: remote(), set, server: server('127.0.0.1') })).toBeUndefined()
    expect(set.status).toBeUndefined()
  })

  test('refuses a non-loopback peer or no server with the usual 403', async () => {
    for (const context of [{ server: server('100.64.0.2') }, { server: null }, {}]) {
      const set: { status?: number | string } = {}
      expect(await requireLocal({ request: remote(), set, ...context })).toEqual({ error: 'local access only' })
      expect(set.status).toBe(403)
    }
  })
})

describe('a request that came through a proxy', () => {
  const FORWARDED = { 'x-forwarded-for': '100.64.0.2', 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https' }

  function at(host: string, headers: Record<string, string> = {}, path = '/api/jobs', method = 'GET'): Request {
    return new Request(`http://127.0.0.1:7777${path}`, { method, headers: { host, ...headers } })
  }

  test('is recognised by any forwarding or Tailscale header', () => {
    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'Tailscale-Headers-Info']) {
      expect(proxied(at('localhost', { [header]: 'x' }))).toBe(true)
    }
    expect(proxied(at('localhost', { 'sec-fetch-site': 'same-origin' }))).toBe(false)
  })

  test('X-Forwarded-For alone is enough to refuse Host: localhost', () => {
    expect(localRequestAllowed(at('localhost', { 'x-forwarded-for': '100.64.0.2' }), '127.0.0.1')).toBe(false)
  })

  test('never passes as local, whatever local name it claims', () => {
    for (const host of ['localhost', 'localhost:7777', '127.0.0.1', '127.0.0.1:7777', '[::1]', '[::1]:7777']) {
      expect(localRequestAllowed(at(host, FORWARDED), '127.0.0.1')).toBe(false)
      expect(localRequestAllowed(at(host, FORWARDED, '/'), '127.0.0.1')).toBe(false)
      expect(localRequestAllowed(at(host, { ...FORWARDED, origin: `http://${host}` }, '/api/jobs', 'POST'), '127.0.0.1')).toBe(false)
    }
  })

  test('is refused on the local name even with an allowed login', () => {
    expect(localRequestAllowed(at('localhost', { ...FORWARDED, 'tailscale-user-login': USER }), '127.0.0.1')).toBe(false)
  })

  test('passes on an allowed host with an allowed login', () => {
    const allowed = { ...FORWARDED, 'tailscale-user-login': USER }
    expect(localRequestAllowed(at(HOST, allowed), '127.0.0.1')).toBe(true)
    expect(localRequestAllowed(at(HOST, { ...allowed, origin: `https://${HOST}` }, '/api/jobs', 'POST'), '127.0.0.1')).toBe(true)
    expect(localRequestAllowed(at(HOST, { ...FORWARDED, 'tailscale-user-login': 'someone@example.com' }), '127.0.0.1')).toBe(false)
    expect(localRequestAllowed(at(HOST, FORWARDED), '127.0.0.1')).toBe(false)
  })

  test('is refused as a local host for plugin frame assets', () => {
    expect(localHostRequest(at('localhost'))).toBe(true)
    expect(localHostRequest(at('localhost', { 'x-forwarded-for': '100.64.0.2' }))).toBe(false)
    expect(localHostRequest(at('127.0.0.1:7777', FORWARDED))).toBe(false)
  })

  test('a Tailscale-User-Login header alone marks Host: localhost as proxied, which refuses it', () => {
    expect(localRequestAllowed(at('localhost', { 'tailscale-user-login': USER }), '127.0.0.1')).toBe(false)
    expect(localRequestAllowed(at('localhost'), '127.0.0.1')).toBe(true)
  })

  test('requireLocal refuses a proxied localhost request with the usual 403', async () => {
    const set: { status?: number | string } = {}
    const server = { requestIP: () => ({ address: '127.0.0.1' }) }
    expect(await requireLocal({ request: at('localhost', FORWARDED), set, server })).toEqual({ error: 'local access only' })
    expect(set.status).toBe(403)
  })
})
