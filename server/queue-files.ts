import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

import { ContextTooLarge, excludeFromGit, MAX_CONTEXT_BYTES, safeContextName, SESSION_CONTEXT_DIR, stamp, type TaskContext } from './plugins/context-files'
import type { SourceReply } from './queue-source'

const MAX_IMAGE_BYTES = 3_932_160

async function readCapped(handle: FileHandle, candidate: string): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1)
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  if (filled > MAX_IMAGE_BYTES) throw new Error(`image over ${MAX_IMAGE_BYTES} bytes: ${candidate}`)
  return buffer.subarray(0, filled)
}

async function readInsideFile(realBase: string, candidate: string): Promise<Buffer> {
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`not a single-link regular file: ${candidate}`)
    if (opened.size > MAX_IMAGE_BYTES) throw new Error(`image over ${MAX_IMAGE_BYTES} bytes: ${candidate}`)
    const real = await realpath(candidate)
    if (!real.startsWith(realBase + sep)) throw new Error(`outside the plugin folder: ${candidate}`)
    const named = await lstat(real)
    if (!named.isFile() || named.nlink !== 1 || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error(`changed while checking: ${candidate}`)
    return await readCapped(handle, candidate)
  } finally {
    await handle.close()
  }
}

async function clearTarget(to: string): Promise<void> {
  const existing = await lstat(to).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing === null) return
  if (!existing.isFile()) throw new Error(`not a regular file at the copy target: ${to}`)
  await unlink(to)
}

export async function writePrivate(to: string, bytes: Buffer): Promise<void> {
  await clearTarget(to)
  const handle = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}

export async function importImages(root: string, replies: SourceReply[], folder: string): Promise<string[]> {
  const realBase = realpath(root)
  realBase.catch(() => undefined)
  const copied: string[] = []
  await mkdir(folder, { recursive: true, mode: 0o700 })
  for (const reply of replies) {
    for (const [index, image] of reply.images.entries()) {
      const to = join(folder, `${reply.id}-${index}-${basename(image.name)}`.replace(/[^A-Za-z0-9._-]/g, '-'))
      try {
        const base = await realBase
        await writePrivate(to, await readInsideFile(base, resolve(base, image.path)))
        copied.push(to)
      } catch (error) {
        console.error('queue image skipped', error)
      }
    }
  }
  return copied
}

const queueRoot = (worktree: string): string => join(worktree, SESSION_CONTEXT_DIR, 'queue')

export const queueFolder = (worktree: string, source: string): string => join(queueRoot(worktree), source)

async function refuseLinkedFolder(path: string): Promise<void> {
  const found = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (found !== null && !found.isDirectory()) throw new Error(`not a private folder: ${path}`)
}

export async function refuseLinkedQueueFolders(worktree: string, source: string): Promise<void> {
  for (const path of [join(worktree, SESSION_CONTEXT_DIR), queueRoot(worktree), queueFolder(worktree, source)]) await refuseLinkedFolder(path)
}

export async function writeQueueContext(source: string, context: TaskContext, worktree: string, now = new Date()): Promise<string> {
  const bytes = Buffer.byteLength(context.markdown)
  if (bytes > MAX_CONTEXT_BYTES) throw new ContextTooLarge(bytes)
  const folder = queueFolder(worktree, source)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await refuseLinkedQueueFolders(worktree, source)
  for (const path of [queueRoot(worktree), folder]) await chmod(path, 0o700)
  await excludeFromGit(worktree)
  const path = join(folder, `${stamp(now)}-${safeContextName(context.name)}`)
  await writePrivate(path, Buffer.from(context.markdown))
  return path
}
