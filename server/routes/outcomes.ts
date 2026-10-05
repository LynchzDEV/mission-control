import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import type { OutcomeLedger } from '../outcomes'

export const DEFAULT_OUTCOME_LIMIT = 200
export const MAX_OUTCOME_LIMIT = 500
const SESSION_ID = /^[A-Za-z0-9-]{1,80}$/
const COUNT = /^\d{1,9}$/

export type OutcomeQuery = { key: string; after: number; limit: number }

export function outcomeQuery(query: Record<string, string | undefined>): OutcomeQuery | { error: string } {
  const { terminal, chat, after = '0', limit = String(DEFAULT_OUTCOME_LIMIT) } = query
  if ((terminal === undefined) === (chat === undefined)) return { error: 'pass exactly one of terminal or chat' }
  const id = (terminal ?? chat)!
  if (!SESSION_ID.test(id)) return { error: 'invalid session id' }
  if (!COUNT.test(after) || !COUNT.test(limit) || Number(limit) < 1) return { error: 'after and limit must be whole numbers' }
  return { key: `${terminal ? 'terminal' : 'chat'}:${id}`, after: Number(after), limit: Math.min(Number(limit), MAX_OUTCOME_LIMIT) }
}

export function outcomesRoutes(ledger: OutcomeLedger) {
  return new Elysia().onBeforeHandle(requireLocal).get('/api/outcomes', async ({ query, set }) => {
    const parsed = outcomeQuery(query as Record<string, string | undefined>)
    if ('error' in parsed) {
      set.status = 400
      return { error: parsed.error }
    }
    const page = await ledger.read(parsed.key, parsed.after, parsed.limit)
    if (page === null) {
      set.status = 404
      return { error: 'session not found' }
    }
    return page
  })
}
