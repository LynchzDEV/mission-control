import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connectionSchema } from '../server/agent-connections'
import { parseThread } from '../server/activity'

async function bridge(overrides = {}, extra = {}, env = {}) {
  const connection = connectionSchema.parse({ id: 'fixture', name: 'Fixture', adapter: 'acp', command: process.execPath, args: [join(import.meta.dir, 'fixtures/agents/acp.ts')], ...overrides })
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../server/agent-bridge.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  proc.stdin.write(JSON.stringify({ connection, prompt: 'Test', ...extra }))
  proc.stdin.end()
  const [output, errors, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { output, errors, exit }
}

test('ACP bridge negotiates a session, selects a model and normalizes output', async () => {
  const result = await bridge({}, { model: 'fixture-model' })
  expect(result).toMatchObject({ exit: 0 })
  expect(result.output).toContain('fixture-session')
  expect(parseThread(result.output).some(event => event.detail.includes('Fixture ran'))).toBe(true)
})

test('permission refusal and incomplete protocol stops cannot look successful', async () => {
  expect((await bridge({}, {}, { FIXTURE_PERMISSION: '1' })).exit).not.toBe(0)
  expect((await bridge({ autoApprove: true }, { readOnly: true }, { FIXTURE_PERMISSION: '1' })).exit).not.toBe(0)
  expect((await bridge({}, {}, { FIXTURE_STOP: 'max_tokens' })).exit).not.toBe(0)
})

test('plain CLI output is normalized and nonzero exits remain failures', async () => {
  const result = await bridge({ adapter: 'cli', command: '/bin/echo', args: ['{{prompt}}'] }, { prompt: 'hello' })
  expect(result).toMatchObject({ exit: 0 })
  expect(parseThread(result.output).some(event => event.detail === 'hello')).toBe(true)
  expect((await bridge({ adapter: 'cli', command: '/usr/bin/false', args: ['{{prompt}}'] })).exit).not.toBe(0)
})

test('capability probing never sends a task and resume uses the advertised session lifecycle', async () => {
  const probe = await bridge({}, { probe: true })
  expect(probe.exit).toBe(0)
  expect(probe.output).toContain('mc_capabilities')
  expect(probe.output).not.toContain('Fixture ran')
  const resumed = await bridge({}, { resumeSessionId: 'fixture-session' })
  expect(resumed.exit).toBe(0)
  expect(resumed.output).toContain('Fixture ran')
})

test('ACP file operations reject symlink and parent escapes from the workspace', async () => {
  const { workspaceFile } = await import('../server/agent-bridge')
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'mc-acp-paths-'))
  try {
    await mkdir(join(dir, 'workspace'))
    await writeFile(join(dir, 'outside.md'), 'private')
    await symlink(join(dir, 'outside.md'), join(dir, 'workspace/link.md'))
    await expect(workspaceFile('link.md', join(dir, 'workspace'))).rejects.toThrow('outside')
    await expect(workspaceFile('../outside.md', join(dir, 'workspace'), true)).rejects.toThrow('outside')
    expect(await workspaceFile('new.md', join(dir, 'workspace'), true)).toEndWith('/workspace/new.md')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
