import { describe, expect, test } from 'bun:test'
import { localRequestAllowed } from './vite.config'

const origin = 'http://127.0.0.1:51947'
const request = (headers = {}, remoteAddress = '127.0.0.1', url = '/') => ({ headers: { host: '127.0.0.1:51947', ...headers }, socket: { remoteAddress }, url, method: 'GET' })

describe('local workspace access', () => {
  test('accepts local navigation and same-origin requests', () => {
    expect(localRequestAllowed(request(), origin)).toBe(true)
    expect(localRequestAllowed(request({ origin, 'sec-fetch-site': 'same-origin' }), origin)).toBe(true)
    expect(localRequestAllowed(request({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), origin)).toBe(true)
  })
  test('rejects remote peers, rebinding hosts, foreign origins, embeds and cross-site API calls', () => {
    expect(localRequestAllowed(request({}, '192.168.1.2'), origin)).toBe(false)
    expect(localRequestAllowed(request({ host: 'attacker.test:51947' }), origin)).toBe(false)
    expect(localRequestAllowed(request({ origin: 'http://attacker.test' }), origin)).toBe(false)
    expect(localRequestAllowed(request({ origin: 'http://127.0.0.1:8888' }), origin)).toBe(false)
    expect(localRequestAllowed(request({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' }), origin)).toBe(false)
    expect(localRequestAllowed(request({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, '127.0.0.1', '/api/terminals'), origin)).toBe(false)
    expect(localRequestAllowed(request({ 'sec-fetch-site': 'same-site' }), origin)).toBe(false)
  })
})
