import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import bash from '@shikijs/langs/bash'
import css from '@shikijs/langs/css'
import diff from '@shikijs/langs/diff'
import html from '@shikijs/langs/html'
import javascript from '@shikijs/langs/javascript'
import json from '@shikijs/langs/json'
import markdown from '@shikijs/langs/markdown'
import python from '@shikijs/langs/python'
import ruby from '@shikijs/langs/ruby'
import sql from '@shikijs/langs/sql'
import tsx from '@shikijs/langs/tsx'
import typescript from '@shikijs/langs/typescript'
import yaml from '@shikijs/langs/yaml'
import githubDark from '@shikijs/themes/github-dark'
import githubLight from '@shikijs/themes/github-light'

const GRAMMARS = [typescript, javascript, tsx, json, bash, ruby, python, css, html, sql, yaml, diff, markdown]
const LANG_ALIASES: Record<string, string> = { py: 'python', rb: 'ruby', yml: 'yaml', md: 'markdown' }
const KNOWN_LANGS = new Set(GRAMMARS.flatMap(grammar => grammar.flatMap(entry => [entry.name, ...(entry.aliases ?? [])])))
const CACHE_LIMIT = 300

const cache = new Map<string, string>()
type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>
let core: Promise<Highlighter> | null = null

function loadCore(): Promise<Highlighter> {
  core ??= createHighlighterCore({
    langs: GRAMMARS,
    themes: [githubLight, githubDark],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return core
}

export async function highlight(code: string, lang: string): Promise<string | null> {
  const name = LANG_ALIASES[lang] ?? lang
  if (!KNOWN_LANGS.has(name)) return null
  const key = `${name}\u0000${code}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  try {
    const highlighter = await loadCore()
    const html = highlighter.codeToHtml(code, { lang: name, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, html)
    return html
  } catch {
    return null
  }
}
