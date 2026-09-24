import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { parseRunInput, type PlanRunner } from '../plan-runner'

export function runsRoutes(runner: PlanRunner): Elysia {
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .post('/api/flow/:label/run', async ({ params, body, set }) => {
      const label = decodeURIComponent(params.label)
      const parsed = parseRunInput({ ...(typeof body === 'object' && body !== null ? body : {}), label })
      if (!parsed.ok) {
        set.status = parsed.misses ? 422 : 400
        return { error: parsed.error, ...(parsed.misses ? { misses: parsed.misses } : {}) }
      }
      const result = await runner.start(parsed.value)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }
      return result.run
    })
    .get('/api/flow/:label/run', ({ params, set }) => {
      const run = runner.get(decodeURIComponent(params.label))
      if (run === undefined) {
        set.status = 404
        return { error: 'no run for that label' }
      }
      return run
    })
    .post('/api/flow/:label/run/stop', async ({ params, set }) => {
      const result = await runner.stop(decodeURIComponent(params.label))
      if (!result.ok) set.status = result.status
      return result
    })
}
