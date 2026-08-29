import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getJson, streamJobLog } from '../client/shared'

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

class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.last = this
  }

  close(): void {
    this.closed = true
  }
}

describe('streamJobLog', () => {
  const originalEventSource = globalThis.EventSource

  beforeEach(() => {
    FakeEventSource.last = null
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  test('subscribes to the job stream endpoint and forwards each line', () => {
    const lines: string[] = []
    const stream = streamJobLog('job-1', (line) => lines.push(line), () => {})

    expect((stream as unknown as FakeEventSource).url).toBe('/api/jobs/job-1/stream')
    FakeEventSource.last?.onmessage?.({ data: 'first' })
    FakeEventSource.last?.onmessage?.({ data: 'second' })
    expect(lines).toEqual(['first', 'second'])
  })

  test('signals the end once and closes the source on error', () => {
    let ended = 0
    const stream = streamJobLog('job-2', () => {}, () => {
      ended += 1
    })

    FakeEventSource.last?.onerror?.()
    expect(ended).toBe(1)
    expect((stream as unknown as FakeEventSource).closed).toBe(true)
  })
})
