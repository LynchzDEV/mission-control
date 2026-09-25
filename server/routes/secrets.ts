import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import {
  type PublicSecretsView,
  publicView,
  readApiToken,
  readSecrets,
  rotateApiToken,
  writeSecrets,
} from '../secrets'

export type SecretsPatch = {
  zaiAuthToken?: unknown
  zaiBaseUrl?: unknown
}

export type SecretsResponse = PublicSecretsView

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
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
  const [secrets, apiToken] = await Promise.all([readSecrets(), readApiToken()])
  return publicView({ ...secrets, apiToken })
}

export async function applyPatch(
  patch: SecretsPatch,
): Promise<{ ok: true; view: SecretsResponse } | { ok: false; status: number; error: string }> {
  const token = cleanString(patch.zaiAuthToken)
  const baseUrl = cleanString(patch.zaiBaseUrl)

  if (token === null && baseUrl === null) {
    return { ok: false, status: 400, error: 'nothing to update' }
  }
  if (baseUrl !== null && !validUrl(baseUrl)) {
    return { ok: false, status: 400, error: 'zaiBaseUrl must be an http(s) url' }
  }

  await writeSecrets({
    ...(token === null ? {} : { zaiAuthToken: token }),
    ...(baseUrl === null ? {} : { zaiBaseUrl: baseUrl }),
  })

  return { ok: true, view: await currentView() }
}

export const secretsRoutes = new Elysia()
  .onBeforeHandle(requireLocal)
  .get('/api/secrets', () => currentView())
  .post('/api/secrets', async ({ body, set }) => {
    const result = await applyPatch((body ?? {}) as SecretsPatch)
    if (!result.ok) {
      set.status = result.status
      return { error: result.error }
    }
    return { ok: true, ...result.view }
  })
  .post('/api/secrets/api-token/reveal', async () => ({ apiToken: await readApiToken() }))
  .post('/api/secrets/api-token/rotate', async () => ({ apiToken: await rotateApiToken() }))
