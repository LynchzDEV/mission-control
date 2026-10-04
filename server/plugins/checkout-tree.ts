import { chmod, lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path'

import { DIR_MODE, FILE_MODE } from '../secrets'

const MAX_LINK_EXPANSIONS = 40

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel)
}

function segmentsOf(target: string): string[] {
  return target.split(sep).filter(part => part !== '' && part !== '.')
}

// The kernel expands symlink segments while walking, so a ".." after a link applies to the link's resolved target.
async function resolveLinkTarget(baseDir: string, target: string): Promise<string | null> {
  let dir = isAbsolute(target) ? parse(target).root : baseDir
  let pending = segmentsOf(isAbsolute(target) ? target.slice(dir.length) : target)
  let expansions = 0
  let index = 0
  while (index < pending.length) {
    const segment = pending[index] as string
    if (segment === '..') {
      dir = dirname(dir)
      index += 1
      continue
    }
    const path = join(dir, segment)
    let node
    try {
      node = await lstat(path)
    } catch {
      return join(dir, ...pending.slice(index))
    }
    if (!node.isSymbolicLink()) {
      dir = path
      index += 1
      continue
    }
    expansions += 1
    if (expansions > MAX_LINK_EXPANSIONS) return null
    let next
    try {
      next = await readlink(path)
    } catch {
      return null
    }
    dir = isAbsolute(next) ? parse(next).root : dir
    pending = [...segmentsOf(isAbsolute(next) ? next.slice(dir.length) : next), ...pending.slice(index + 1)]
    index = 0
  }
  return dir
}

export async function findEscapingLink(root: string): Promise<string | null> {
  const realRoot = await realpath(root).catch(() => root)
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const escaped = await readlink(path)
          .then(target => resolveLinkTarget(dir, target))
          .then(resolved => resolved === null || (!isInside(root, resolved) && !isInside(realRoot, resolved)))
          .catch(() => true)
        if (escaped) return relative(root, path)
        continue
      }
      if (entry.isDirectory()) pending.push(path)
    }
  }
  return null
}

export async function applyPrivateModes(root: string): Promise<void> {
  await chmod(root, DIR_MODE)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) await applyPrivateModes(path)
    else await chmod(path, FILE_MODE)
  }
}
