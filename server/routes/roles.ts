import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { ENGINE_NAMES, MAX_MODEL_LENGTH } from '../engines'
import { type EngineRoles, type RoleAssignment, readConfig, writeConfig } from '../secrets'

export const ROLE_NAMES = ['plan', 'execute', 'review'] as const

export type RoleName = (typeof ROLE_NAMES)[number]

const AUTO_REVIEW_FLAGS: Record<string, boolean> = { on: true, true: true, off: false, false: false }

export function parseRoles(body: unknown): {
  ok: true
  roles: EngineRoles
  autoReview?: boolean
} | { ok: false; error: string } {
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
  const rawAutoReview = record.autoReview
  if (rawAutoReview === undefined) return { ok: true, roles }
  if (typeof rawAutoReview === 'boolean') return { ok: true, roles, autoReview: rawAutoReview }
  const flag = AUTO_REVIEW_FLAGS[rawAutoReview as string]
  if (flag === undefined) return { ok: false, error: 'autoReview must be on/off/true/false' }
  return { ok: true, roles, autoReview: flag }
}

export async function readRoles(): Promise<EngineRoles> {
  return (await readConfig()).roles
}

export async function rolesView(): Promise<EngineRoles & { autoReview: boolean }> {
  const config = await readConfig()
  return { ...config.roles, autoReview: config.autoReview }
}

export const rolesRoutes = new Elysia()
  .onBeforeHandle(requireSession)
  .get('/api/roles', () => rolesView())
  .post('/api/roles', async ({ body, set }) => {
    const parsed = parseRoles(body)
    if (!parsed.ok) {
      set.status = 400
      return { error: parsed.error }
    }
    const current = await readConfig()
    const config = await writeConfig({
      roles: parsed.roles,
      autoReview: parsed.autoReview ?? current.autoReview,
    })
    return { ...config.roles, autoReview: config.autoReview }
  })
