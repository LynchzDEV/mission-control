import { join } from 'node:path'

import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { validateWorkspaceCwd } from '../workspace'
import { ContextTooLarge, writeContextFile } from '../plugins/context-files'
import { createInstaller, type Installer } from '../plugins/installer'
import { addMarketplace, catalog, listMarketplaces, removeMarketplace } from '../plugins/marketplaces'
import { defaultRuntimes, type Runtimes } from '../plugins/runtimes'
import { setSetting, settingsView } from '../plugins/settings'
import { getInstalled, listInstalled, pluginFolder } from '../plugins/store'

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

export function pluginsRoutes(deps: { installer?: Installer; runtimes?: Runtimes } = {}) {
  const installer = deps.installer ?? createInstaller()
  const runtimesPromise = deps.runtimes === undefined ? defaultRuntimes() : Promise.resolve(deps.runtimes)
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
    .post('/api/plugins/:id/context', async ({ params, body, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null) { set.status = 404; return { error: 'That plugin is not installed' } }
      if (!installed.enabled) { set.status = 409; return { error: 'This plugin is turned off' } }
      if ((installed.permissions.sessions ?? []).length === 0) { set.status = 403; return { error: 'This plugin did not ask to start sessions' } }
      const parsed = (body ?? {}) as Record<string, unknown>
      if (typeof parsed.name !== 'string' || parsed.name === '') { set.status = 400; return { error: 'name is required' } }
      if (typeof parsed.markdown !== 'string') { set.status = 400; return { error: 'markdown is required' } }
      if (typeof parsed.cwd !== 'string' || parsed.cwd === '') { set.status = 400; return { error: 'cwd is required' } }
      const folder = await validateWorkspaceCwd(parsed.cwd)
      if (!folder.ok) { set.status = 400; return { error: folder.error } }
      try {
        return { path: await writeContextFile(params.id, { name: parsed.name, markdown: parsed.markdown }, new Date(), folder.path) }
      } catch (error) {
        if (error instanceof ContextTooLarge) { set.status = 400; return { error: error.message } }
        throw error
      }
    })
    .post('/api/plugins/:id/call', async ({ params, body, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null) { set.status = 404; return { error: 'That plugin is not installed' } }
      if (!installed.enabled) { set.status = 409; return { error: 'This plugin is turned off' } }
      const parsed = (body ?? {}) as Record<string, unknown>
      if (typeof parsed.method !== 'string' || parsed.method === '') { set.status = 400; return { error: 'method is required' } }
      const pool = await runtimesPromise
      const runtime = await pool.getRuntime(installed)
      if (!runtime.ok) { set.status = runtime.status; return { error: runtime.error } }
      const outcome = await runtime.runtime.call(parsed.method, parsed.params)
      if (!outcome.ok) { set.status = outcome.status; return { error: outcome.error } }
      return { result: outcome.result }
    })
    .get('/api/plugins/:id/icon', async ({ params, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null || !installed.enabled || installed.icon === undefined) { set.status = 404; return { error: 'not found' } }
      const type = installed.icon.endsWith('.svg') ? 'image/svg+xml' : installed.icon.endsWith('.png') ? 'image/png' : null
      if (type === null) { set.status = 404; return { error: 'not found' } }
      const file = Bun.file(join(pluginFolder(params.id), installed.icon))
      if (!await file.exists()) { set.status = 404; return { error: 'not found' } }
      return new Response(file, { headers: { 'content-type': type } })
    })
    .get('/plugin-module/:id/screen.js', async ({ params, set }) => {
      const installed = await getInstalled(params.id)
      if (installed === null || !installed.enabled || installed.runtime !== 'trusted') {
        set.status = 404
        return { error: 'not found' }
      }
      const file = Bun.file(join(pluginFolder(params.id), '.mc-build', 'screen.js'))
      if (!await file.exists()) { set.status = 404; return { error: 'not found' } }
      return new Response(file, { headers: { 'content-type': 'text/javascript' } })
    })
}
