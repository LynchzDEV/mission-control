import { expect, test } from 'bun:test'
import { splitMessage } from '../client/dialog'

test('short messages stay as the title; long questions split at the first question mark', () => {
  expect(splitMessage('Stop orders-export?')).toEqual({ title: 'Stop orders-export?', detail: '' })
  expect(splitMessage('End orders-export-fix session? This stops its running process.')).toEqual({ title: 'End orders-export-fix session?', detail: 'This stops its running process.' })
  expect(splitMessage('Land orders-export-fix onto its base branch? This cherry-picks the worktree commits and cannot be undone.')).toEqual({ title: 'Land orders-export-fix onto its base branch?', detail: 'This cherry-picks the worktree commits and cannot be undone.' })
})
