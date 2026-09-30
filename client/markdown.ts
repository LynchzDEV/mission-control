import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { copyButton } from './shared'

const BLOCK_CLASSES: Record<string, string> = {
  P: 'md-para', UL: 'md-list', OL: 'md-list', PRE: 'md-code', BLOCKQUOTE: 'md-quote', TABLE: 'md-table',
  H1: 'md-heading md-h1', H2: 'md-heading md-h2', H3: 'md-heading md-h3', H4: 'md-heading md-h3', H5: 'md-heading md-h3', H6: 'md-heading md-h3',
}

const HIGHLIGHT_URL = '/js/code-highlight.js'
type HighlightModule = { highlight(code: string, lang: string): Promise<string | null> }
let highlightModule: Promise<HighlightModule | null> | null = null

function loadHighlighter(): Promise<HighlightModule | null> {
  highlightModule ??= import(HIGHLIGHT_URL).then((module: HighlightModule) => module).catch(() => null)
  return highlightModule
}

function applyHighlight(pre: HTMLElement, code: string, lang: string): void {
  void loadHighlighter().then(module => module?.highlight(code, lang) ?? null).then(html => {
    if (html === null) return
    const template = document.createElement('template')
    template.innerHTML = html
    const target = pre.querySelector('code') ?? pre
    const highlighted = template.content.querySelector('code')
    if (highlighted === null) return
    target.replaceChildren(...highlighted.childNodes)
  })
}

function wrapCodeCard(pre: HTMLElement, lang: string | undefined): void {
  const card = document.createElement('div')
  card.className = 'code-card'
  const head = document.createElement('div')
  head.className = 'code-head'
  const label = document.createElement('span')
  label.className = 'code-lang'
  label.textContent = lang ?? 'text'
  head.append(label, copyButton(pre.querySelector('code')?.textContent ?? ''))
  pre.before(card)
  card.append(head, pre)
  if (lang !== undefined) applyHighlight(pre, pre.querySelector('code')?.textContent ?? '', lang)
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
    wrapCodeCard(pre, lang)
  }
  for (const link of fragment.querySelectorAll('a')) {
    link.className = 'md-link'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  return fragment
}
