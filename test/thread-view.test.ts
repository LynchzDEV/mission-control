import { describe, expect, test } from 'bun:test'

import { groupByThread, sortThreadsByActivity, type ThreadMember } from '../client/thread-view'

function member(overrides: Partial<ThreadMember> = {}): ThreadMember {
  const id = overrides.id ?? 'a'
  return { id, threadRoot: id, startedAt: 0, status: 'done', ...overrides }
}

describe('groupByThread', () => {
  test('a standalone job becomes a single-job thread rooted at its own id', () => {
    const [thread] = groupByThread([member({ id: 'solo' })])
    expect(thread).toMatchObject({ threadRoot: 'solo', jobCount: 1 })
    expect(thread?.newestJob.id).toBe('solo')
    expect(thread?.runningJob).toBeNull()
  })

  test('a reply-only pair collapses into one thread ordered by newest activity', () => {
    const opening = member({ id: 'root', threadRoot: 'root', startedAt: 100 })
    const reply = member({ id: 'reply', threadRoot: 'root', startedAt: 200 })

    const [thread] = groupByThread([opening, reply])

    expect(thread?.threadRoot).toBe('root')
    expect(thread?.jobCount).toBe(2)
    expect(thread?.newestJob.id).toBe('reply')
  })

  test('a mixed running/done thread surfaces the running turn as runningJob regardless of recency', () => {
    const oldRunning = member({ id: 'root', threadRoot: 'root', startedAt: 100, status: 'running' })
    const newerDone = member({ id: 'reply', threadRoot: 'root', startedAt: 200, status: 'done' })

    const [thread] = groupByThread([oldRunning, newerDone])

    expect(thread?.newestJob.id).toBe('reply')
    expect(thread?.runningJob?.id).toBe('root')
  })

  test('a thread with nothing running reports a null runningJob', () => {
    const [thread] = groupByThread([
      member({ id: 'root', threadRoot: 'root', startedAt: 100, status: 'done' }),
      member({ id: 'reply', threadRoot: 'root', startedAt: 200, status: 'failed' }),
    ])
    expect(thread?.runningJob).toBeNull()
  })

  test('jobs with different thread roots stay separate threads', () => {
    const groups = groupByThread([
      member({ id: 'a', threadRoot: 'a' }),
      member({ id: 'b', threadRoot: 'b' }),
    ])
    expect(groups).toHaveLength(2)
  })

  test('an empty job list yields no threads', () => {
    expect(groupByThread([])).toEqual([])
  })
})

describe('sortThreadsByActivity', () => {
  test('orders threads by their newest job, newest first', () => {
    const groups = groupByThread([
      member({ id: 'old', threadRoot: 'old', startedAt: 10 }),
      member({ id: 'new', threadRoot: 'new', startedAt: 30 }),
      member({ id: 'mid', threadRoot: 'mid', startedAt: 20 }),
    ])

    expect(sortThreadsByActivity(groups).map((thread) => thread.threadRoot)).toEqual(['new', 'mid', 'old'])
  })

  test('does not mutate the input array', () => {
    const groups = groupByThread([member({ id: 'a', threadRoot: 'a', startedAt: 1 })])
    const input = [...groups]
    sortThreadsByActivity(groups)
    expect(groups).toEqual(input)
  })
})
