import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claudeTranscriptPath, findCodexRollout, parseClaudeTranscript, parseCodexTranscript, readTranscriptTail } from '../server/session-transcript'

const line = (value: unknown) => JSON.stringify(value)

describe('parseClaudeTranscript', () => {
  const session = [
    line({ type: 'queue-operation', operation: 'enqueue', content: 'ignored' }),
    line({ type: 'user', message: { role: 'user', content: 'Inspect the terminal workspace' } }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveman mode' } }),
    line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>noise</local-command-stdout>' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Look at the deck first.' }, { type: 'text', text: 'Reading the layout.' }, { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: 'client/terminal.ts' } }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'export const x = 1', is_error: false }] } }),
    line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'bun test', description: 'Run tests' } }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: [{ type: 'text', text: 'boom' }], is_error: true }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Session layout mapped.' }] } }),
    '{"broken json',
  ].join('\n')

  test('keeps prompts, text, thinking and tools in order and attaches tool results by id', () => {
    const rows = parseClaudeTranscript(session)
    expect(rows.map((row) => row.kind)).toEqual(['prompt', 'thinking', 'text', 'tool', 'tool', 'text'])
    expect(rows[0]!.text).toBe('Inspect the terminal workspace')
    expect(rows[3]).toMatchObject({ title: 'Read', detail: 'client/terminal.ts', result: 'export const x = 1', isError: false })
    expect(rows[4]).toMatchObject({ title: 'Bash', detail: 'Run tests', result: 'boom', isError: true })
    expect(rows[4]!.input).toContain('bun test')
  })

  test('drops meta, sidechain and injected lines and survives an empty file', () => {
    const rows = parseClaudeTranscript(session)
    expect(rows.some((row) => row.text.includes('caveman') || row.text.includes('noise') || row.text.includes('subagent'))).toBe(false)
    expect(parseClaudeTranscript('')).toEqual([])
  })
})

describe('parseCodexTranscript', () => {
  const rollout = [
    line({ type: 'session_meta', payload: { id: 's1', cwd: '/repo', timestamp: '2026-09-01T15:31:40.000Z' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the current composition' }] } }),
    line({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Compare both panes.' }] } }),
    line({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":["git","status"]}' } }),
    line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'clean' } }),
    line({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'const r = await tools.exec_command({cmd:"ls"})\nprint(r)' } }),
    line({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'a.ts' } }),
    line({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'duplicate of reasoning' } }),
    line({ type: 'event_msg', payload: { type: 'token_count' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Three details to refine' }], phase: 'commentary' } }),
    line({ type: 'event_msg', payload: { type: 'error', message: 'rate limited' } }),
  ].join('\n')

  test('maps messages, reasoning, function and custom tool calls with their outputs', () => {
    const rows = parseCodexTranscript(rollout)
    expect(rows.map((row) => row.kind)).toEqual(['prompt', 'thinking', 'tool', 'tool', 'text', 'result'])
    expect(rows[0]!.text).toBe('Review the current composition')
    expect(rows[2]).toMatchObject({ title: 'shell', detail: 'git status', result: 'clean' })
    expect(rows[3]).toMatchObject({ title: 'exec', result: 'a.ts' })
    expect(rows[3]!.detail).toBe('const r = await tools.exec_command({cmd:"ls"})')
    expect(rows[5]).toMatchObject({ text: 'rate limited', isError: true })
  })
})

describe('transcript files', () => {
  test('claudeTranscriptPath slugs the cwd under the config dir projects folder', () => {
    expect(claudeTranscriptPath('/cfg', '/Users/me/code/app', 'sid')).toBe('/cfg/projects/-Users-me-code-app/sid.jsonl')
    expect(claudeTranscriptPath(undefined, '/x', 'sid')).toMatch(/\.claude\/projects\/-x\/sid\.jsonl$/)
  })

  test('readTranscriptTail returns null for a missing file and drops the partial first line of a long tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mc-transcript-'))
    try {
      expect(await readTranscriptTail(join(dir, 'missing.jsonl'))).toBeNull()
      const path = join(dir, 'a.jsonl')
      await writeFile(path, 'first line\nsecond line\nthird line\n')
      expect(await readTranscriptTail(path, 16)).toBe('third line\n')
      expect(await readTranscriptTail(path, 1000)).toBe('first line\nsecond line\nthird line\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('findCodexRollout picks the newest rollout whose session_meta cwd matches and started after the terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mc-codex-'))
    try {
      const day = join(root, '2026', '09', '01')
      await mkdir(day, { recursive: true })
      const since = Date.parse('2026-09-01T10:00:00.000Z')
      const meta = (cwd: string, at: string) => line({ type: 'session_meta', payload: { cwd, timestamp: at } }) + '\n'
      await writeFile(join(day, 'rollout-2026-09-01T09-00-00-old.jsonl'), meta('/repo', '2026-09-01T09:00:00.000Z'))
      await writeFile(join(day, 'rollout-2026-09-01T10-05-00-other.jsonl'), meta('/elsewhere', '2026-09-01T10:05:00.000Z'))
      await writeFile(join(day, 'rollout-2026-09-01T10-06-00-mine.jsonl'), meta('/repo', '2026-09-01T10:06:00.000Z'))
      const found = await findCodexRollout('/repo', since, root)
      expect(found).toBe(join(day, 'rollout-2026-09-01T10-06-00-mine.jsonl'))
      expect(await findCodexRollout('/nowhere', since, root)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
