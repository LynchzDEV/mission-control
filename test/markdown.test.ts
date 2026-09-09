import { describe, expect, test } from 'bun:test'
import { parseInline, parseMarkdown } from '../client/markdown'

describe('parseMarkdown', () => {
  test('splits fences, headings, lists, quotes and paragraphs in order', () => {
    const blocks = parseMarkdown(['# Plan', 'First line', 'second line', '', '- one', '- two', '  continued', '1. a', '2) b', '> note', '```ts', 'const x = 1', '', '```', 'tail'].join('\n'))
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'para', 'list', 'list', 'quote', 'code', 'para'])
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'Plan' })
    expect(blocks[1]).toEqual({ kind: 'para', text: 'First line\nsecond line' })
    expect(blocks[2]).toEqual({ kind: 'list', ordered: false, items: ['one', 'two\ncontinued'] })
    expect(blocks[3]).toEqual({ kind: 'list', ordered: true, items: ['a', 'b'] })
    expect(blocks[4]).toEqual({ kind: 'quote', text: 'note' })
    expect(blocks[5]).toEqual({ kind: 'code', lang: 'ts', text: 'const x = 1\n' })
  })

  test('an unterminated fence swallows the rest and plain text stays one paragraph', () => {
    expect(parseMarkdown('```\nraw')).toEqual([{ kind: 'code', lang: '', text: 'raw' }])
    expect(parseMarkdown('just words\r\nmore words')).toEqual([{ kind: 'para', text: 'just words\nmore words' }])
    expect(parseMarkdown('')).toEqual([])
  })
})

describe('parseInline', () => {
  test('marks code, bold and italics and leaves stray markers alone', () => {
    expect(parseInline('run `bun test` then **commit** and _push_ 2*3')).toEqual([
      { kind: 'text', text: 'run ' }, { kind: 'code', text: 'bun test' }, { kind: 'text', text: ' then ' }, { kind: 'strong', text: 'commit' },
      { kind: 'text', text: ' and ' }, { kind: 'em', text: 'push' }, { kind: 'text', text: ' 2*3' },
    ])
    expect(parseInline('plain')).toEqual([{ kind: 'text', text: 'plain' }])
  })
})
