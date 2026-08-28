import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import {
  type PublicSecretsView,
  parseBind,
  publicView,
  readConfig,
  readSecrets,
  writeConfig,
  writeSecrets,
} from '../secrets'

export type SecretsPatch = {
  zaiAuthToken?: unknown
  zaiBaseUrl?: unknown
  bind?: unknown
}

export type SecretsResponse = PublicSecretsView & { bind: string }

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function isBind(value: string): boolean {
  const target = parseBind(value)
  return `${target.hostname}:${target.port}` === value
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export async function currentView(): Promise<SecretsResponse> {
  const [secrets, config] = await Promise.all([readSecrets(), readConfig()])
  return { ...publicView(secrets), bind: config.bind }
}

export async function applyPatch(
  patch: SecretsPatch,
): Promise<{ ok: true; view: SecretsResponse } | { ok: false; status: number; error: string }> {
  const token = cleanString(patch.zaiAuthToken)
  const baseUrl = cleanString(patch.zaiBaseUrl)
  const bind = cleanString(patch.bind)

  if (token === null && baseUrl === null && bind === null) {
    return { ok: false, status: 400, error: 'nothing to update' }
  }
  if (baseUrl !== null && !validUrl(baseUrl)) {
    return { ok: false, status: 400, error: 'zaiBaseUrl must be an http(s) url' }
  }
  if (bind !== null && !isBind(bind)) {
    return { ok: false, status: 400, error: 'bind must be host:port' }
  }

  if (token !== null || baseUrl !== null) {
    await writeSecrets({
      ...(token === null ? {} : { zaiAuthToken: token }),
      ...(baseUrl === null ? {} : { zaiBaseUrl: baseUrl }),
    })
  }
  if (bind !== null) await writeConfig({ bind })

  return { ok: true, view: await currentView() }
}

export const secretsRoutes = new Elysia()
  .onBeforeHandle(requireSession)
  .get('/api/secrets', () => currentView())
  .post('/api/secrets', async ({ body, set }) => {
    const result = await applyPatch((body ?? {}) as SecretsPatch)
    if (!result.ok) {
      set.status = result.status
      return { error: result.error }
    }
    return { ok: true, ...result.view }
  })
