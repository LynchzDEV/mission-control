import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

import { writeOnlyClipboard } from '../client/terminal-state'

const fakeClipboard = () => {
  const written: string[] = []
  return { written, writeText: async (text: string) => { written.push(text) } }
}

describe('writeOnlyClipboard', () => {
  test('a copy from the app reaches the clipboard unchanged', async () => {
    const clipboard = fakeClipboard()
    await writeOnlyClipboard(clipboard).writeText('c', 'hello wörld')
    expect(clipboard.written).toEqual(['hello wörld'])
  })

  test('the app can never read the clipboard back', async () => {
    expect(await writeOnlyClipboard(fakeClipboard()).readText('c')).toBe('')
  })

  test('a page without clipboard access (plain http) drops the copy instead of crashing', async () => {
    await expect(Promise.resolve(writeOnlyClipboard(undefined).writeText('c', 'x'))).resolves.toBeUndefined()
  })

  test('a refused clipboard write does not throw', async () => {
    const provider = writeOnlyClipboard({ writeText: () => Promise.reject(new Error('Document is not focused')) })
    await expect(Promise.resolve(provider.writeText('c', 'x'))).resolves.toBeUndefined()
  })
})

describe('OSC 52 in a live terminal', () => {
  const saved = { window: globalThis.window, document: globalThis.document, self: (globalThis as { self?: unknown }).self }
  beforeAll(() => {
    const dom = new JSDOM('<!doctype html><body></body>')
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, self: dom.window })
  })
  afterAll(() => { Object.assign(globalThis, saved) })

  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  test('the escape Claude Code sends on select puts the text on the clipboard, and a read request answers empty', async () => {
    const { Terminal } = await import('@xterm/xterm')
    const { ClipboardAddon } = await import('@xterm/addon-clipboard')
    const clipboard = fakeClipboard()
    const terminal = new Terminal({ allowProposedApi: true })
    terminal.loadAddon(new ClipboardAddon(undefined, writeOnlyClipboard(clipboard)))
    const replies: string[] = []
    terminal.onData(data => replies.push(data))

    terminal.write('\x1b]52;c;aGVsbG8=\x07')
    terminal.write('\x1b]52;c;?\x07')
    await new Promise<void>(resolve => terminal.write('', resolve))
    await settle()

    expect(clipboard.written).toEqual(['hello'])
    expect(replies.join('')).not.toContain('aGVsbG8')
    terminal.dispose()
  })
})
