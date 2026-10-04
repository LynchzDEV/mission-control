import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { gitTimed } from '../job-worktrees'
import { configDir, DIR_MODE, ensureConfigDir, readConfig, writeConfig, type MarketplaceRef } from '../secrets'
import { applyPrivateModes } from './checkout-tree'
import { errorMessage } from './errors'
import { isAllowedRepoUrl, marketplaceSlug } from './repo-url'

const GIT_TIMEOUT = 120_000

export type CatalogPlugin = {
  id: string
  repo: string
  ref: string
  name: string
  description: string
  runtime: 'trusted' | 'isolated'
}

export type CatalogEntry =
  | { marketplace: string; name: string | null; plugins: CatalogPlugin[]; skipped: Array<{ id: string | null; reason: string }> }
  | { marketplace: string; error: string }

export type MarketplaceResult = { ok: true } | { ok: false; status: number; error: string }

export function marketplaceDir(url: string): string {
  return join(configDir(), 'marketplaces', marketplaceSlug(url))
}

export async function listMarketplaces(): Promise<MarketplaceRef[]> {
  return (await readConfig()).marketplaces
}

export function marketplacesRoot(): string {
  return join(configDir(), 'marketplaces')
}

async function isGitCheckout(dir: string): Promise<boolean> {
  return (await stat(join(dir, '.git')).catch(() => null))?.isDirectory() ?? false
}

export async function syncMarketplace(url: string): Promise<void> {
  const dir = marketplaceDir(url)
  if (await isGitCheckout(dir)) {
    await gitTimed(dir, GIT_TIMEOUT, ['fetch', '--depth', '1', 'origin'])
    await gitTimed(dir, GIT_TIMEOUT, ['reset', '--hard', 'FETCH_HEAD'])
  } else {
    await mkdir(marketplacesRoot(), { recursive: true, mode: DIR_MODE })
    await chmod(marketplacesRoot(), DIR_MODE)
    await ensureConfigDir()
    const fresh = `${dir}.clone-${crypto.randomUUID()}`
    try {
      await gitTimed(configDir(), GIT_TIMEOUT, ['clone', '--depth', '1', url, fresh])
      await rm(dir, { recursive: true, force: true })
      await rename(fresh, dir)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  }
  await applyPrivateModes(dir)
}

export async function addMarketplace(url: string): Promise<MarketplaceResult> {
  if (!isAllowedRepoUrl(url)) return { ok: false, status: 400, error: 'Marketplace url must be https://, git@host:path or file://' }
  try {
    await syncMarketplace(url)
  } catch (error) {
    return { ok: false, status: 400, error: `Couldn't reach this marketplace: ${errorMessage(error)}` }
  }
  const current = await listMarketplaces()
  const next = [...current.filter(entry => entry.url !== url), { url }]
  await writeConfig({ marketplaces: next })
  return { ok: true }
}

export async function removeMarketplace(url: string): Promise<MarketplaceResult> {
  const current = await listMarketplaces()
  const next = current.filter(entry => entry.url !== url)
  if (next.length === current.length) return { ok: false, status: 404, error: 'That marketplace is not added' }
  await writeConfig({ marketplaces: next })
  await rm(marketplaceDir(url), { recursive: true, force: true })
  return { ok: true }
}

function catalogPlugin(entry: unknown): { plugin: CatalogPlugin } | { skip: { id: string | null; reason: string } } {
  const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : null
  if (id === null) return { skip: { id: null, reason: 'missing id' } }
  if (typeof record.repo !== 'string' || record.repo === '') return { skip: { id, reason: 'missing repo' } }
  if (typeof record.ref !== 'string' || record.ref === '') return { skip: { id, reason: 'missing ref' } }
  if (record.runtime !== 'trusted' && record.runtime !== 'isolated') return { skip: { id, reason: 'invalid runtime' } }
  return {
    plugin: {
      id,
      repo: record.repo,
      ref: record.ref,
      name: typeof record.name === 'string' ? record.name : id,
      description: typeof record.description === 'string' ? record.description : '',
      runtime: record.runtime,
    },
  }
}

async function catalogEntry(url: string): Promise<CatalogEntry> {
  const file = join(marketplaceDir(url), 'marketplace.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { marketplace: url, error: 'marketplace.json is missing — sync this marketplace first' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { marketplace: url, error: 'marketplace.json is not valid JSON' }
  }
  const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  const entries = Array.isArray(record.plugins) ? record.plugins : []
  const plugins: CatalogPlugin[] = []
  const skipped: Array<{ id: string | null; reason: string }> = []
  for (const entry of entries) {
    const result = catalogPlugin(entry)
    if ('plugin' in result) plugins.push(result.plugin)
    else skipped.push(result.skip)
  }
  return {
    marketplace: url,
    name: typeof record.name === 'string' ? record.name : null,
    plugins,
    skipped,
  }
}

export async function catalog(): Promise<CatalogEntry[]> {
  const urls = await listMarketplaces()
  return Promise.all(urls.map(entry => catalogEntry(entry.url)))
}
