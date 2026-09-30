import { describe, expect, test } from 'bun:test'
import type { JobRecord } from '../server/jobs'
import { buildTurnTree, forkPointUuid, nearestSessionId, newestLeaf } from '../server/thread-tree'

function turn(id: string, startedAt: number, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    engine: 'claude',
    cwd: '/Users/x/code/repo',
    label: 'chat',
    prompt: `prompt ${id}`,
    pid: 1,
    status: 'done',
    startedAt,
    endedAt: startedAt + 1,
    exitCode: 0,
    diffStat: null,
    reviewedAt: null,
    sessionId: null,
    parentJobId: null,
    threadRoot: 'root',
    model: null,
    ...overrides,
  }
}

describe('buildTurnTree', () => {
  test('a legacy chain keeps startedAt order with no versions or branch points', () => {
    const turns = [turn('t1', 100, { sessionId: 's1' }), turn('t2', 200, { sessionId: 's2' }), turn('t3', 300)]
    const tree = buildTurnTree('root', turns)
    expect(tree.pathToLeaf('t3').map(entry => entry.id)).toEqual(['t1', 't2', 't3'])
    expect(tree.versions).toEqual({})
    expect(tree.branchPoints).toEqual([])
    expect(newestLeaf(tree)).toBe('t3')
  })

  test('a replace version groups both turns and branches get their point', () => {
    const turns = [
      turn('t1', 100, { sessionId: 's1' }),
      turn('t2', 200, { sessionId: 's2' }),
      turn('t2v', 300, { prevTurnId: 't1', versionOf: 't2' }),
      turn('t2b', 400, { prevTurnId: 't2', branchFrom: 't2', prompt: 'try the other rule\nsecond line' }),
    ]
    const tree = buildTurnTree('root', turns)
    expect(tree.versions['t2']).toMatchObject({ index: 1, count: 2, ids: ['t2', 't2v'] })
    expect(tree.versions['t2v']).toMatchObject({ index: 2, count: 2 })
    expect(tree.branchPoints).toEqual([{ turnId: 't2b', label: 'try the other rule', mainLeaf: 't2v' }])
    expect(tree.pathToLeaf('t2v').map(entry => entry.id)).toEqual(['t1', 't2v'])
    expect(tree.pathToLeaf('t2b').map(entry => entry.id)).toEqual(['t1', 't2', 't2b'])
  })

  test('the resume walks prev links to the nearest ancestor with a session', () => {
    const turns = [turn('t1', 100, { sessionId: 's1' }), turn('t2', 200), turn('t3', 300, { prevTurnId: 't2' })]
    const tree = buildTurnTree('root', turns)
    expect(nearestSessionId(tree, 't3')).toBe('s1')
    expect(nearestSessionId(tree, 't1')).toBe('s1')
  })
})

describe('forkPointUuid', () => {
  test('picks the last chain entry with a uuid, skipping results and stream events', () => {
    const log = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, uuid: 'u1', parent_tool_use_id: null }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] }, uuid: 'u2', parent_tool_use_id: null }),
      JSON.stringify({ type: 'stream_event', event: {}, uuid: 'u3' }),
      JSON.stringify({ type: 'result', subtype: 'success', uuid: 'u4' }),
    ].join('\n')
    expect(forkPointUuid(log)).toBe('u2')
  })

  test('returns null when no chain entry carries a uuid', () => {
    const log = [
      JSON.stringify({ type: 'stream_event', event: {}, uuid: 'u3' }),
      JSON.stringify({ type: 'result', subtype: 'success', uuid: 'u4' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, parent_tool_use_id: 'side' }),
    ].join('\n')
    expect(forkPointUuid(log)).toBeNull()
  })
})
