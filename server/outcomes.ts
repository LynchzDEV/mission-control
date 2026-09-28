import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { logSecrets, redactAll } from './log-redaction'
import { emptyParseState, parseClaudeOutcomes, parseCodexExecOutcomes, parseCodexRolloutOutcomes, type Actor, type OutcomeDraft, type ParseContext, type ParseResult, type ParseState } from './outcome-sources'
import { configDir } from './secrets'

export type Outcome = OutcomeDraft & { seq: number }
export type OutcomeParser = 'claude' | 'codex-rollout' | 'codex-exec'
export type FileSource = { id: string; parser: OutcomeParser; path: string; actor: Actor; final?: boolean; subagents?: boolean }
export type SessionSources = { files: FileSource[]; records: OutcomeDraft[] }
export type SourceResolver = (key: string) => Promise<SessionSources | null>
export type OutcomePage = { items: Outcome[]; totals: { passed: number; failed: number }; last: number }
export type OutcomeLedger = {
  read(key: string, after: number, limit: number): Promise<OutcomePage | null>
  prune(maxAgeMs: number): Promise<number>
}
export type LedgerDeps = {
  resolve: SourceResolver
  base?: string
  secrets?: () => Promise<Array<string | null>>
  now?: () => number
  throttleMs?: number
  readBytes?: number
}

type Cursor = { offset: number; state: ParseState; closed?: boolean }
type Session = {
  file: string
  stateFile: string
  recent: Outcome[]
  keys: Set<string>
  last: number
  passed: number
  failed: number
  cursors: Record<string, Cursor>
  syncing: Promise<void> | null
  syncedAt: number
  known: boolean
  writeFailed: boolean
}

export const RECENT_OUTCOMES = 500
export const SYNC_THROTTLE_MS = 2_000
export const READ_BYTES_PER_SYNC = 4 * 1024 * 1024
const NEWLINE = 10
const PARSERS: Record<OutcomeParser, (text: string, state: ParseState, context: ParseContext) => ParseResult> = {
  'claude': parseClaudeOutcomes,
  'codex-rollout': parseCodexRolloutOutcomes,
  'codex-exec': parseCodexExecOutcomes,
}

export function outcomesDir(base: string = configDir()): string {
  return join(base, 'outcomes')
}

export function sessionFileStem(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_')
}

async function readNewLines(path: string, offset: number, maxBytes: number): Promise<{ text: string; next: number; size: number } | null> {
  let handle
  try {
    const { size } = await stat(path)
    const start = size < offset ? 0 : offset
    if (size === start) return { text: '', next: start, size }
    const length = Math.min(size - start, maxBytes)
    const buffer = Buffer.alloc(length)
    handle = await open(path, 'r')
    await handle.read(buffer, 0, length, start)
    const end = buffer.lastIndexOf(NEWLINE)
    if (end < 0) return { text: '', next: length === maxBytes ? start + length : start, size }
    return { text: buffer.subarray(0, end + 1).toString('utf8'), next: start + end + 1, size }
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

async function subagentSources(main: FileSource, agents: Record<string, string>): Promise<FileSource[]> {
  const dir = join(main.path.replace(/\.jsonl$/, ''), 'subagents')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names.filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl')).sort().map((name) => {
    const agentId = name.slice('agent-'.length, -'.jsonl'.length)
    const label = agents[agentId] ? `Sub-agent · ${agents[agentId]}` : 'Sub-agent'
    return { id: `${main.id}/agent-${agentId}`, parser: 'claude', path: join(dir, name), actor: { by: 'spawned', label, engine: 'claude' } }
  })
}

function parseJsonl<T>(text: string): T[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return []
    try {
      return [JSON.parse(line) as T]
    } catch {
      return []
    }
  })
}

