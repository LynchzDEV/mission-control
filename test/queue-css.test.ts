import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, '../public/quiet.css'), 'utf8')
const lightTokens = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))

test('the light theme defines --line-strong', () => {
  expect(lightTokens).toContain('--line-strong: #b9c2d3;')
})

test('queue rules use --line-strong without a hex fallback', () => {
  const queueRules = css.split('\n').filter(line => line.startsWith('.q-') && line.includes('--line-strong'))
  expect(queueRules.length).toBeGreaterThan(0)
  for (const rule of queueRules) expect(rule).not.toContain('var(--line-strong,')
})
