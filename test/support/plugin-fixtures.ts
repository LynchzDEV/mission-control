import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function fileUrl(path: string): string {
  return `file://${path}`
}

async function fixtureGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  if (await proc.exited !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

export async function fixtureSha(repo: string): Promise<string> {
  const proc = Bun.spawn(['git', '-C', repo, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  if (await proc.exited !== 0) throw new Error('git rev-parse failed')
  return out.trim()
}

export type FixtureOptions = {
  files?: Record<string, string>
  tag?: string
  message?: string
}

async function writeFiles(repo: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, '..'), { recursive: true })
    await writeFile(join(repo, name), content)
  }
}

export async function commitFixture(repo: string, files: Record<string, string>, options: FixtureOptions = {}): Promise<void> {
  await writeFiles(repo, files)
  await fixtureGit(['add', '.'], repo)
  await fixtureGit(['commit', '-q', '-m', options.message ?? 'fixture change'], repo)
  if (options.tag !== undefined) await fixtureGit(['tag', options.tag], repo)
}

export async function linkFixture(repo: string, name: string, target: string, options: FixtureOptions = {}): Promise<void> {
  await mkdir(join(repo, name, '..'), { recursive: true })
  await symlink(target, join(repo, name))
  await fixtureGit(['add', '-A'], repo)
  await fixtureGit(['commit', '-q', '-m', options.message ?? 'fixture link'], repo)
  if (options.tag !== undefined) await fixtureGit(['tag', options.tag], repo)
}

export async function createPluginRepo(repo: string, manifest: Record<string, unknown>, options: FixtureOptions & { manifestName?: string } = {}): Promise<string> {
  await mkdir(repo, { recursive: true })
  await fixtureGit(['init', '-q', '-b', 'main'], repo)
  await fixtureGit(['config', 'user.email', 'mission-control-test@example.com'], repo)
  await fixtureGit(['config', 'user.name', 'Mission Control Test'], repo)
  await writeFiles(repo, { [options.manifestName ?? 'mc-plugin.json']: `${JSON.stringify(manifest, null, 2)}\n`, ...(options.files ?? {}) })
  await fixtureGit(['add', '.'], repo)
  await fixtureGit(['commit', '-q', '-m', options.message ?? 'fixture'], repo)
  if (options.tag !== undefined) await fixtureGit(['tag', options.tag], repo)
  return repo
}

export const TRIVIAL_SCREEN = 'export default { mount() {} }\n'

export function isolatedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture-plugin',
    name: 'Fixture plugin',
    version: '1.0.0',
    description: 'A fixture plugin for tests.',
    pluginApi: 1,
    runtime: 'isolated',
    screen: 'src/screen.ts',
    permissions: { network: ['api.example.com'], sessions: ['chat'], settings: true },
    settings: [{ key: 'token', label: 'Token', type: 'secret' }],
    ...overrides,
  }
}

export function trustedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return isolatedManifest({ runtime: 'trusted', permissions: { sessions: ['chat'], settings: true }, ...overrides })
}
