import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQueueEngine, type QueueEngineDeps } from '../server/queue-engine'
import type { RunView } from '../server/queue-prompts'
import type { QueueSource, SourceReplies } from '../server/queue-source'
import { createQueueStore } from '../server/queue-store'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-queue-replies-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function parked(replies: () => Promise<SourceReplies>) {
  const store = createQueueStore(join(dir, 'queue.json'))
  const runs = new Map<string, RunView>()
  const alerts: string[] = []
  const requests: string[] = []
  let next = 0
  const files = join(dir, 'plugin-data', 'clickup-board', 'files')
  const source: QueueSource = { item: async ({ id }) => ({ title: `Task ${id}`, url: 'u', contextMarkdown: '# t' }), post: async () => ({ commentId: 'c1' }), replies }
  const deps: QueueEngineDeps = {
    store,
    runner: { start: async input => { requests.push(input.request); const id = `run-${++next}`; runs.set(id, { id, status: 'running', error: null, attempts: [] }); return { id } }, get: id => runs.get(id) },
    source: () => source,
    prepareWorktree: async (_repo, label) => { const worktree = join(dir, 'wt', label); await mkdir(worktree, { recursive: true }); return { worktree } },
    writeContext: async (pluginId, context, cwd) => { const folder = join(cwd, '.mission-control', 'context', pluginId); await mkdir(folder, { recursive: true }); const path = join(folder, `${context.name}.md`); await writeFile(path, context.markdown); return path },
    pluginFiles: () => files,
    needsYou: (_item, reason) => { alerts.push(reason) },
  }
  const engine = createQueueEngine(deps)
  const item = await engine.add({ source: 'clickup-board', externalId: '1', repo: '/repo' })
  await engine.onRunSettled({ id: 'run-1', status: 'blocked', error: null, attempts: [{ nodeId: 'plan', number: 1, jobId: 'j', status: 'settled', prompt: '', startedAt: 1, endedAt: 2, result: { outcome: 'blocked', summary: 's', evidence: ['Which page?'] }, checks: [], output: '', workspace: null, tokenId: 't', pathId: 'main', from: [] }] })
  return { engine, store, item, alerts, requests, files }
}

test('no replies keeps the item waiting', async () => {
  const h = await parked(async () => ({ replies: [], lastId: null }))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 0 })
  expect(h.store.get(h.item.id)!.state).toBe('waiting-info')
})

test('a reply writes the answers, puts the item first and rebuilds it with the answers', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'The login page', images: [] }], lastId: 'r1' }))
  expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
  const item = h.store.get(h.item.id)!
  expect(item).toMatchObject({ state: 'building', questions: [], lastSeenId: 'r1', runIds: ['run-1', 'run-2'] })
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain('The login page')
  expect(h.requests[1]).toContain(`The requester answered your earlier questions: read ${item.answerPaths[0]}`)
})

test('reply images are copied into the worktree context folder and listed', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'See this', images: [{ name: 'shot.png', path: 'replies/shot.png' }] }], lastId: 'r1' }))
  await mkdir(join(h.files, 'replies'), { recursive: true })
  await writeFile(join(h.files, 'replies', 'shot.png'), 'png-bytes')
  await h.engine.checkReplies()
  const item = h.store.get(h.item.id)!
  const copied = join(item.worktree!, '.mission-control', 'context', 'clickup-board', 'r1-shot.png')
  expect(await readFile(copied, 'utf8')).toBe('png-bytes')
  expect(await readFile(item.answerPaths[0]!, 'utf8')).toContain(`- ${copied}`)
})

test('images outside the plugin data folder are skipped', async () => {
  const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'key', path: '../../../secret' }] }], lastId: 'r1' }))
  await writeFile(join(dir, 'secret'), 'do not copy')
  await h.engine.checkReplies()
  const item = h.store.get(h.item.id)!
  await expect(stat(join(item.worktree!, '.mission-control', 'context', 'clickup-board', 'r1-key'))).rejects.toThrow()
  expect(await readFile(item.answerPaths[0]!, 'utf8')).not.toContain('## Images')
})

test('a missing reply image is logged and left out of the answers', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const h = await parked(async () => ({ replies: [{ id: 'r1', author: 'Ploy', text: 'x', images: [{ name: 'gone.png', path: 'replies/gone.png' }] }], lastId: 'r1' }))
    expect(await h.engine.checkReplies()).toEqual({ checked: 1, resumed: 1 })
    const item = h.store.get(h.item.id)!
    expect(await readFile(item.answerPaths[0]!, 'utf8')).not.toContain('## Images')
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
})

test('a failing source keeps the item waiting and asks for you after three failures', async () => {
  const h = await parked(async () => { throw new Error('ClickUp is down') })
  await h.engine.checkReplies()
  await h.engine.checkReplies()
  expect(h.alerts).toEqual([])
  await h.engine.checkReplies()
  expect(h.store.get(h.item.id)!.state).toBe('waiting-info')
  expect(h.alerts).toEqual(['Could not read replies: ClickUp is down'])
})

test('the failure count resets after an alert and after a good read', async () => {
  let down = true
  const h = await parked(async () => { if (down) throw new Error('ClickUp is down'); return { replies: [], lastId: null } })
  for (let i = 0; i < 4; i += 1) await h.engine.checkReplies()
  expect(h.alerts).toHaveLength(1)
  down = false
  await h.engine.checkReplies()
  down = true
  await h.engine.checkReplies()
  await h.engine.checkReplies()
  expect(h.alerts).toHaveLength(1)
})
