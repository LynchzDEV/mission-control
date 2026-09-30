import { describe, expect, test } from 'bun:test'
import { applyLiveLine, createLiveFeed } from '../client/live-text'

describe('live text feed', () => {
  test('a JSON line split across two chunks parses once', () => {
    const refreshes: number[] = []
    const feed = createLiveFeed(() => refreshes.push(Date.now()))
    feed.push('{"type":"stream_event","event":{"type":"content_block_de')
    expect(feed.pending()).toBe(false)
    feed.push('lta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}\n')
    expect(feed.text('')).toBe('Hello')
    feed.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}}\n')
    expect(feed.text('')).toBe('Hello there')
    expect(refreshes).toHaveLength(0)
  })

  test('an assistant line clears the delta and schedules a refresh', () => {
    let refreshes = 0
    const feed = createLiveFeed(() => { refreshes += 1 })
    feed.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}}\n')
    feed.push('{"type":"assistant","message":{"role":"assistant","content":[]}}\n')
    expect(feed.pending()).toBe(false)
    expect(refreshes).toBe(1)
  })

  test('result, user and permission lines schedule a refresh without touching the delta', () => {
    for (const type of ['user', 'result', 'mc_permission_request']) {
      const outcome = applyLiveLine({ delta: 'kept', partial: true }, `{"type":"${type}"}`)
      expect(outcome).toEqual({ state: { delta: 'kept', partial: true }, refresh: true })
    }
  })

  test('text joins the turn text with a blank line unless it is partial or the turn is empty', () => {
    let feed = createLiveFeed(() => {})
    feed.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"more"}}}\n')
    expect(feed.text('Settled text')).toBe('Settled text\n\nmore')
    feed.setPartial(true)
    expect(feed.text('Settled text')).toBe('Settled textmore')
    feed = createLiveFeed(() => {})
    feed.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}}\n')
    expect(feed.text('')).toBe('first')
  })

  test('a broken line is ignored', () => {
    const outcome = applyLiveLine({ delta: 'x', partial: false }, 'not json')
    expect(outcome).toEqual({ state: { delta: 'x', partial: false }, refresh: false })
  })
})
