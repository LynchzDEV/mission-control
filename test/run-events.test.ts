import { expect, test } from 'bun:test'
import { createRunEvents, eventStreamResponse } from '../server/run-events'

async function read(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  let buffer = ''
  while (frames.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
    const parts = buffer.split('\n\n'); buffer = parts.pop()!
    frames.push(...parts.filter(part => part.startsWith('data: ')).map(part => part.slice(6)))
  }
  reader.releaseLock()
  return frames
}

test('sends a snapshot at once, then again after a change, skipping identical ones', async () => {
  const events = createRunEvents()
  let value = 1
  const controller = new AbortController()
  const response = eventStreamResponse(events, () => ({ value }), controller.signal, { debounceMs: 5 })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const first = read(response, 2)
  events.changed()
  await Bun.sleep(20)
  value = 2
  events.changed()
  expect(await first).toEqual(['{"value":1}', '{"value":2}'])
  controller.abort()
})

test('a steady stream of changes still sends a snapshot within one window', async () => {
  const events = createRunEvents()
  let value = 0
  const controller = new AbortController()
  const response = eventStreamResponse(events, () => ({ value }), controller.signal, { debounceMs: 20 })
  const frames = read(response, 2)
  const noise = setInterval(() => { value++; events.changed() }, 5)
  const got = await Promise.race([frames, Bun.sleep(200).then(() => null)])
  clearInterval(noise)
  controller.abort()
  expect(got).not.toBeNull()
})

test('closing the connection unsubscribes and stops the heartbeat', async () => {
  const events = createRunEvents()
  const controller = new AbortController()
  let snapshots = 0
  eventStreamResponse(events, () => { snapshots++; return { snapshots } }, controller.signal, { debounceMs: 1, heartbeatMs: 5 })
  controller.abort()
  const before = snapshots
  events.changed()
  await Bun.sleep(30)
  expect(snapshots).toBe(before)
})