export function createOutcomeLedger(deps: LedgerDeps): OutcomeLedger {
  const dir = deps.base ?? outcomesDir()
  const now = deps.now ?? Date.now
  const throttleMs = deps.throttleMs ?? SYNC_THROTTLE_MS
  const readBytes = deps.readBytes ?? READ_BYTES_PER_SYNC
  const secrets = deps.secrets ?? logSecrets
  const sessions = new Map<string, Session>()

  async function load(key: string): Promise<Session> {
    const cached = sessions.get(key)
    if (cached) return cached
    const stem = sessionFileStem(key)
    const session: Session = { file: join(dir, `${stem}.jsonl`), stateFile: join(dir, `${stem}.state.json`), recent: [], keys: new Set(), last: 0, passed: 0, failed: 0, cursors: {}, syncing: null, syncedAt: 0, known: false, writeFailed: false }
    const stored = parseJsonl<Outcome>(await readFile(session.file, 'utf8').catch(() => ''))
    for (const item of stored) {
      session.keys.add(item.key)
      session.last = Math.max(session.last, item.seq)
      if (item.ok) session.passed += 1
      else session.failed += 1
    }
    session.recent = stored.slice(-RECENT_OUTCOMES)
    try {
      session.cursors = (JSON.parse(await readFile(session.stateFile, 'utf8')) as { cursors: Record<string, Cursor> }).cursors ?? {}
    } catch {
      session.cursors = {}
    }
    sessions.set(key, session)
    return session
  }

  async function readFileSource(session: Session, source: FileSource, drafts: OutcomeDraft[]): Promise<ParseState | null> {
    const cursor = session.cursors[source.id] ?? { offset: 0, state: emptyParseState() }
    if (cursor.closed) return cursor.state
    const chunk = await readNewLines(source.path, cursor.offset, readBytes)
    if (chunk === null) return null
    const parsed = chunk.text === '' ? { outcomes: [], state: cursor.state } : PARSERS[source.parser](chunk.text, cursor.state, { source: source.id, actor: source.actor, now: now() })
    drafts.push(...parsed.outcomes)
    session.cursors[source.id] = { offset: chunk.next, state: parsed.state, ...(source.final && chunk.next === chunk.size ? { closed: true } : {}) }
    return parsed.state
  }

  async function persist(session: Session, added: Outcome[]): Promise<void> {
    try {
      await mkdir(dir, { recursive: true })
      if (added.length > 0) await appendFile(session.file, added.map((item) => `${JSON.stringify(item)}\n`).join(''))
      const temporary = `${session.stateFile}.tmp`
      await writeFile(temporary, JSON.stringify({ cursors: session.cursors }))
      await rename(temporary, session.stateFile)
      session.writeFailed = false
    } catch (error) {
      if (!session.writeFailed) console.error(`outcomes: could not save ${basename(session.file)}`, error)
      session.writeFailed = true
    }
  }

  async function syncNow(session: Session, sources: SessionSources): Promise<void> {
    const drafts: OutcomeDraft[] = [...sources.records]
    for (const source of sources.files) {
      const state = await readFileSource(session, source, drafts)
      if (source.subagents && state) for (const agent of await subagentSources(source, state.agents)) await readFileSource(session, agent, drafts)
    }
    const seen = new Set(session.keys)
    const fresh: OutcomeDraft[] = []
    for (const item of drafts) {
      if (seen.has(item.key)) continue
      seen.add(item.key)
      fresh.push(item)
    }
    const known = await secrets()
    const added = fresh.sort((a, b) => a.at - b.at).map((item): Outcome => {
      session.last += 1
      return { ...item, target: redactAll(item.target, known), detail: redactAll(item.detail, known), seq: session.last }
    })
    for (const item of added) {
      session.keys.add(item.key)
      if (item.ok) session.passed += 1
      else session.failed += 1
    }
    session.recent = [...session.recent, ...added].slice(-RECENT_OUTCOMES)
    await persist(session, added)
  }

  async function resolveAndSync(key: string, session: Session): Promise<void> {
    let sources: SessionSources | null
    try {
      sources = await deps.resolve(key)
    } catch (error) {
      console.error(`outcomes: could not resolve ${key}`, error)
      return
    }
    session.known = sources !== null
    if (sources) await syncNow(session, sources)
  }

  async function sync(key: string, session: Session): Promise<boolean> {
    if (session.syncing === null && (session.syncedAt === 0 || now() - session.syncedAt >= throttleMs)) {
      session.syncing = resolveAndSync(key, session).finally(() => { session.syncing = null; session.syncedAt = now() })
    }
    await session.syncing
    return session.known
  }

  async function olderThanRecent(session: Session, after: number, limit: number): Promise<Outcome[]> {
    const stored = parseJsonl<Outcome>(await readFile(session.file, 'utf8').catch(() => ''))
    return stored.filter((item) => item.seq > after).slice(0, limit)
  }

  return {
    async read(key, after, limit) {
      const session = await load(key)
      const known = await sync(key, session)
      if (!known && session.last === 0) return null
      const first = session.recent[0]?.seq ?? 1
      const items = after <= 0 ? session.recent.slice(-limit) : after >= first - 1 ? session.recent.filter((item) => item.seq > after).slice(0, limit) : await olderThanRecent(session, after, limit)
      return { items, totals: { passed: session.passed, failed: session.failed }, last: session.last }
    },
    async prune(maxAgeMs) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return 0
      }
      let removed = 0
      for (const name of names.filter((item) => item.endsWith('.jsonl'))) {
        const path = join(dir, name)
        const info = await stat(path).catch(() => null)
        if (info === null || now() - info.mtimeMs < maxAgeMs) continue
        const stem = name.slice(0, -'.jsonl'.length)
        await rm(path, { force: true })
        await rm(join(dir, `${stem}.state.json`), { force: true })
        for (const [key, session] of sessions) if (session.file === path) sessions.delete(key)
        removed += 1
      }
      return removed
    },
  }
}
