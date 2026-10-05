import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, '../public/quiet.css'), 'utf8')
const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))

test('both themes define the queue line colour', () => {
  expect(block(':root {')).toContain('--q-line: #b9c2d3;')
  expect(block(':root[data-theme="dark"] {')).toContain('--q-line: #4a5163;')
})

test('the light theme leaves --line-strong undefined so older rules keep their own fallbacks', () => {
  expect(block(':root {')).not.toContain('--line-strong')
})

test('queue rules use the queue line colour without a hex fallback', () => {
  const queueRules = css.split('\n').filter(line => line.startsWith('.q-') && line.includes('--q-line'))
  expect(queueRules.length).toBeGreaterThan(0)
  for (const rule of queueRules) expect(rule).not.toMatch(/var\(--q-line,/)
  expect(css.split('\n').filter(line => line.startsWith('.q-') && line.includes('--line-strong'))).toEqual([])
})
