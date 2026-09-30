import { afterAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const { window } = new JSDOM('')
Object.assign(globalThis, { window, document: window.document })
const { renderMarkdown } = await import('../client/markdown')
afterAll(() => { window.close(); Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'document') })

function render(source: string): HTMLElement {
  const host = document.createElement('div')
  host.append(renderMarkdown(source))
  return host
}

describe('renderMarkdown', () => {
  test('fences, headings, lists, quotes and paragraphs keep their classes in order', () => {
    const host = render(['# Plan', 'First line', 'second line', '', '- one', '- two', '', '1. a', '2. b', '', '> note', '', '```ts', 'const x = 1', '```', '', 'tail'].join('\n'))
    expect([...host.children].map((node) => `${node.tagName.toLowerCase()}.${node.className}`)).toEqual([
      'h1.md-heading md-h1', 'p.md-para', 'ul.md-list', 'ol.md-list', 'blockquote.md-quote', 'div.code-card', 'p.md-para',
    ])
    expect([...host.querySelectorAll('ul.md-list li')].map((li) => li.textContent)).toEqual(['one', 'two'])
    expect([...host.querySelectorAll('ol.md-list li')].map((li) => li.textContent)).toEqual(['a', 'b'])
    const pre = host.querySelector<HTMLElement>('pre.md-code')!
    expect(pre.dataset.lang).toBe('ts')
    expect(pre.querySelector('code')!.textContent).toBe('const x = 1\n')
  })

  test('a fenced code block gets a code card with its language and a copy button', () => {
    const host = render('```ts\nconst x = 1\n```')
    const card = host.querySelector<HTMLElement>('.code-card')!
    expect(card.querySelector<HTMLElement>('.code-head .code-lang')!.textContent).toBe('ts')
    const button = card.querySelector<HTMLButtonElement>('.code-head .copy-button')!
    expect(button.type).toBe('button')
    expect(card.querySelector('pre.md-code')!.querySelector('code')!.textContent).toBe('const x = 1\n')
  })

  test('a fence without a language labels itself text', () => {
    expect(render('```\nplain\n```').querySelector<HTMLElement>('.code-lang')!.textContent).toBe('text')
  })

  test('html inside a fence stays text inside the code card', () => {
    const code = render('```\n<script>alert(1)</script>\n```').querySelector('.code-card code')!
    expect(code.textContent).toContain('<script>alert(1)</script>')
    expect(code.querySelector('script')).toBeNull()
  })

  test('deep headings cap at md-h3 and an empty source renders nothing', () => {
    expect(render('#### deep').querySelector('h4')!.className).toBe('md-heading md-h3')
    expect(render('').childNodes.length).toBe(0)
  })

  test('links open in a new tab with a safe rel', () => {
    const link = render('[a](http://x.dev)').querySelector('a.md-link')!
    expect(link.getAttribute('href')).toBe('http://x.dev')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  test('gfm tables and strikethrough render', () => {
    const host = render(['| a | b |', '| - | - |', '| 1 | 2 |', '', '~~gone~~'].join('\n'))
    expect(host.querySelectorAll('table.md-table th').length).toBe(2)
    expect(host.querySelector('del')!.textContent).toBe('gone')
  })

  test('raw html is sanitized', () => {
    const host = render('<img src=x onerror=alert(1)>')
    expect(host.innerHTML).not.toContain('onerror')
  })

  test('model html cannot set element ids that hijack page templates', () => {
    expect(render('<p id="assistant-row">x</p>').querySelector('[id]')).toBeNull()
  })

  test('model html cannot style elements', () => {
    expect(render('<div style="position:fixed">x</div>').querySelector('[style]')).toBeNull()
  })

  test('model html cannot render forms or inputs', () => {
    const host = render('<form action="https://evil.test"><input></form>')
    expect(host.querySelector('form')).toBeNull()
    expect(host.querySelector('input')).toBeNull()
  })

  test('markdown images do not load', () => {
    expect(render('![t](https://evil.test/p.png)').querySelector('img')).toBeNull()
  })
})
