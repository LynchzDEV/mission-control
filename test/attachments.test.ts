import { describe, expect, test } from 'bun:test'
import { attachmentKind } from '../client/attachments'

describe('attachmentKind', () => {
  test('a Finder path with an image extension reads as an image, case-insensitively', () => {
    expect(attachmentKind('/Users/me/Desktop/shot.PNG', null)).toBe('image')
    expect(attachmentKind('/Users/me/Desktop/shot.jpeg', null)).toBe('image')
    expect(attachmentKind('/Users/me/Desktop/shot.webp', null)).toBe('image')
    expect(attachmentKind('/Users/me/Desktop/notes.txt', null)).toBe('file')
    expect(attachmentKind('/Users/me/Desktop/noext', null)).toBe('file')
  })

  test('a pasted File decides by its MIME type', () => {
    expect(attachmentKind('/drops/x.bin', { type: 'image/png' } as File)).toBe('image')
    expect(attachmentKind('/drops/shot.png', { type: 'text/plain' } as File)).toBe('file')
  })
})
