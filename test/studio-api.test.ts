import { afterEach, expect, test } from 'bun:test'
import { openRun } from '../client/studio-api'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('opening a run from the flow refreshes the run list before the run is handed back to reveal', async () => {
  const order: string[] = []
  globalThis.fetch = (async (url: string) => { order.push(String(url)); return Response.json({ id: 'run-1', status: 'running' }) }) as typeof fetch
  const refreshRuns = async (): Promise<void> => { await Bun.sleep(1); order.push('runs refreshed') }
  const run = await openRun<{ id: string }>('run 1', refreshRuns)
  expect(run.id).toBe('run-1')
  expect(order).toEqual(['/api/studio/runs/run%201', 'runs refreshed'])
})

test('a run that cannot be loaded is reported and nothing is revealed', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'Run not found' }, { status: 404 })) as unknown as typeof fetch
  await expect(openRun('gone', async () => {})).rejects.toThrow('Run not found')
})
