import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { normalizeJobRecord } from '../server/jobs'
import { notifySlowJob } from '../server/notify'

const record = normalizeJobRecord({ label: 'Check loop', turns: 81, startedAt: 1000, slowAt: 961000 })

afterEach(() => mock.restore())

test('builds the macOS notification and logs one line', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const spawn = mock(() => ({ exited: Promise.resolve(0) }))
  await notifySlowJob(record, { platform: 'darwin', spawn })
  expect(spawn).toHaveBeenCalledWith([
    'osascript', '-e',
    'display notification "Check loop · 81 turns · 16 min — possible loop" with title "Mission Control"',
  ], { stdout: 'ignore', stderr: 'ignore' })
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('job slow: Check loop · 81 turns · 16 min — possible loop')
})

test('escapes labels as AppleScript strings', async () => {
  spyOn(console, 'error').mockImplementation(() => {})
  const commands: string[][] = []
  await notifySlowJob({ ...record, label: 'a"b\\c\nd' }, {
    platform: 'darwin',
    spawn: (command) => { commands.push(command); return { exited: Promise.resolve(0) } },
  })
  expect(commands[0]?.[2]).toBe('display notification "a\\"b\\\\c\\nd · 81 turns · 16 min — possible loop" with title "Mission Control"')
})

test('does not spawn off darwin', async () => {
  spyOn(console, 'error').mockImplementation(() => {})
  const spawn = mock(() => ({ exited: Promise.resolve(0) }))
  for (const platform of ['linux', 'win32']) await notifySlowJob(record, { platform, spawn })
  expect(spawn).not.toHaveBeenCalled()
})

test('ignores spawn, exit, and nonzero failures', async () => {
  spyOn(console, 'error').mockImplementation(() => {})
  for (const spawn of [
    () => { throw new Error('missing osascript') },
    () => ({ exited: Promise.reject(new Error('failed')) }),
    () => ({ exited: Promise.resolve(1) }),
  ]) {
    await expect(notifySlowJob(record, { platform: 'darwin', spawn })).resolves.toBeUndefined()
  }
})
