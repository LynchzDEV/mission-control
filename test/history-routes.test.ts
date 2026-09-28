import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import type { HistoryItem } from '../server/history'
import type { JobRecord } from '../server/jobs'
import { historyRoutes } from '../server/routes/history'
import type { PastTerminal } from '../server/terminal-log'
import { projectSlug } from '../server/transcripts'

const repo = '/Users/x/Desktop/app'
const chatRoot: JobRecord = { id: 'c1', engine: 'claude', cwd: repo, worktree: null, baseRepo: null, baseBranch: null, label: 'Fix login', prompt: 'x', pid: 4242, status: 'done', startedAt: 1_000, turns: 1, slowAt: null, lastTool: null, endedAt: 2_000, exitCode: 0, diffStat: null, reviewedAt: null, sessionId: 'sess-chat', parentJobId: null, threadRoot: 'c1', terminalId: null, reviewOf: null, model: null, purpose: 'chat', project: repo }

let configDir: string
let projectsDir: string
const NOW = Date.parse('2026-09-28T00:00:00.000Z')
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-history-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  projectsDir = await mkdtemp(join(tmpdir(), 'mc-history-projects-'))
  await writeSession(repo, 'sess-free', 'cli', 'Why is the build slow?')
  await writeSession(repo, 'sess-hook', 'sdk-cli', 'Summarize this shell command for a permission prompt')
  await writeSession('/Users/x', 'sess-home', 'cli', 'what is in my home folder')
  await writeSession(repo, 'sess-chat', 'cli', 'chat turn transcript')
})
afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(projectsDir, { recursive: true, force: true })
})

async function writeSession(cwd: string, id: string, entrypoint: string, prompt: string): Promise<void> {
  const dir = join(projectsDir, projectSlug(cwd))
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  await writeFile(path, `${JSON.stringify({ type: 'user', entrypoint, cwd, message: { role: 'user', content: prompt }, timestamp: '2026-09-27T10:00:00.000Z' })}\n`)
  await utimes(path, new Date(NOW - 60_000), new Date(NOW - 60_000))
}

const local = (host = '127.0.0.1:7777') => new Request('http://127.0.0.1:7777/api/history', { headers: { host } })
const ended: PastTerminal = { id: 't0', engine: 'claude', cwd: repo, title: 'Old terminal', sessionId: 'sess-t0', createdAt: 1, endedAt: 2 }
const app = (scanTtlMs?: number) => new Elysia().use(historyRoutes({
  manager: { listJobs: () => [chatRoot] },
  registry: { list: () => [], ended: () => [ended] },
  projectsDir,
  now: () => NOW,
  ...(scanTtlMs === undefined ? {} : { scanTtlMs }),
}))

describe('GET /api/history', () => {
  test('returns the chat, the ended terminal and only the sessions a person started, from any folder', async () => {
    const response = await app().handle(local())
    expect(response.status).toBe(200)
    const { items } = await response.json() as { items: HistoryItem[] }
    expect(items.map(item => `${item.kind}:${item.id}`).sort()).toEqual(['chat:c1', 'claude-history:sess-free', 'claude-history:sess-home', 'terminal:t0'])
    expect(items.find(item => item.id === 'sess-home')).toMatchObject({ title: 'what is in my home folder', cwd: '/Users/x' })
  })
  test('refuses a rebinding host', async () => {
    const response = await app().handle(new Request('http://rebind.example/api/history'))
    expect(response.status).toBe(403)
  })
  test('the session scan is cached for the route\'s TTL', async () => {
    const instance = app()
    const first = await (await instance.handle(local())).json() as { items: HistoryItem[] }
    await writeSession(repo, 'sess-late', 'cli', 'late one')
    const second = await (await instance.handle(local())).json() as { items: HistoryItem[] }
    expect(second.items.filter(item => item.kind === 'claude-history')).toHaveLength(first.items.filter(item => item.kind === 'claude-history').length)
    const fresh = await (await app(0).handle(local())).json() as { items: HistoryItem[] }
    expect(fresh.items.some(item => item.kind === 'claude-history' && item.id === 'sess-late')).toBe(true)
  })
})
