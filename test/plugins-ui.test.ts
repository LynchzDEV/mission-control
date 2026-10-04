import { expect, test } from 'bun:test'
import { join } from 'node:path'

// Own process: these DOM tests load client modules against their own fake window, which a shared test process has already bound elsewhere.
test('plugins UI (own process)', () => {
  const run = Bun.spawnSync([process.execPath, 'test', './test/plugins-ui.dom.ts'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  const output = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(output)
  expect(output).toMatch(/\b0 fail\b/)
  expect(run.exitCode).toBe(0)
}, 120000)
