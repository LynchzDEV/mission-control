import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'

import type { HistoryItem } from '../server/history'
import type { JobRecord } from '../server/jobs'
import { historyRoutes } from '../server/routes/history'
import { projectSlug } from '../server/transcripts'

const repo = '/Users/x/Desktop/app'
const chatRoot: JobRecord = { id: 'c1', engine: 'claude', cwd: repo, worktree: null, baseRepo: null, baseBranch: null, label: 'Fix login', prompt: 'x', pid: 4242, status: 'done', startedAt: 1_000, turns: 1, slowAt: null, lastTool: null, endedAt: 2_000, exitCode: 0, diffStat: null, reviewedAt: null, sessionId: 'sess-chat', parentJobId: null, threadRoot: 'c1', terminalId: null, reviewOf: null, model: null, purpose: 'chat', project: repo }

let configDir: string
let projectsDir: string
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-history-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  projectsDir = await mkdtemp(join(tmpdir(), 'mc-history-projects-'))
  const sessionDir = join(projectsDir, projectSlug(repo))
  await mkdir(sessionDir)
  const line = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-01T10:00:00.000Z' })}\n`
  await writeFile(join(sessionDir, 'sess-free.jsonl'), line('Why is the build slow?'))
  await writeFile(join(sessionDir, 'sess-chat.jsonl'), line('chat turn transcript'))
})
afterEach(async () => {
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
  await rm(projectsDir, { recursive: true, force: true })
})

const local = (host = '127.0.0.1:7777') => new Request('http://127.0.0.1:7777/api/history', { headers: { host } })
const app = () => new Elysia().use(historyRoutes({
  manager: { listJobs: () => [chatRoot] },
  registry: { list: () => [] },
  knownDirectories: () => [repo, repo, '/Users/x/missing'],
  external: async () => [
    { pid: 4242, engine: 'claude', etime: '00:10', cwdHint: repo },
    { pid: 7, engine: 'codex', etime: '00:20', cwdHint: '/Users/x/other' },
  ],
  projectsDir,
}))

describe('GET /api/history', () => {
  test('returns the chat, the free transcript and only the foreign outside session', async () => {
    const response = await app().handle(local())
    expect(response.status).toBe(200)
    const { items } = await response.json() as { items: HistoryItem[] }
    expect(items.map(item => `${item.kind}:${item.id}`).sort()).toEqual(['chat:c1', 'claude-history:sess-free', 'outside:7'])
    expect(items.find(item => item.kind === 'claude-history')).toMatchObject({ title: 'Why is the build slow?', cwd: repo })
  })
  test('refuses a rebinding host', async () => {
    const response = await app().handle(new Request('http://rebind.example/api/history'))
    expect(response.status).toBe(403)
  })
})
