import { afterAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const { window } = new JSDOM('')
Object.assign(globalThis, { window, document: window.document })
const { attachmentChip, formatSize } = await import('../client/attachments')
const { shellQuote } = await import('../client/shared')
afterAll(() => { window.close(); Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'document') })

describe('formatSize', () => {
  test('small files get one decimal, mid files round, big files switch to MB', () => {
    expect(formatSize(9728)).toBe('9.5 KB')
    expect(formatSize(219_136)).toBe('214 KB')
    expect(formatSize(1_258_291)).toBe('1.2 MB')
  })
})

describe('attachmentChip', () => {
  test('a plain file becomes an icon chip with name, size and remove button', () => {
    const file = new File(['x'.repeat(9728)], 'notes.txt', { type: 'text/plain' })
    const { chip, token, url } = attachmentChip('/drops/notes.txt', file, shellQuote)
    expect(token).toBe('/drops/notes.txt')
    expect(url).toBeNull()
    expect(chip.querySelector('.attach-icon svg use')?.getAttribute('href')).toBe('#file-icon')
    expect(chip.querySelector('.attach-name')!.textContent).toBe('notes.txt')
    expect(chip.querySelector('.attach-size')!.textContent).toBe('9.5 KB')
    const remove = chip.querySelector<HTMLButtonElement>('.attach-remove')!
    expect(remove.type).toBe('button')
    expect(remove.getAttribute('aria-label')).toBe('Remove notes.txt')
  })

  test('an image chip carries an object URL thumbnail', () => {
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    const { chip, url } = attachmentChip('/drops/shot.png', file, shellQuote)
    expect(url).toBeTypeOf('string')
    expect(chip.querySelector('img.attach-thumb')!.getAttribute('src')).toBe(url)
    expect(chip.querySelector('.attach-icon')).toBeNull()
  })

  test('a dropped Finder path has no file, so no size shows and the name is the basename', () => {
    const { chip } = attachmentChip('/Users/me/Desktop/shot.png', null, shellQuote)
    expect(chip.querySelector('.attach-name')!.textContent).toBe('shot.png')
    expect(chip.querySelector('.attach-size')).toBeNull()
  })
})
