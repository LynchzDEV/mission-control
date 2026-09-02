import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { ENGINE_NAMES } from '../engines'
import { type EngineRoles, readConfig, writeConfig } from '../secrets'

export const ROLE_NAMES = ['plan', 'execute', 'review'] as const

export type RoleName = (typeof ROLE_NAMES)[number]

export function parseRoles(body: unknown): { ok: true; roles: EngineRoles } | { ok: false; error: string } {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const roles: Record<RoleName, string> = { plan: '', execute: '', review: '' }
  for (const role of ROLE_NAMES) {
    const engine = record[role]
    if (typeof engine !== 'string' || !(ENGINE_NAMES as readonly string[]).includes(engine)) {
      return { ok: false, error: `${role} must be one of ${ENGINE_NAMES.join(', ')}` }
    }
    roles[role] = engine
  }
  return { ok: true, roles }
}

export async function readRoles(): Promise<EngineRoles> {
  return (await readConfig()).roles
}

export const rolesRoutes = new Elysia()
  .onBeforeHandle(requireSession)
  .get('/api/roles', () => readRoles())
  .post('/api/roles', async ({ body, set }) => {
    const parsed = parseRoles(body)
    if (!parsed.ok) {
      set.status = 400
      return { error: parsed.error }
    }
    return (await writeConfig({ roles: parsed.roles })).roles
  })
