import { describe, expect, test } from 'bun:test'
import { localRequestAllowed, sameOrigin } from '../server/local-access'

const req = (headers: Record<string, string>, url = 'http://127.0.0.1:7777/api/jobs', method = 'GET') =>
  new Request(url, { method, headers })

describe('localRequestAllowed', () => {
  test('allows a same-origin request from the app itself', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })
  test('allows localhost and [::1] hosts on any port', () => {
    expect(localRequestAllowed(req({ host: 'localhost:7781' }))).toBe(true)
    expect(localRequestAllowed(req({ host: '[::1]:7777' }))).toBe(true)
  })
  test('rejects a non-local Host (DNS rebinding)', () => {
    expect(localRequestAllowed(req({ host: 'rebind.example:7777' }))).toBe(false)
  })
  test('rejects a foreign Origin', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, 'http://127.0.0.1:7777/api/jobs', 'POST'))).toBe(false)
  })
  test('rejects a cross-site fetch even without Origin', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }))).toBe(false)
  })
  test('allows a top-level navigation from elsewhere', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'http://127.0.0.1:7777/'))).toBe(true)
  })
  test('rejects an embedded document from another site', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, 'http://127.0.0.1:7777/'))).toBe(false)
  })
  test('falls back to the request URL host when no Host header is sent', () => {
    expect(localRequestAllowed(new Request('http://localhost/api/jobs'))).toBe(true)
    expect(localRequestAllowed(new Request('http://rebind.example/api/jobs'))).toBe(false)
  })
  test('rejects a malformed Origin', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', origin: 'not a url' }))).toBe(false)
  })
  test('rejects an empty Host', () => {
    expect(localRequestAllowed(req({ host: '' }, 'http://localhost/x'))).toBe(false)
  })
  test('rejects an Origin on another local port', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', origin: 'http://127.0.0.1:5173' }))).toBe(false)
  })
  test('accepts an Origin that matches the Host exactly', () => {
    expect(localRequestAllowed(req({ host: '[::1]:7777', origin: 'http://[::1]:7777', 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })
  test('a cross-site top-level navigation is refused under /api and /ws but allowed elsewhere', () => {
    const navigation = { host: '127.0.0.1:7777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    expect(localRequestAllowed(req(navigation, 'http://127.0.0.1:7777/api/jobs'))).toBe(false)
    expect(localRequestAllowed(req(navigation, 'http://127.0.0.1:7777/ws/terminal/1'))).toBe(false)
    expect(localRequestAllowed(req(navigation, 'http://127.0.0.1:7777/'))).toBe(true)
  })
  test('ignores leftover session cookies', () => {
    expect(localRequestAllowed(req({ host: '127.0.0.1:7777', cookie: 'mc_session=1.2.3' }))).toBe(true)
  })
})

describe('sameOrigin', () => {
  test('sameOrigin accepts the app\'s own origin', () => {
    expect(sameOrigin(req({ host: '127.0.0.1:7777', origin: 'http://127.0.0.1:7777' }))).toBe(true)
  })
  test('sameOrigin accepts [::1]', () => {
    expect(sameOrigin(req({ host: '[::1]:7777', origin: 'http://[::1]:7777' }))).toBe(true)
  })
  test('sameOrigin rejects another local port and a missing Origin', () => {
    expect(sameOrigin(req({ host: '127.0.0.1:7777', origin: 'http://127.0.0.1:5173' }))).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:7777' }))).toBe(false)
  })
})
