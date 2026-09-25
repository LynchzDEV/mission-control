export type ThreadMessage =
  | { role: 'user'; kind: 'prompt'; jobId: string; ts: number; text: string }
  | { role: 'assistant'; kind: 'thinking' | 'text'; jobId: string; text: string }
  | { role: 'assistant'; kind: 'tool'; jobId: string; title: string; detail: string; input: string; result: string; resultIsError: boolean }
  | { role: 'result'; kind: 'result'; jobId: string; text: string; isError: boolean }

export type TurnJob = { id: string; status: string; startedAt: number; endedAt: number | null; source?: 'user' | 'agent' }
export type AgentJob = { id: string; engine: string; model: string | null; label: string; reason?: string; status: string; startedAt: number; endedAt: number | null; chatTurn?: string; chatId?: string; reviewOf: string | null; reviewedAt: number | null; landedAt?: number | null; stoppedAt?: number | null; currentActivity?: string | null; diffStat: string | null }
export type Turn = { id: string; source: 'user' | 'agent'; prompt: string; text: string; tools: number; edits: string[]; started: number; ended: number | null; running: boolean }
export type TeamState = 'running' | 'reviewing' | 'done' | 'landed' | 'needs-you' | 'retried' | 'stopped'
export type TeamRow = { id: string; engine: string; model: string | null; label: string; reason: string; state: TeamState; activity: string; started: number; ended: number | null }

const TITLE_MAX = 60
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export function turnsFrom(thread: readonly ThreadMessage[], jobs: readonly TurnJob[]): Turn[] {
  const turns: Turn[] = []
  for (const message of thread) {
    if (message.kind === 'prompt') {
      const job = jobs.find(item => item.id === message.jobId)
      turns.push({ id: message.jobId, source: job?.source === 'agent' ? 'agent' : 'user', prompt: message.text, text: '', tools: 0, edits: [], started: job?.startedAt ?? message.ts, ended: job?.endedAt ?? null, running: job?.status === 'running' })
      continue
    }
    const turn = turns[turns.length - 1]
    if (!turn || turn.id !== message.jobId) continue
    if (message.kind === 'text') turn.text = turn.text ? `${turn.text}\n\n${message.text}` : message.text
    else if (message.kind === 'tool') { turn.tools += 1; if (EDIT_TOOLS.includes(message.title) && message.detail) turn.edits.push(message.detail) }
  }
  return turns
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function workedLine(turn: Turn, now: number): string {
  if (turn.running) return `Working · ${duration(now - turn.started)}`
  if (turn.tools === 0) return 'Answered'
  return `Worked ${duration((turn.ended ?? now) - turn.started)} · used ${turn.tools} tool${turn.tools === 1 ? '' : 's'}`
}

function superseded(job: AgentJob, all: readonly AgentJob[]): boolean {
  return all.some(other => other.id !== job.id && other.chatId === job.chatId && other.label === job.label && other.startedAt > job.startedAt)
}

function stateOf(job: AgentJob, all: readonly AgentJob[]): TeamState {
  if (job.status === 'running') return 'running'
  if (job.stoppedAt) return 'stopped'
  if (job.status === 'failed') return superseded(job, all) ? 'retried' : 'needs-you'
  if (job.landedAt) return 'landed'
  if (all.some(other => other.reviewOf === job.id && other.status === 'running')) return 'reviewing'
  return 'done'
}

export function teamRows(jobs: readonly AgentJob[], turnId: string): TeamRow[] {
  return jobs.filter(job => job.chatTurn === turnId).map(job => ({ id: job.id, engine: job.engine, model: job.model, label: job.label, reason: job.reason ?? '', state: stateOf(job, jobs), activity: job.status === 'running' ? job.currentActivity ?? '' : '', started: job.startedAt, ended: job.endedAt }))
}

export type ChatSignal = { state: 'running' | 'needs-you' | 'landed' | null; count: number }

export function chatSignal(turnsRunning: boolean, agents: readonly AgentJob[]): ChatSignal {
  const rows = agents.map(job => stateOf(job, agents))
  const running = rows.filter(state => state === 'running').length
  if (turnsRunning || running > 0 || rows.includes('reviewing')) return { state: 'running', count: running }
  const needsYou = rows.filter(state => state === 'needs-you').length
  if (needsYou > 0) return { state: 'needs-you', count: needsYou }
  const landed = rows.filter(state => state === 'landed').length
  if (landed > 0) return { state: 'landed', count: landed }
  return { state: null, count: 0 }
}

export function titleFrom(prompt: string): string {
  const line = prompt.split('\n').map(part => part.trim()).find(Boolean) ?? ''
  return line === '' ? 'New chat' : line.slice(0, TITLE_MAX)
}

export function historyDay(at: number, now: number): string {
  const day = (value: number): number => Math.floor((value - new Date(value).getTimezoneOffset() * 60_000) / 86_400_000)
  const days = day(now) - day(at)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export type HistoryItem =
  | { kind: 'chat'; id: string; title: string; updatedAt: number; project: string | null; running: boolean; agents: AgentJob[] }
  | { kind: 'terminal'; id: string; title: string; updatedAt: number; cwd: string; engine: string; sessionId: string | null }
  | { kind: 'claude-history'; id: string; title: string; updatedAt: number; cwd: string; bytes: number }
  | { kind: 'outside'; id: string; title: string; updatedAt: number; engine: string; pid: number; cwdHint: string | null; etime: string }

const folderName = (path: string | null): string => path ? path.replace(/\/+$/, '').split('/').pop() || path : ''

export function historyLabel(item: HistoryItem): string {
  if (item.kind === 'chat') return `Chat${item.project ? ` · ${folderName(item.project)}` : ''}`
  if (item.kind === 'terminal') return `Terminal · live · ${folderName(item.cwd)} · ${item.engine}`
  if (item.kind === 'claude-history') return `Claude history · ${folderName(item.cwd)} · ${Math.max(1, Math.round(item.bytes / 1024))} KB`
  return `Outside session · ${item.engine} · ${item.cwdHint ? folderName(item.cwdHint) : 'unknown folder'} · running ${item.etime}`
}

export function historyAction(item: HistoryItem): string | null {
  if (item.kind === 'chat') return 'Continue chat'
  if (item.kind === 'terminal') return 'Open terminal'
  if (item.kind === 'claude-history') return 'Resume in a terminal'
  return item.cwdHint ? 'Open a terminal here' : null
}
