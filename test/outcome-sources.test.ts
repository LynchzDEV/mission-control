import { describe, expect, test } from 'bun:test'

import { checkOutcomes, emptyParseState, exitCodeOf, jobOutcome, outcomeDetail, parseClaudeOutcomes, parseCodexExecOutcomes, parseCodexRolloutOutcomes, resultText, type Actor } from '../server/outcome-sources'

const line = (value: unknown) => JSON.stringify(value)
const MAIN: Actor = { by: 'main', label: 'Main agent', engine: 'claude' }
const context = { source: 'main', actor: MAIN, now: 1_000 }
const use = (id: string, name: string, input: unknown) => line({ type: 'assistant', timestamp: '2026-09-28T10:00:00Z', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string, isError = false, extra: Record<string, unknown> = {}) => line({ type: 'user', timestamp: '2026-09-28T10:00:05Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra })

describe('parseClaudeOutcomes', () => {
  test('a failing Bash command is red with its exit code and first error lines', () => {
    const text = [use('t1', 'Bash', { command: 'bin/ci spec/moni', description: 'Run specs' }), result('t1', 'Exit code 1\n14 examples, 2 failures\nrspec ./spec/a_spec.rb:42\nmore', true)].join('\n')
    const { outcomes, state } = parseClaudeOutcomes(text, emptyParseState(), context)
    expect(outcomes).toEqual([{ at: Date.parse('2026-09-28T10:00:05Z'), ok: false, kind: 'command', tool: 'Bash', target: 'bin/ci spec/moni', result: 'Failed · exit 1', detail: '14 examples, 2 failures\nrspec ./spec/a_spec.rb:42', actor: MAIN, key: 'main:t1' }])
    expect(state.pending).toEqual({})
  })

  test('a passing command keeps its last output line; edits read Saved or Failed', () => {
    const text = [
      use('a', 'Bash', { command: 'bin/ci' }), result('a', 'Running…\n14 examples, 0 failures\n'),
      use('b', 'Edit', { file_path: 'app/x.rb' }), result('b', 'The file app/x.rb has been updated.'),
      use('c', 'Write', { file_path: 'app/y.rb' }), result('c', 'String to replace not found in file.', true),
    ].join('\n')
    const outcomes = parseClaudeOutcomes(text, emptyParseState(), context).outcomes
    expect(outcomes.map((item) => [item.tool, item.ok, item.result, item.detail])).toEqual([
      ['Bash', true, 'Passed', '14 examples, 0 failures'],
      ['Edit', true, 'Saved', 'The file app/x.rb has been updated.'],
      ['Write', false, 'Failed', 'String to replace not found in file.'],
    ])
  })

  test('reads, searches and other lookups earn no square', () => {
    const text = [use('r', 'Read', { file_path: 'a' }), result('r', 'x'), use('g', 'Grep', { pattern: 'x' }), result('g', 'x', true)].join('\n')
    expect(parseClaudeOutcomes(text, emptyParseState(), context).outcomes).toEqual([])
  })

  test('a result arriving in a later chunk pairs with the use carried in state', () => {
    const first = parseClaudeOutcomes(use('t9', 'Bash', { command: 'git push' }), emptyParseState(), context)
    expect(first.outcomes).toEqual([])
    const second = parseClaudeOutcomes(result('t9', 'rejected', true), first.state, context)
    expect(second.outcomes.map((item) => [item.key, item.ok, item.target])).toEqual([['main:t9', false, 'git push']])
  })

  test('an async agent launch records its label and emits nothing; a finished agent emits one square', () => {
    const launch = [use('ag', 'Agent', { description: 'review the bump' }), result('ag', 'Launched', false, { toolUseResult: { agentId: 'a1b2', status: 'async_launched' } })].join('\n')
    const launched = parseClaudeOutcomes(launch, emptyParseState(), context)
    expect(launched.outcomes).toEqual([])
    expect(launched.state.agents).toEqual({ a1b2: 'review the bump' })
    const sync = [use('ag2', 'Task', { description: 'find callers' }), result('ag2', 'Found 3', false, { toolUseResult: { agentId: 'c3', status: 'completed' } })].join('\n')
    const done = parseClaudeOutcomes(sync, launched.state, context)
    expect(done.outcomes.map((item) => [item.kind, item.result, item.target])).toEqual([['agent', 'Finished', 'find callers']])
    expect(done.state.agents).toEqual({ a1b2: 'review the bump', c3: 'find callers' })
  })

  test('does not mutate the state it was given, and skips garbage lines', () => {
    const state = emptyParseState()
    parseClaudeOutcomes(`not json\n{broken\n${use('z', 'Bash', { command: 'ls' })}`, state, context)
    expect(state.pending).toEqual({})
  })
})

describe('parseCodexRolloutOutcomes', () => {
  const call = (id: string, name: string, args: unknown) => line({ type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } })
  const output = (id: string, value: string) => line({ type: 'response_item', timestamp: '2026-09-28T10:01:00Z', payload: { type: 'function_call_output', call_id: id, output: value } })

  test('exit code comes from the output JSON metadata or the text', () => {
    const text = [
      call('c1', 'shell', { command: ['bash', '-lc', 'bun test'] }), output('c1', JSON.stringify({ output: '3 pass\n1 fail', metadata: { exit_code: 1 } })),
      call('c2', 'exec_command', { cmd: 'ls' }), output('c2', 'Process exited with code 0\nfile'),
    ].join('\n')
    const outcomes = parseCodexRolloutOutcomes(text, emptyParseState(), context).outcomes
    expect(outcomes.map((item) => [item.target, item.ok, item.result, item.detail])).toEqual([
      ['bash -lc bun test', false, 'Failed · exit 1', '3 pass\n1 fail'],
      ['ls', true, 'Passed · exit 0', 'file'],
    ])
  })

  test('an output without an exit code is never guessed as a pass', () => {
    const text = [call('c3', 'shell', { command: ['echo'] }), output('c3', 'hello')].join('\n')
    const parsed = parseCodexRolloutOutcomes(text, emptyParseState(), context)
    expect(parsed.outcomes).toEqual([])
    expect(parsed.state.pending).toEqual({})
  })

  test('apply_patch is an edit targeting the patched files', () => {
    const text = [
      line({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: app/a.rb\n*** Add File: app/b.rb\n' } }),
      line({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p1', output: JSON.stringify({ output: 'Success', metadata: { exit_code: 0 } }) } }),
    ].join('\n')
    expect(parseCodexRolloutOutcomes(text, emptyParseState(), context).outcomes.map((item) => [item.kind, item.target, item.result])).toEqual([['edit', 'app/a.rb, app/b.rb', 'Saved']])
  })
})

describe('parseCodexExecOutcomes', () => {
  test('command_execution and file_change items become squares; other items do not', () => {
    const text = [
      line({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'bin/rails test', exit_code: 1, status: 'failed', aggregated_output: 'Unable to find button\n' } }),
      line({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.erb', kind: 'update' }], status: 'completed' } }),
      line({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'hi' } }),
    ].join('\n')
    expect(parseCodexExecOutcomes(text, emptyParseState(), context).outcomes.map((item) => [item.key, item.ok, item.result, item.target])).toEqual([
      ['main:i1', false, 'Failed · exit 1', 'bin/rails test'],
      ['main:i2', true, 'Saved', 'a.erb'],
    ])
  })

  test('legacy exec_command begin/end pairs across chunks', () => {
    const first = parseCodexExecOutcomes(line({ msg: { type: 'exec_command_begin', call_id: 'e1', command: ['make'] } }), emptyParseState(), context)
    const second = parseCodexExecOutcomes(line({ msg: { type: 'exec_command_end', call_id: 'e1', exit_code: 2, stderr: 'boom' } }), first.state, context)
    expect(second.outcomes.map((item) => [item.target, item.result, item.detail])).toEqual([['make', 'Failed · exit 2', 'boom']])
  })
})

describe('jobOutcome', () => {
  const job = { id: 'j1', label: 'backoffice · export', engine: 'codex', status: 'done', exitCode: 0, endedAt: 5, diffStat: '2 files changed' }
  const actor: Actor = { by: 'spawned', label: 'Job · backoffice · export', engine: 'codex' }
  test('done is green with the diff stat; failed or reported-failed is red with the exit code', () => {
    expect(jobOutcome(job, null, actor)).toEqual({ at: 5, ok: true, kind: 'job', tool: 'Job', target: 'backoffice · export', result: 'Done', detail: '2 files changed', actor, key: 'job:j1' })
    expect(jobOutcome({ ...job, status: 'failed', exitCode: 1 }, null, actor)?.result).toBe('Failed · exit 1')
    expect(jobOutcome(job, 'failed', actor)?.ok).toBe(false)
    expect(jobOutcome({ ...job, status: 'running' }, null, actor)).toBeNull()
  })
})

describe('checkOutcomes', () => {
  test('one square per check; a timeout fails even with exit 0', () => {
    const actor: Actor = { by: 'spawned', label: 'Workflow · build', engine: 'claude' }
    const attempts = [{ number: 0, endedAt: 9, checks: [{ command: 'bun', args: ['test'], exitCode: 0, output: '5 pass', timedOut: false }, { command: 'bun', args: ['run', 'lint'], exitCode: 0, output: '', timedOut: true }] }]
    expect(checkOutcomes('r1', attempts, actor).map((item) => [item.key, item.target, item.ok, item.detail])).toEqual([
      ['run:r1#0#0', 'bun test', true, '5 pass'],
      ['run:r1#0#1', 'bun run lint', false, 'Timed out'],
    ])
  })
})

describe('helpers', () => {
  test('exitCodeOf reads JSON, Claude and Codex spellings', () => {
    expect(exitCodeOf('{"exit_code": 3}')).toBe(3)
    expect(exitCodeOf('Error: Exit code 127')).toBe(127)
    expect(exitCodeOf('nothing here')).toBeNull()
  })
  test('outcomeDetail skips the exit-code line and clips', () => {
    expect(outcomeDetail('Exit code 1\n\nfirst\nsecond\nthird', false)).toBe('first\nsecond')
    expect(outcomeDetail('x'.repeat(500), true).length).toBeLessThanOrEqual(300)
  })
  test('resultText wording per kind', () => {
    expect([resultText('command', true, null), resultText('check', false, 2), resultText('edit', true, null), resultText('agent', false, null), resultText('job', true, null)]).toEqual(['Passed', 'Failed · exit 2', 'Saved', 'Failed', 'Done'])
  })
})
