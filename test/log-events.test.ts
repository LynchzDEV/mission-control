import { describe, expect, test } from 'bun:test'
import { isLogEvent, logEvent, mentionsLogEvent } from '../server/log-events'

describe('log events', () => {
  test('writes the skd_ name', () => {
    expect(logEvent('permission_request')).toBe('skd_permission_request')
  })
  test('recognises both the skd_ and the legacy mc_ type', () => {
    expect(isLogEvent('skd_context', 'context')).toBe(true)
    expect(isLogEvent('mc_context', 'context')).toBe(true)
    expect(isLogEvent('skd_commands', 'context')).toBe(false)
    expect(isLogEvent(undefined, 'context')).toBe(false)
  })
  test('finds either name quoted in a raw log line', () => {
    expect(mentionsLogEvent('{"type":"mc_child","pid":1}', 'child')).toBe(true)
    expect(mentionsLogEvent('{"type":"skd_child","pid":1}', 'child')).toBe(true)
    expect(mentionsLogEvent('{"type":"result"}', 'child')).toBe(false)
  })
})
