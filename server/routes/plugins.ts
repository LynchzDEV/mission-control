import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { createInstaller, type Installer } from '../plugins/installer'
import { addMarketplace, catalog, listMarketplaces, removeMarketplace } from '../plugins/marketplaces'
import { setSetting, settingsView } from '../plugins/settings'
import { listInstalled } from '../plugins/store'

function failureBody(result: { ok: false; status: number }): Record<string, unknown> {
  const { ok: _ok, status: _status, ...body } = result
  return body
}

function successBody<T extends { ok: true }>(result: T): Record<string, unknown> {
  const { ok: _ok, ...body } = result
  return body
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export function pluginsRoutes(deps: { installer?: Installer } = {}) {
  const installer = deps.installer ?? createInstaller()
  return new Elysia()
    .onBeforeHandle(requireLocal)
    .get('/api/plugins', async () => ({ plugins: await listInstalled() }))
    .get('/api/plugins/marketplaces', async () => ({ marketplaces: await listMarketplaces() }))
    .post('/api/plugins/marketplaces', async ({ body, set }) => {
      const result = await addMarketplace(text((body as Record<string, unknown> | null)?.url))
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return { marketplaces: await listMarketplaces() }
    })
    .delete('/api/plugins/marketplaces', async ({ body, set }) => {
      const result = await removeMarketplace(text((body as Record<string, unknown> | null)?.url))
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return { marketplaces: await listMarketplaces() }
    })
    .get('/api/plugins/catalog', async () => ({ entries: await catalog() }))
    .post('/api/plugins/preview', async ({ body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      const result = await installer.preview({ repo: text(parsed.repo), ref: text(parsed.ref) })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return successBody(result)
    })
    .post('/api/plugins/install', async ({ body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      const result = await installer.install({
        repo: text(parsed.repo),
        ref: text(parsed.ref),
        commit: text(parsed.commit),
        trust: parsed.trust === true,
        marketplace: optionalText(parsed.marketplace),
      })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return successBody(result)
    })
    .post('/api/plugins/:id/update', async ({ params, body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      const result = await installer.update(params.id, {
        ref: optionalText(parsed.ref),
        commit: text(parsed.commit),
        accept: parsed.accept === true,
        trust: parsed.trust === true,
        repo: optionalText(parsed.repo),
      })
      if (!result.ok) { set.status = result.status; return failureBody(result) }
      return successBody(result)
    })
    .delete('/api/plugins/:id', async ({ params, body, set }) => {
      const keepData = ((body ?? {}) as Record<string, unknown>).keepData
      if (keepData !== undefined && typeof keepData !== 'boolean') {
        set.status = 400
        return { error: 'keepData must be true or false' }
      }
      const result = await installer.uninstall(params.id, { keepData: keepData === undefined ? undefined : keepData })
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return { ok: true, keptData: result.keptData }
    })
    .patch('/api/plugins/:id', async ({ params, body, set }) => {
      const enabled = ((body ?? {}) as Record<string, unknown>).enabled
      if (typeof enabled !== 'boolean') { set.status = 400; return { error: 'enabled must be true or false' } }
      const result = await installer.setEnabled(params.id, enabled)
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return successBody(result)
    })
    .get('/api/plugins/:id/settings', async ({ params, set }) => {
      const result = await settingsView(params.id)
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return result.value
    })
    .put('/api/plugins/:id/settings', async ({ params, body, set }) => {
      const parsed = (body ?? {}) as Record<string, unknown>
      if (typeof parsed.key !== 'string' || parsed.key === '') { set.status = 400; return { error: 'key is required' } }
      if (parsed.value !== null && typeof parsed.value !== 'string') { set.status = 400; return { error: 'value must be a string or null' } }
      const result = await setSetting(params.id, parsed.key, parsed.value)
      if (!result.ok) { set.status = result.status; return { error: result.error } }
      return result.value
    })
}
