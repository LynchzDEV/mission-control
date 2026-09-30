import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Elysia } from 'elysia'

import { createJobManager } from '../server/jobs'
import type { JobManager } from '../server/jobs'
import type { EngineResolver } from '../server/jobs-engine-iface'
import { jobsRoutes } from '../server/routes/jobs'
import { initScratchGitRepo } from './support/scratch-git-repo'

let configDir: string
let repo: string
let manager: JobManager

const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, uuid: `u-${id}`, parent_tool_use_id: null })
const toolResult = (id: string, isError: boolean): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'Edit failed' : 'The file has been updated.', is_error: isError }] }, parent_tool_use_id: null })
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-undo' })
const done = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })

function logResolver(lines: string[]): EngineResolver {
  const script = lines.map(line => `printf '%s\\n' '${line.replace(/'/g, `'\\''`)}'`).join('; ')
  return () => ({ cmd: '/bin/sh', args: ['-c', script], env: {} })
}

function app(resolver: EngineResolver): Elysia {
  return new Elysia().use(jobsRoutes(manager, resolver))
}

const post = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const get = (path: string): Request => new Request(`http://localhost${path}`)
const patch = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function settledChat(resolver: EngineResolver, label: string): Promise<string> {
  const created = await app(resolver).handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'fix it', label, purpose: 'chat' }))
  const { id } = (await created.json()) as { id: string }
  const deadline = Date.now() + 3000
  for (;;) {
    const job = manager.getJob(id)
    if (job !== undefined && job.status !== 'running') return id
    if (Date.now() > deadline) throw new Error('chat turn did not settle')
    await new Promise(resolve => setTimeout(resolve, 30))
  }
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-undo-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  repo = await mkdtemp(join(homedir(), 'mc-undo-scratch-'))
  await initScratchGitRepo(repo)
  await mkdir(join(repo, 'demo'), { recursive: true })
  await writeFile(join(repo, 'demo', 'notes.txt'), 'first line\nsecond line\n')
  manager = createJobManager()
})

afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
})

describe('POST /api/jobs/:id/undo', () => {
  test('an Edit undo restores the previous text once', async () => {
    const id = await settledChat(logResolver([
      init,
      toolUse('toolu_01', 'Edit', { file_path: 'demo/notes.txt', old_string: 'first line', new_string: 'first line edited' }),
      toolResult('toolu_01', false),
      done,
    ]), 'edit-once')
    await writeFile(join(repo, 'demo', 'notes.txt'), 'first line edited\nsecond line\n')
    const response = await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_01' }))
    expect(response.status).toBe(200)
    expect(await readFile(join(repo, 'demo', 'notes.txt'), 'utf8')).toBe('first line\nsecond line\n')
    expect(manager.getJob(id)?.undone).toEqual(['toolu_01'])
  })

  test('a second undo of a changed file reports the change', async () => {
    const id = await settledChat(logResolver([
      init,
      toolUse('toolu_02', 'Edit', { file_path: 'demo/notes.txt', old_string: 'second line', new_string: 'second line gone' }),
      toolResult('toolu_02', false),
      done,
    ]), 'edit-twice')
    await writeFile(join(repo, 'demo', 'notes.txt'), 'first line\nsecond line gone\n')
    const undo = await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_02' }))
    expect(undo.status).toBe(200)
    const repeated = await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_02' }))
    expect(repeated.status).toBe(409)
    expect(await repeated.json()).toEqual({ error: 'The file changed since this edit; undo it by hand' })
  })

  test('a MultiEdit undo applies the inverse edits in reverse order', async () => {
    const id = await settledChat(logResolver([
      init,
      toolUse('toolu_03', 'MultiEdit', { file_path: 'demo/notes.txt', edits: [
        { old_string: 'first line', new_string: 'FIRST' },
        { old_string: 'second line', new_string: 'SECOND' },
      ] }),
      toolResult('toolu_03', false),
      done,
    ]), 'multi-edit')
    await writeFile(join(repo, 'demo', 'notes.txt'), 'FIRST\nSECOND\n')
    const response = await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_03' }))
    expect(response.status).toBe(200)
    expect(await readFile(join(repo, 'demo', 'notes.txt'), 'utf8')).toBe('first line\nsecond line\n')
  })

  test('a path outside the chat folder is refused', async () => {
    const id = await settledChat(logResolver([
      init,
      toolUse('toolu_04', 'Edit', { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }),
      toolResult('toolu_04', false),
      done,
    ]), 'outside')
    const response = await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_04' }))
    expect(response.status).toBe(403)
  })

  test('replace_all edits and failed calls cannot be undone', async () => {
    const id = await settledChat(logResolver([
      init,
      toolUse('toolu_05', 'Edit', { file_path: 'demo/notes.txt', old_string: 'line', new_string: 'LINE', replace_all: true }),
      toolResult('toolu_05', false),
      toolUse('toolu_06', 'Edit', { file_path: 'demo/notes.txt', old_string: 'first line', new_string: 'broken' }),
      toolResult('toolu_06', true),
      done,
    ]), 'refused')
    const first = await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_05' }))
    expect(first.status).toBe(409)
    expect(await first.json()).toEqual({ error: 'This edit cannot be undone automatically' })
    const failed = await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_06' }))
    expect(failed.status).toBe(409)
    expect(await failed.json()).toEqual({ error: 'Only a successful Edit or MultiEdit call can be undone' })
    expect((await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'missing' }))).status).toBe(409)
    expect((await app(logResolver([])).handle(post(`/api/jobs/${id}/undo`, {}))).status).toBe(400)
    expect((await app(logResolver([])).handle(post('/api/jobs/nope/undo', { toolUseId: 'x' }))).status).toBe(404)
  })

  test('a running chat refuses the undo', async () => {
    const sleepResolver: EngineResolver = () => ({ cmd: 'sleep', args: ['30'], env: {} })
    const running = new Elysia().use(jobsRoutes(manager, sleepResolver))
    const created = await running.handle(post('/api/jobs', { engine: 'claude', cwd: repo, prompt: 'busy', label: 'busy-chat', purpose: 'chat' }))
    const { id } = (await created.json()) as { id: string }
    const response = await running.handle(post(`/api/jobs/${id}/undo`, { toolUseId: 'toolu_01' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Wait for the reply to finish' })
    await manager.killJob(id)
    expect((await running.handle(get(`/api/jobs/${id}/thread`))).status).toBe(200)
    expect((await running.handle(patch(`/api/jobs/${id}`, { pinned: true })))).toBeTruthy()
  })
})
