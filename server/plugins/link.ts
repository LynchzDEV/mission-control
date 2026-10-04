import { gitTimed } from '../job-worktrees'
import { configDir } from '../secrets'
import type { Installer, PreviewResult } from './installer'
import { addMarketplace } from './marketplaces'
import { isAllowedRepoUrl } from './repo-url'

const GIT_TIMEOUT = 60_000
const VERSION_TAG = /^v?\d+\.\d+\.\d+$/

export const NOT_A_PLUGIN_OR_MARKETPLACE = "This repo isn't a Mission Control plugin or marketplace."

export type LinkResult =
  | { ok: true; kind: 'plugin'; ref: string; preview: Extract<PreviewResult, { ok: true }> }
  | { ok: true; kind: 'marketplace' }
  | { ok: false; status: number; error: string; step?: string }

export function pickRef(lsRemote: string): string | null {
  let defaultBranch: string | null = null
  const tags: string[] = []
  for (const line of lsRemote.split('\n')) {
    const symref = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/)
    if (symref) { defaultBranch = symref[1]!; continue }
    const tag = line.match(/\trefs\/tags\/([^\s^]+)$/)
    if (tag && VERSION_TAG.test(tag[1]!)) tags.push(tag[1]!)
  }
  const newest = tags.sort((a, b) => Bun.semver.order(b.replace(/^v/, ''), a.replace(/^v/, '')))[0]
  return newest ?? defaultBranch
}

async function defaultRef(url: string): Promise<string | null> {
  try {
    return pickRef(await gitTimed(configDir(), GIT_TIMEOUT, ['ls-remote', '--symref', url, 'HEAD', 'refs/tags/*']))
  } catch {
    return null
  }
}

export async function addFromLink(installer: Installer, url: string, ref?: string): Promise<LinkResult> {
  if (!isAllowedRepoUrl(url)) return { ok: false, status: 400, error: 'The link must be https://, git@host:path or file://' }
  const chosen = ref !== undefined && ref !== '' ? ref : await defaultRef(url)
  if (chosen === null) return { ok: false, status: 400, error: "Couldn't reach this repo" }
  const preview = await installer.preview({ repo: url, ref: chosen })
  if (preview.ok) return { ok: true, kind: 'plugin', ref: chosen, preview }
  if (preview.step !== 'manifest' || preview.error !== 'mc-plugin.json is missing') return preview
  const market = await addMarketplace(url)
  if (market.ok) return { ok: true, kind: 'marketplace' }
  return { ok: false, status: 400, error: market.error.startsWith('This repo has no marketplace.json') ? NOT_A_PLUGIN_OR_MARKETPLACE : market.error }
}
