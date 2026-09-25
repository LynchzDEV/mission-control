import DOMPurify from 'dompurify'
import { marked } from 'marked'

const BLOCK_CLASSES: Record<string, string> = {
  P: 'md-para', UL: 'md-list', OL: 'md-list', PRE: 'md-code', BLOCKQUOTE: 'md-quote', TABLE: 'md-table',
  H1: 'md-heading md-h1', H2: 'md-heading md-h2', H3: 'md-heading md-h3', H4: 'md-heading md-h3', H5: 'md-heading md-h3', H6: 'md-heading md-h3',
}

export function renderMarkdown(source: string): DocumentFragment {
  const html = marked.parse(source, { gfm: true, async: false })
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_ATTR: ['id', 'name', 'style'],
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'img', 'iframe', 'object', 'embed', 'style'],
    SANITIZE_NAMED_PROPS: true,
  })
  for (const node of fragment.querySelectorAll<HTMLElement>(Object.keys(BLOCK_CLASSES).join(','))) node.className = BLOCK_CLASSES[node.tagName]!
  for (const pre of fragment.querySelectorAll<HTMLElement>('pre')) {
    const lang = /language-([\w+-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1]
    if (lang) pre.dataset.lang = lang
  }
  for (const link of fragment.querySelectorAll('a')) {
    link.className = 'md-link'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  return fragment
}
