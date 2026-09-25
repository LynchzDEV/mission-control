import { expect, test } from 'bun:test'

test('the quiet shell islands type-check (a load-time break in an island has no other test)', async () => {
  const check = Bun.spawn(['node_modules/.bin/tsc', '-p', 'tsconfig.shell.json'], { stdout: 'pipe', stderr: 'pipe' })
  const output = (await new Response(check.stdout).text()) + (await new Response(check.stderr).text())
  expect(await check.exited, output).toBe(0)
}, 60_000)
