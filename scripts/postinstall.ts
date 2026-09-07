import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { type SkillInstallResult, installSkills } from '../server/skill-install'
import { syncEngineAssets } from '../server/engine-assets'

const ROOT = resolve(import.meta.dir, '..')
const PUBLIC_OUT = join(ROOT, 'public')
const VENDOR_OUT = join(PUBLIC_OUT, 'vendor')

type VendorAsset = {
  label: string
  sources: string[]
  dest: string
}

const ASSETS: VendorAsset[] = [
  {
    label: 'xterm.js',
    sources: ['node_modules/@xterm/xterm/lib/xterm.js', 'node_modules/xterm/lib/xterm.js'],
    dest: 'xterm.js',
  },
  {
    label: 'xterm.css',
    sources: ['node_modules/@xterm/xterm/css/xterm.css', 'node_modules/xterm/css/xterm.css'],
    dest: 'xterm.css',
  },
  {
    label: 'xterm fit addon',
    sources: [
      'node_modules/@xterm/addon-fit/lib/addon-fit.js',
      'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js',
    ],
    dest: 'addon-fit.js',
  },
  {
    label: 'xterm web-links addon',
    sources: ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js'],
    dest: 'addon-web-links.js',
  },
  {
    label: 'xterm search addon',
    sources: ['node_modules/@xterm/addon-search/lib/addon-search.js'],
    dest: 'addon-search.js',
  },
  {
    label: 'textmode.js',
    sources: ['design/vendor/textmode.umd.js', 'node_modules/textmode.js/dist/textmode.umd.js'],
    dest: 'textmode.umd.js',
  },
  {
    label: 'textmode.js filters',
    sources: [
      'design/vendor/textmode.filters.umd.js',
      'node_modules/textmode.js/dist/textmode.filters.umd.js',
    ],
    dest: 'textmode.filters.umd.js',
  },
  {
    label: 'anime.js',
    sources: [
      'node_modules/animejs/dist/bundles/anime.umd.min.js',
      'node_modules/animejs/lib/anime.iife.min.js',
    ],
    dest: 'anime.umd.min.js',
  },
]

const PUBLIC_ASSETS: VendorAsset[] = [
  {
    label: 'theme tokens',
    sources: ['design/theme-tokens.css'],
    dest: 'theme-tokens.css',
  },
]

export type PostinstallResult = {
  copied: string[]
  skipped: string[]
  linked: string[]
  movedAside: string[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mergeSkillInstall(into: PostinstallResult, skills: SkillInstallResult): void {
  into.linked.push(...skills.linked)
  into.movedAside.push(...skills.movedAside)
  into.skipped.push(...skills.skipped)
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      continue
    }
  }
  return null
}

async function copyGroup(
  assets: VendorAsset[],
  outDir: string,
  result: PostinstallResult,
): Promise<void> {
  try {
    await mkdir(outDir, { recursive: true })
  } catch (error) {
    result.skipped.push(
      `${outDir.slice(ROOT.length + 1)} — could not create directory (${describe(error)})`,
    )
    return
  }

  for (const asset of assets) {
    try {
      const source = await firstExistingFile(asset.sources.map((path) => join(ROOT, path)))
      if (source === null) {
        result.skipped.push(
          `${asset.label} — no source found (looked in ${asset.sources.join(', ')})`,
        )
        continue
      }
      const dest = join(outDir, asset.dest)
      await copyFile(source, dest)
      result.copied.push(`${dest.slice(ROOT.length + 1)} <- ${source.slice(ROOT.length + 1)}`)
    } catch (error) {
      result.skipped.push(`${asset.label} — copy failed (${describe(error)})`)
    }
  }
}

export async function runPostinstall(): Promise<PostinstallResult> {
  const result: PostinstallResult = { copied: [], skipped: [], linked: [], movedAside: [] }
  await copyGroup(ASSETS, VENDOR_OUT, result)
  await copyGroup(PUBLIC_ASSETS, PUBLIC_OUT, result)
  mergeSkillInstall(result, await installSkills())
  const assets = await syncEngineAssets()
  console.log(`postinstall: codex assets — linked ${assets.linked.length}, written ${assets.written.length}, moved aside ${assets.movedAside.length}, skipped ${assets.skipped.length}`)
  return result
}

if (import.meta.main) {
  const result = await runPostinstall().catch((error) => ({
    copied: [],
    skipped: [`postinstall aborted (${describe(error)})`],
    linked: [],
    movedAside: [],
  }))

  for (const entry of result.copied) console.log(`postinstall: copied ${entry}`)
  for (const entry of result.linked) console.log(`postinstall: linked skill ${basename(entry)} -> ${entry}`)
  for (const entry of result.movedAside) console.log(`postinstall: moved aside ${entry}`)
  for (const entry of result.skipped) console.log(`postinstall: skipped ${entry}`)
  console.log(
    `postinstall: ${result.copied.length} copied, ${result.linked.length} linked, ` +
      `${result.movedAside.length} moved aside, ${result.skipped.length} skipped`,
  )
  process.exit(0)
}
