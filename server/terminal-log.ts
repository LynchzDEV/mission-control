import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { configPath } from './secrets'

export type PastTerminal = { id: string; engine: string; cwd: string; title: string; sessionId: string | null; createdAt: number; endedAt: number | null }
export type TerminalLog = { record(entry: PastTerminal): void; list(): PastTerminal[] }

export function terminalLogPath(): string {
  return configPath('terminals.jsonl')
}

function isPastTerminal(value: unknown): value is PastTerminal {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.engine === 'string' && typeof entry.cwd === 'string' && typeof entry.title === 'string' && typeof entry.createdAt === 'number'
}

function readEntries(path: string): Map<string, PastTerminal> {
  const entries = new Map<string, PastTerminal>()
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return entries
  }
  for (const line of raw.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (isPastTerminal(parsed)) entries.set(parsed.id, { ...parsed, sessionId: parsed.sessionId ?? null, endedAt: parsed.endedAt ?? null })
    } catch {
      continue
    }
  }
  return entries
}

export function createTerminalLog(path: string = terminalLogPath()): TerminalLog {
  const entries = readEntries(path)
  let warned = false
  return {
    record(entry) {
      entries.set(entry.id, entry)
      try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, `${JSON.stringify(entry)}\n`)
      } catch (error) {
        if (!warned) console.error('terminals: could not save terminal history', error)
        warned = true
      }
    },
    list: () => [...entries.values()],
  }
}
