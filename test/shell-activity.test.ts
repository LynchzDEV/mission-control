import { expect, test } from 'bun:test'
import { join } from 'node:path'

// Own process: client/shell-activity leaves window listeners behind that throw once a later file swaps in a different document.
test('shell activity drawer (own process)', () => {
  const run = Bun.spawnSync([process.execPath, 'test', './test/shell-activity.dom.ts'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(output)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).not.toMatch(/\b0 pass\b/)
  expect(run.exitCode).toBe(0)
}, 120000)
