import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { git, isWorktreeOf, prepareWorktree, worktreeBranch } from './job-worktrees'
import { SESSION_CONTEXT_DIR } from './plugins/context-files'
import { writePrivate } from './queue-files'

export const MAX_QUEUE_REPOS = 8
const REPOS_RECORD = 'repos.json'
const MAX_RECORD_BYTES = 8192
const BAR_WIDTH = 40

export const isPlainRepoName = (name: string): boolean =>
  name.length > 0 && name.length <= 255 && !name.startsWith('.') && !/[/\\\0]/.test(name) && !name.includes('..')

export function isRepoList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUEUE_REPOS) return false
  return value.every(name => typeof name === 'string' && isPlainRepoName(name)) && new Set(value).size === value.length
}

const recordPath = (workspace: string): string => join(workspace, SESSION_CONTEXT_DIR, REPOS_RECORD)

async function writeReposRecord(workspace: string, repos: readonly string[]): Promise<void> {
  const folder = join(workspace, SESSION_CONTEXT_DIR)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if (!(await lstat(folder)).isDirectory()) throw new Error(`not a private folder: ${folder}`)
  await writePrivate(recordPath(workspace), Buffer.from(JSON.stringify({ repos })))
}

const hasGitEntry = (path: string): Promise<boolean> => lstat(join(path, '.git')).then(() => true, () => false)

export async function workspaceRepos(dir: string): Promise<string[] | null> {
  try {
    if (!(await lstat(join(dir, SESSION_CONTEXT_DIR))).isDirectory()) return null
    const record = await lstat(recordPath(dir))
    if (!record.isFile() || record.size > MAX_RECORD_BYTES) return null
    const { repos } = JSON.parse(await readFile(recordPath(dir), 'utf8')) as { repos?: unknown }
    if (!isRepoList(repos)) return null
    return (await Promise.all(repos.map(name => hasGitEntry(join(dir, name))))).every(Boolean) ? repos : null
  } catch {
    return null
  }
}

export async function prepareRepoWorkspace(folder: string, repos: readonly string[], label: string): Promise<{ worktree: string }> {
  if (!isRepoList(repos)) throw new Error('Not a valid list of repos')
  const workspace = join(folder, '.worktree', worktreeBranch(label))
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  for (const name of repos) {
    const repo = join(folder, name)
    const dir = join(workspace, name)
    if (!(await isWorktreeOf(repo, dir))) await prepareWorktree(repo, label, dir)
  }
  await writeReposRecord(workspace, repos)
  return { worktree: workspace }
}

type FileChange = { path: string; added: number; deleted: number; kind: 'text' | 'binary' | 'new' }

function parseNumstat(output: string): FileChange[] {
  return output.split('\0').filter(entry => entry !== '').map(entry => {
    const [added = '', deleted = '', ...rest] = entry.split('\t')
    const path = rest.join('\t')
    return added === '-' ? { path, added: 0, deleted: 0, kind: 'binary' as const } : { path, added: Number(added), deleted: Number(deleted), kind: 'text' as const }
  })
}

async function repoChanges(dir: string): Promise<FileChange[]> {
  const [numstat, untracked] = await Promise.all([
    git(dir, '-c', 'core.quotepath=false', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', 'HEAD'),
    git(dir, 'ls-files', '--others', '--exclude-standard', '-z'),
  ])
  const added = untracked.split('\0').filter(path => path !== '').map(path => ({ path, added: 0, deleted: 0, kind: 'new' as const }))
  return [...parseNumstat(numstat), ...added]
}

function bar(added: number, deleted: number): string {
  const total = added + deleted
  const scale = total > BAR_WIDTH ? BAR_WIDTH / total : 1
  return '+'.repeat(Math.round(added * scale)) + '-'.repeat(Math.round(deleted * scale))
}

function statLine(change: FileChange): string {
  if (change.kind === 'new') return ` ${change.path} | new`
  if (change.kind === 'binary') return ` ${change.path} | Bin`
  return ` ${change.path} | ${change.added + change.deleted} ${bar(change.added, change.deleted)}`
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

function summaryLine(changes: readonly FileChange[]): string {
  const insertions = changes.reduce((sum, change) => sum + change.added, 0)
  const deletions = changes.reduce((sum, change) => sum + change.deleted, 0)
  return [` ${plural(changes.length, 'file')} changed`, ...(insertions > 0 ? [`${plural(insertions, 'insertion')}(+)`] : []), ...(deletions > 0 ? [`${plural(deletions, 'deletion')}(-)`] : [])].join(', ')
}

export async function workspaceChanges(workspace: string, repos: readonly string[]): Promise<FileChange[]> {
  const perRepo = await Promise.all(repos.map(async name => (await repoChanges(join(workspace, name))).map(change => ({ ...change, path: `${name}/${change.path}` }))))
  return perRepo.flat()
}

export async function workspaceDiffStat(workspace: string, repos: readonly string[]): Promise<string | null> {
  const changes = await workspaceChanges(workspace, repos)
  return changes.length === 0 ? null : [...changes.map(statLine), summaryLine(changes)].join('\n')
}
