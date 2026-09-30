import { describe, expect, test } from 'bun:test'
import { ansiHtml, capOutput, toolCard, type ToolCardMessage } from '../client/tool-cards'

const call = (overrides: Partial<ToolCardMessage>): ToolCardMessage => ({ title: 'Read', detail: 'a.ts', input: '', result: '', resultIsError: false, ...overrides })

describe('toolCard kinds and summaries', () => {
  test('Read counts the lines it returned', () => {
    const card = toolCard(call({ title: 'Read', detail: 'client/a.ts', result: 'l1\nl2\nl3' }), false, 0)
    expect(card).toMatchObject({ kind: 'read', verb: 'Read', target: 'client/a.ts', summary: '3 lines', status: 'done' })
  })

  test('Read of an image says image and keeps no output', () => {
    const card = toolCard(call({ title: 'Read', result: '{\n  "type": "image", "source": {}}' }), false, 0)
    expect(card).toMatchObject({ summary: 'image', output: '' })
  })

  test('Grep counts matches and reads zero for no matches', () => {
    expect(toolCard(call({ title: 'Grep', result: 'a.ts:1\nb.ts:4' }), false, 0).summary).toBe('2 matches')
    expect(toolCard(call({ title: 'Grep', result: 'No matches found' }), false, 0).summary).toBe('0 matches')
    expect(toolCard(call({ title: 'Grep', result: '' }), false, 0).summary).toBe('0 matches')
  })

  test('Edit, MultiEdit and Write report added and removed lines', () => {
    const edit = JSON.stringify({ old_string: 'x\ny', new_string: 'x\ny\nz\nw' })
    const multi = JSON.stringify({ edits: [{ old_string: 'a', new_string: 'a\nb' }, { old_string: 'c\nd', new_string: '' }] })
    expect(toolCard(call({ title: 'Edit', input: edit }), false, 0).summary).toBe('+4 −2')
    expect(toolCard(call({ title: 'MultiEdit', input: multi }), false, 0).summary).toBe('+2 −3')
    expect(toolCard(call({ title: 'Write', input: JSON.stringify({ content: 'a\nb\nc' }) }), false, 0).summary).toBe('+3')
  })

  test('Bash without an exit line keeps its output and stays done', () => {
    const card = toolCard(call({ title: 'Bash', detail: 'bun test', input: '{"command":"bun test"}', result: 'ok\n' }), false, 0)
    expect(card).toMatchObject({ kind: 'bash', exitCode: null, summary: '', status: 'done', command: 'bun test', output: 'ok\n' })
  })

  test('Bash with a non-zero exit line fails and shows the first error line', () => {
    const card = toolCard(call({ title: 'Bash', input: '{"command":"git push"}', result: 'Exit code 1\nfatal: rejected', resultIsError: true }), false, 0)
    expect(card).toMatchObject({ exitCode: 1, summary: 'exit 1', status: 'failed', errorLine: 'fatal: rejected', output: 'fatal: rejected' })
  })

  test('Bash with a zero exit line is done', () => {
    expect(toolCard(call({ title: 'Bash', result: 'Exit code 0\nfine' }), false, 0)).toMatchObject({ exitCode: 0, summary: 'exit 0', status: 'done' })
  })

  test('an empty result is running only inside a running turn', () => {
    expect(toolCard(call({ title: 'Bash' }), true, 0).status).toBe('running')
    expect(toolCard(call({ title: 'Bash' }), false, 0).status).toBe('done')
  })

  test('an explicit error wins over running', () => {
    expect(toolCard(call({ title: 'Bash', result: 'boom', resultIsError: true }), true, 0)).toMatchObject({ status: 'failed', exitCode: null, summary: 'failed', errorLine: 'boom' })
  })

  test('agents and unknown tools fall back to their own kind with no summary', () => {
    expect(toolCard(call({ title: 'Task', detail: 'check the build' }), false, 0)).toMatchObject({ kind: 'agent', verb: 'Task', target: 'check the build', summary: '' })
    expect(toolCard(call({ title: 'WebFetch', detail: 'x.dev' }), false, 0).kind).toBe('other')
  })
})

describe('capOutput', () => {
  test('keeps the last 400 lines and says how many are hidden', () => {
    const text = Array.from({ length: 450 }, (_, i) => `l${i + 1}`).join('\n')
    const capped = capOutput(text)
    const lines = capped.split('\n')
    expect(lines).toHaveLength(401)
    expect(lines[0]).toBe('… 50 earlier lines hidden')
    expect(lines.at(-1)).toBe('l450')
  })

  test('a single line longer than the character cap keeps its last 20000 characters', () => {
    const lines = capOutput('x'.repeat(21_000)).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('… 1 earlier lines hidden')
    expect(lines[1]).toBe('x'.repeat(20_000))
  })

  test('short output passes through unchanged', () => {
    expect(capOutput('one\ntwo')).toBe('one\ntwo')
  })
})

describe('ansiHtml', () => {
  test('colour codes become classes and html stays text', () => {
    const html = ansiHtml('\u001b[31mred\u001b[0m <b>')
    expect(html).toContain('ansi-red-fg')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })

  test('two colours on one line render inline', () => {
    const html = ansiHtml('\u001b[32mok\u001b[0m and \u001b[31mbad\u001b[0m')
    expect(html).toContain('ansi-green-fg')
    expect(html).toContain('ansi-red-fg')
    expect(html).not.toContain('\n')
  })
})
