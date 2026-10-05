import { expect, test } from 'bun:test'
import { join } from 'node:path'

// Own process: sidebar.test.ts loads client/sidebar without a DOM first, so this file needs a fresh module cache.
test('sidebar queue rows (own process)', () => {
  const run = Bun.spawnSync([process.execPath, 'test', './test/sidebar-queue.dom.ts'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(output)
  expect(output).toMatch(/\b0 fail\b/)
  expect(run.exitCode).toBe(0)
}, 120000)
