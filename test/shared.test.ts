import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getJson } from '../client/shared'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('getJson / parse', () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
  })

  test('discards a bare top-level JSON array response to {}', async () => {
    const result = await getJson('/api/whatever')
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({})
  })

  test('an object envelope with an array property passes through untouched', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jobs: [{ id: 'a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const result = await getJson('/api/jobs')
    expect(result.data).toEqual({ jobs: [{ id: 'a' }] })
  })
})
