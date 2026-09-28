export type RunEvents = { changed(): void; subscribe(listener: () => void): () => void }

export function createRunEvents(): RunEvents {
  const listeners = new Set<() => void>()
  return {
    changed: () => { for (const listener of listeners) listener() },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

export function eventStreamResponse(events: RunEvents, snapshot: () => unknown, signal: AbortSignal, options: { debounceMs?: number; heartbeatMs?: number } = {}): Response {
  const encoder = new TextEncoder()
  let last = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let unsubscribe = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => { if (!signal.aborted) controller.enqueue(encoder.encode(text)) }
      const send = () => { const text = JSON.stringify(snapshot()); if (text === last) return; last = text; write(`data: ${text}\n\n`) }
      const close = () => { unsubscribe(); clearTimeout(timer); clearInterval(heartbeat); try { controller.close() } catch {} }
      if (signal.aborted) { close(); return }
      send()
      unsubscribe = events.subscribe(() => { if (!timer) timer = setTimeout(() => { timer = undefined; send() }, options.debounceMs ?? 100) })
      heartbeat = setInterval(() => write(': ping\n\n'), options.heartbeatMs ?? 15000)
      signal.addEventListener('abort', close, { once: true })
    },
    cancel() { unsubscribe(); clearTimeout(timer); clearInterval(heartbeat) },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
}
