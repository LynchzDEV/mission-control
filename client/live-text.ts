export type LiveFeed = {
  push(chunk: string): void
  setPartial(partial: boolean): void
  text(turnText: string): string
  pending(): boolean
}

export type LiveState = { delta: string; partial: boolean }

type LineShape = { type?: unknown; event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } }

export function applyLiveLine(state: LiveState, line: string): { state: LiveState; refresh: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { state, refresh: false }
  }
  const shape = parsed as LineShape
  if (shape.type === 'stream_event') {
    if (shape.event?.type === 'content_block_delta' && shape.event.delta?.type === 'text_delta' && typeof shape.event.delta.text === 'string') {
      return { state: { ...state, delta: state.delta + shape.event.delta.text }, refresh: false }
    }
    return { state, refresh: false }
  }
  if (shape.type === 'assistant') return { state: { delta: '', partial: false }, refresh: true }
  if (shape.type === 'user' || shape.type === 'result' || shape.type === 'mc_permission_request') return { state, refresh: true }
  return { state, refresh: false }
}

export function createLiveFeed(notify: () => void): LiveFeed {
  let buffer = ''
  let state: LiveState = { delta: '', partial: false }
  return {
    push(chunk) {
      buffer += chunk
      let end = buffer.indexOf('\n')
      while (end >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const outcome = applyLiveLine(state, line)
        state = outcome.state
        if (outcome.refresh) notify()
        end = buffer.indexOf('\n')
      }
    },
    setPartial(partial) {
      state = { ...state, partial }
    },
    text(turnText) {
      if (state.delta === '') return turnText
      return turnText + (state.partial || turnText === '' ? '' : '\n\n') + state.delta
    },
    pending() {
      return state.delta !== ''
    },
  }
}
