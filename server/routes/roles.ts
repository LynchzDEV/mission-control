import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { ENGINE_NAMES, MAX_MODEL_LENGTH } from '../engines'
import { type EngineRoles, type RoleAssignment, readConfig, writeConfig } from '../secrets'

export const ROLE_NAMES = ['plan', 'execute', 'review'] as const

export type RoleName = (typeof ROLE_NAMES)[number]

export function parseRoles(body: unknown): { ok: true; roles: EngineRoles } | { ok: false; error: string } {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const roles: Record<RoleName, RoleAssignment> = {
    plan: { engine: '', model: null },
    execute: { engine: '', model: null },
    review: { engine: '', model: null },
  }
  for (const role of ROLE_NAMES) {
    const value = record[role]
    const nested = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
    const engine = typeof value === 'string' ? value : nested?.engine
    if (typeof engine !== 'string' || !(ENGINE_NAMES as readonly string[]).includes(engine)) {
      return { ok: false, error: `${role} must be one of ${ENGINE_NAMES.join(', ')}` }
    }
    const flat = record[`${role}_model`]
    const rawModel = typeof flat === 'string' ? flat : typeof nested?.model === 'string' ? nested.model : null
    const model = rawModel === null ? null : rawModel.trim()
    if (model !== null && model.length > MAX_MODEL_LENGTH) {
      return { ok: false, error: `${role} model too long` }
    }
    roles[role] = { engine, model: model === '' ? null : model }
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
