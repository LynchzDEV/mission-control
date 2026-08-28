import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const VENDOR_OUT = join(ROOT, 'public', 'vendor')

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
]

export type PostinstallResult = {
  copied: string[]
  skipped: string[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

export async function runPostinstall(): Promise<PostinstallResult> {
  const copied: string[] = []
  const skipped: string[] = []

  try {
    await mkdir(VENDOR_OUT, { recursive: true })
  } catch (error) {
    skipped.push(`public/vendor — could not create directory (${describe(error)})`)
    return { copied, skipped }
  }

  for (const asset of ASSETS) {
    try {
      const source = await firstExistingFile(asset.sources.map((path) => join(ROOT, path)))
      if (source === null) {
        skipped.push(`${asset.label} — no source found (looked in ${asset.sources.join(', ')})`)
        continue
      }
      await copyFile(source, join(VENDOR_OUT, asset.dest))
      copied.push(`${asset.dest} <- ${source.slice(ROOT.length + 1)}`)
    } catch (error) {
      skipped.push(`${asset.label} — copy failed (${describe(error)})`)
    }
  }

  return { copied, skipped }
}

if (import.meta.main) {
  const result = await runPostinstall().catch((error) => ({
    copied: [],
    skipped: [`postinstall aborted (${describe(error)})`],
  }))

  for (const entry of result.copied) console.log(`postinstall: copied ${entry}`)
  for (const entry of result.skipped) console.log(`postinstall: skipped ${entry}`)
  console.log(`postinstall: ${result.copied.length} copied, ${result.skipped.length} skipped`)
  process.exit(0)
}
