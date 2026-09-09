export type Inline = { kind: 'text' | 'code' | 'strong' | 'em'; text: string }
export type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string }

const FENCE = /^\s*```\s*([\w+-]*)\s*$/
const FENCE_END = /^\s*```\s*$/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/
const ORDERED = /^\s*\d+[.)]\s+/
const QUOTE = /^\s*>\s?/
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\b_[^_\n]+_\b)/g

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = (): void => { if (para.length) blocks.push({ kind: 'para', text: para.join('\n') }); para = [] }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE_END.test(lines[i]!)) body.push(lines[i++]!)
      i++
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! }); i++; continue }
    if (BULLET.test(line)) {
      flush()
      const ordered = ORDERED.test(line)
      const items: string[] = []
      while (i < lines.length && BULLET.test(lines[i]!) && ORDERED.test(lines[i]!) === ordered) {
        items.push(lines[i]!.replace(BULLET, ''))
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !BULLET.test(lines[i]!)) { items[items.length - 1] += `\n${lines[i]!.trim()}`; i++ }
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    if (QUOTE.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE, ''))
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    if (line.trim() === '') { flush(); i++; continue }
    para.push(line)
    i++
  }
  flush()
  return blocks
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const raw = match[0], at = match.index ?? 0
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    if (raw.startsWith('`')) out.push({ kind: 'code', text: raw.slice(1, -1) })
    else if (raw.startsWith('**') || raw.startsWith('__')) out.push({ kind: 'strong', text: raw.slice(2, -2) })
    else out.push({ kind: 'em', text: raw.slice(1, -1) })
    last = at + raw.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

function fill(parent: HTMLElement, text: string): void {
  for (const piece of parseInline(text)) {
    if (piece.kind === 'text') { parent.append(document.createTextNode(piece.text)); continue }
    const node = document.createElement(piece.kind === 'code' ? 'code' : piece.kind === 'strong' ? 'strong' : 'em')
    node.textContent = piece.text
    parent.append(node)
  }
}

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const block of parseMarkdown(source)) {
    if (block.kind === 'code') {
      const pre = document.createElement('pre')
      pre.className = 'md-code'
      if (block.lang) pre.dataset.lang = block.lang
      const code = document.createElement('code')
      code.textContent = block.text
      pre.append(code)
      fragment.append(pre)
      continue
    }
    if (block.kind === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul')
      list.className = 'md-list'
      for (const item of block.items) { const li = document.createElement('li'); fill(li, item); list.append(li) }
      fragment.append(list)
      continue
    }
    const node = document.createElement(block.kind === 'quote' ? 'blockquote' : 'p')
    node.className = block.kind === 'heading' ? `md-heading md-h${Math.min(block.level, 3)}` : block.kind === 'quote' ? 'md-quote' : 'md-para'
    fill(node, block.text)
    fragment.append(node)
  }
  return fragment
}
