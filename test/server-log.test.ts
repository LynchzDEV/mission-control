import { describe, expect, test } from 'bun:test'

import { jobLine, requestLine, shouldLogRequest } from '../server/server-log'

const job = { id: '56c345dc-1111-2222-3333-444455556666', label: 'say-hi html', engine: 'glm', model: 'glm-5.3', startedAt: 1_000, endedAt: 73_000, status: 'done' }

describe('jobLine', () => {
  test('a started job names its label, engine/model and short id', () => {
    expect(jobLine('started', job)).toBe('job started  say-hi html · glm/glm-5.3 · 56c345dc')
  })

  test('a job without a model shows the engine alone', () => {
    expect(jobLine('started', { ...job, model: null })).toBe('job started  say-hi html · glm · 56c345dc')
  })

  test('a settled job reports its outcome and how long it ran', () => {
    expect(jobLine('done', job)).toBe('job done  say-hi html · 1m12s · 56c345dc')
    expect(jobLine('failed', { ...job, endedAt: 9_000 })).toBe('job failed  say-hi html · 8s · 56c345dc')
  })

  test('an unlabelled job falls back to its short id', () => {
    expect(jobLine('started', { ...job, label: '' })).toBe('job started  56c345dc · glm/glm-5.3 · 56c345dc')
  })
})

describe('requestLine', () => {
  test('shows method, path without the query, status and time', () => {
    expect(requestLine('POST', 'http://127.0.0.1:7777/api/jobs?token=secret', 201, 41.6)).toBe('POST /api/jobs 201 42ms')
  })
})

describe('shouldLogRequest', () => {
  test('changes are logged, quiet polls are not', () => {
    expect(shouldLogRequest('POST', 200, false)).toBe(true)
    expect(shouldLogRequest('DELETE', 204, false)).toBe(true)
    expect(shouldLogRequest('GET', 200, false)).toBe(false)
  })

  test('failed requests are always logged', () => {
    expect(shouldLogRequest('GET', 404, false)).toBe(true)
    expect(shouldLogRequest('GET', 500, false)).toBe(true)
  })

  test('verbose logs every request', () => {
    expect(shouldLogRequest('GET', 200, true)).toBe(true)
  })
})
