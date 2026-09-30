import type { JobRecord } from './jobs'

export type VersionEntry = { index: number; count: number; ids: string[]; leaf: string }

export type BranchPoint = { turnId: string; label: string; mainLeaf: string }

export type TurnTree = {
  turns: JobRecord[]
  byId: Map<string, JobRecord>
  prev: Map<string, string | null>
  children: Map<string, string[]>
  leaves: string[]
  pathToLeaf: (leaf: string) => JobRecord[]
  newestLeafUnder: (turnId: string) => string
  versions: Record<string, VersionEntry>
  branchPoints: BranchPoint[]
}

export function buildTurnTree(rootId: string, allTurns: readonly JobRecord[]): TurnTree {
  const turns = allTurns.filter(turn => (turn.threadRoot === '' ? turn.id : turn.threadRoot) === rootId && turn.deletedAt === undefined).sort((left, right) => left.startedAt - right.startedAt)
  const byId = new Map(turns.map(turn => [turn.id, turn]))
  const prev = new Map<string, string | null>()
  for (const turn of turns) {
    if (typeof turn.prevTurnId === 'string' && byId.has(turn.prevTurnId)) {
      prev.set(turn.id, turn.prevTurnId)
      continue
    }
    if (turn.prevTurnId === null) {
      prev.set(turn.id, null)
      continue
    }
    const older = turns.filter(other => other.startedAt < turn.startedAt)
    prev.set(turn.id, older.length > 0 ? older[older.length - 1]!.id : null)
  }
  const children = new Map<string, string[]>(turns.map(turn => [turn.id, [] as string[]]))
  for (const turn of turns) {
    const parent = prev.get(turn.id) ?? null
    if (parent !== null) children.get(parent)?.push(turn.id)
  }
  const leaves = turns.filter(turn => (children.get(turn.id) ?? []).length === 0).map(turn => turn.id)

  const pathToLeaf = (leaf: string): JobRecord[] => {
    const path: JobRecord[] = []
    let cursor: string | undefined = byId.has(leaf) ? leaf : undefined
    const seen = new Set<string>()
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      const turn = byId.get(cursor)
      if (turn === undefined) break
      path.push(turn)
      cursor = prev.get(cursor) ?? undefined
    }
    return path.reverse()
  }

  const newestLeafUnder = (start: string): string => {
    let best = start
    let bestAt = byId.get(start)?.startedAt ?? 0
    const walk = (id: string): void => {
      const turn = byId.get(id)
      if (turn !== undefined && turn.startedAt >= bestAt && (children.get(id) ?? []).length === 0) {
        best = id
        bestAt = turn.startedAt
      }
      for (const child of children.get(id) ?? []) walk(child)
    }
    walk(start)
    return best
  }

  const versions: Record<string, VersionEntry> = {}
  const groups = new Map<string, string[]>()
  for (const turn of turns) {
    if (typeof turn.versionOf !== 'string' || !byId.has(turn.versionOf)) continue
    const original = turn.versionOf
    const ids = groups.get(original) ?? [original]
    ids.push(turn.id)
    groups.set(original, ids)
  }
  for (const [original, ids] of groups) {
    const ordered = ids.map(id => byId.get(id)!).sort((left, right) => left.startedAt - right.startedAt)
    ordered.forEach((turn, index) => {
      versions[turn.id] = { index: index + 1, count: ordered.length, ids: ordered.map(entry => entry.id), leaf: newestLeafUnder(turn.id) }
    })
  }

  const pathIdsOf = (leaf: string): Set<string> => new Set(pathToLeaf(leaf).map(turn => turn.id))
  const branchPoints: BranchPoint[] = []
  for (const turn of turns) {
    if (typeof turn.branchFrom !== 'string' || turn.branchFrom === '') continue
    const label = (turn.prompt.split('\n').find(line => line.trim() !== '') ?? '').trim().slice(0, 40)
    const offBranch = leaves.filter(leaf => !pathIdsOf(leaf).has(turn.id))
    const newest = offBranch.map(id => byId.get(id)!).sort((left, right) => right.startedAt - left.startedAt)[0]
    branchPoints.push({ turnId: turn.id, label, mainLeaf: newest === undefined ? turn.branchFrom : newest.id })
  }

  return { turns, byId, prev, children, leaves, pathToLeaf, newestLeafUnder, versions, branchPoints }
}

export function newestLeaf(tree: TurnTree): string | null {
  const newest = tree.turns.filter(turn => tree.leaves.includes(turn.id)).sort((left, right) => right.startedAt - left.startedAt)[0]
  return newest === undefined ? null : newest.id
}

export function nearestSessionId(tree: TurnTree, turnId: string): string | null {
  let cursor: string | undefined = turnId
  const seen = new Set<string>()
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const turn = tree.byId.get(cursor)
    if (turn === undefined) return null
    if (turn.sessionId !== null && turn.sessionId !== '') return turn.sessionId
    cursor = tree.prev.get(cursor) ?? undefined
  }
  return null
}

export function isLeaf(tree: TurnTree, turnId: string): boolean {
  return (tree.children.get(turnId) ?? []).length === 0
}

export function forkPointUuid(log: string): string | null {
  const lines = log.split('\n').filter(line => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] as string) as { type?: unknown; uuid?: unknown; parent_tool_use_id?: unknown }
      if ((parsed.type === 'assistant' || parsed.type === 'user') && typeof parsed.uuid === 'string' && parsed.uuid !== '' && parsed.parent_tool_use_id === null) return parsed.uuid
    } catch {
      // a torn line mid-write is skipped
    }
  }
  return null
}
