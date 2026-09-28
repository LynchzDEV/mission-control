import type { JobRecord } from './jobs'
import { type Clock, createQuotaCache, type ExternalSession, fetchExternalSessions, type QuotaCache } from './quota'
import type { PastTerminal } from './terminal-log'
import type { TerminalRecord } from './terminals'
import type { UserSession } from './transcripts'

export type HistoryAgent = { id: string; label: string; status: string; chatId: string; startedAt: number; landedAt: number | null; stoppedAt: number | null; reviewOf: string | null }

export type HistoryItem =
  | { kind: 'chat'; id: string; title: string; updatedAt: number; project: string | null; running: boolean; agents: HistoryAgent[] }
  | { kind: 'terminal'; id: string; title: string; updatedAt: number; cwd: string; engine: string; sessionId: string | null; live: boolean }
  | { kind: 'claude-history'; id: string; title: string; updatedAt: number; cwd: string; bytes: number }

export type HistoryInput = {
  jobs: readonly JobRecord[]
  terminals: readonly TerminalRecord[]
  ended: readonly PastTerminal[]
  sessions: readonly UserSession[]
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
      agents: agents.map(agent => ({ id: agent.id, label: agent.label, status: agent.status, chatId: root.id, startedAt: agent.startedAt, landedAt: agent.landedAt ?? null, stoppedAt: agent.stoppedAt ?? null, reviewOf: agent.reviewOf ?? null })),
    }
  })
}

function terminalItem(terminal: TerminalRecord): HistoryItem {
  return { kind: 'terminal', id: terminal.id, title: terminal.title, updatedAt: terminal.createdAt, cwd: terminal.cwd, engine: terminal.engine, sessionId: terminal.sessionId, live: true }
}

function endedTerminalItem(terminal: PastTerminal): HistoryItem {
  return { kind: 'terminal', id: terminal.id, title: terminal.title, updatedAt: terminal.endedAt ?? terminal.createdAt, cwd: terminal.cwd, engine: terminal.engine, sessionId: terminal.sessionId, live: false }
}

function sessionItems(input: HistoryInput): HistoryItem[] {
  const owned = new Set([...input.jobs, ...input.terminals, ...input.ended].map(owner => owner.sessionId).filter((id): id is string => id !== null))
  return input.sessions.filter(session => !owned.has(session.id)).map(session => ({ kind: 'claude-history', id: session.id, title: session.title, updatedAt: session.updatedAt, cwd: session.cwd, bytes: session.bytes }))
}

export function buildHistory(input: HistoryInput): HistoryItem[] {
  return [
    ...chatItems(input.jobs),
    ...input.terminals.map(terminalItem),
    ...input.ended.map(endedTerminalItem),
    ...sessionItems(input),
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
