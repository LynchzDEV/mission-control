import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { writePrivate } from './queue-files'
import { fileExists } from './queue-worktree'

export type RestoredAnswers = { kept: string[]; dropped: string[] }

const backupPath = (folder: string, path: string): string => join(folder, basename(path))

async function readBackup(folder: string, path: string): Promise<Buffer | null> {
  try {
    return await readFile(backupPath(folder, path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function backUpAnswers(folder: string, path: string, markdown: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  await writePrivate(backupPath(folder, path), Buffer.from(markdown))
}

export async function restoreAnswers(folder: string, paths: readonly string[]): Promise<RestoredAnswers> {
  const kept: string[] = []
  const dropped: string[] = []
  for (const path of paths) {
    if (await fileExists(path)) { kept.push(path); continue }
    const bytes = await readBackup(folder, path)
    if (bytes === null) { dropped.push(path); continue }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writePrivate(path, bytes)
    kept.push(path)
  }
  return { kept, dropped }
}

export const dropAnswerBackups = (folder: string): Promise<void> => rm(folder, { recursive: true, force: true })
