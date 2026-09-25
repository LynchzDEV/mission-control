import { basename } from 'node:path'

import type { JobRecord } from './jobs'
import { type Clock, createQuotaCache, type ExternalSession, fetchExternalSessions, type QuotaCache } from './quota'
import type { TerminalRecord } from './terminals'
import type { SessionSummary } from './transcripts'

export type HistoryAgent = { id: string; label: string; status: string; chatId: string; startedAt: number; landedAt: number | null; stoppedAt: number | null }

export type HistoryItem =
  | { kind: 'chat'; id: string; title: string; updatedAt: number; project: string | null; running: boolean; agents: HistoryAgent[] }
  | { kind: 'terminal'; id: string; title: string; updatedAt: number; cwd: string; engine: string; sessionId: string | null }
  | { kind: 'claude-history'; id: string; title: string; updatedAt: number; cwd: string; bytes: number }
  | { kind: 'outside'; id: string; title: string; updatedAt: number; engine: 'claude' | 'codex'; pid: number; cwdHint: string | null; etime: string }

export type HistoryInput = {
  jobs: readonly JobRecord[]
  terminals: readonly TerminalRecord[]
  transcripts: Array<{ cwd: string; sessions: SessionSummary[] }>
  outside: ExternalSession[]
  now: number
}

const ETIME_PATTERN = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/

export function etimeMs(etime: string): number {
  const match = ETIME_PATTERN.exec(etime.trim())
  if (match === null) return 0
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
}

export function ownedPids(jobs: readonly JobRecord[], terminals: readonly TerminalRecord[]): Set<number> {
  return new Set([...jobs.map(job => job.pid), ...terminals.map(terminal => terminal.pid)])
}

function chatItems(jobs: readonly JobRecord[]): HistoryItem[] {
  const roots = jobs.filter(job => job.purpose === 'chat' && job.threadRoot === job.id)
  return roots.map(root => {
    const turns = jobs.filter(job => job.purpose === 'chat' && job.threadRoot === root.id)
    const agents = jobs.filter(job => job.chatId === root.id)
    return {
      kind: 'chat',
      id: root.id,
      title: root.label,
      updatedAt: Math.max(...turns.map(turn => turn.startedAt)),
      project: root.project ?? null,
      running: [...turns, ...agents].some(job => job.status === 'running'),
      agents: agents.map(agent => ({ id: agent.id, label: agent.label, status: agent.status, chatId: root.id, startedAt: agent.startedAt, landedAt: agent.landedAt ?? null, stoppedAt: agent.stoppedAt ?? null })),
    }
  })
}

function terminalItem(terminal: TerminalRecord): HistoryItem {
  return { kind: 'terminal', id: terminal.id, title: terminal.title, updatedAt: terminal.createdAt, cwd: terminal.cwd, engine: terminal.engine, sessionId: terminal.sessionId }
}

function transcriptItems(input: HistoryInput): HistoryItem[] {
  const seen = new Set([...input.jobs, ...input.terminals].map(owner => owner.sessionId).filter((id): id is string => id !== null))
  const items: HistoryItem[] = []
  for (const { cwd, sessions } of input.transcripts) {
    for (const session of sessions) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      items.push({ kind: 'claude-history', id: session.id, title: session.title, updatedAt: session.updatedAt, cwd, bytes: session.bytes })
    }
  }
  return items
}

function outsideItem(session: ExternalSession, now: number): HistoryItem {
  const folder = session.cwdHint === null ? 'unknown folder' : basename(session.cwdHint)
  return { kind: 'outside', id: String(session.pid), title: `${session.engine} · ${folder}`, updatedAt: now - etimeMs(session.etime), engine: session.engine, pid: session.pid, cwdHint: session.cwdHint, etime: session.etime }
}

export function buildHistory(input: HistoryInput): HistoryItem[] {
  const owned = ownedPids(input.jobs, input.terminals)
  return [
    ...chatItems(input.jobs),
    ...input.terminals.map(terminalItem),
    ...transcriptItems(input),
    ...input.outside.filter(session => !owned.has(session.pid)).map(session => outsideItem(session, input.now)),
  ].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function createExternalSessionsCache(
  currentOwnedPids: () => ReadonlySet<number>,
  fetch: (owned: ReadonlySet<number>) => Promise<ExternalSession[]> = fetchExternalSessions,
  ttlMs = 60_000,
  clock: Clock = Date.now,
): QuotaCache<ExternalSession[]> {
  return createQuotaCache(() => fetch(currentOwnedPids()), ttlMs, clock)
}
