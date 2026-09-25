export type ThreadMessage =
  | { role: 'user'; kind: 'prompt'; jobId: string; ts: number; text: string }
  | { role: 'assistant'; kind: 'thinking' | 'text'; jobId: string; text: string }
  | { role: 'assistant'; kind: 'tool'; jobId: string; title: string; detail: string; input: string; result: string; resultIsError: boolean }
  | { role: 'result'; kind: 'result'; jobId: string; text: string; isError: boolean }

export type TurnJob = { id: string; status: string; startedAt: number; endedAt: number | null; source?: 'user' | 'agent' }
export type AgentJob = { id: string; engine: string; model: string | null; label: string; reason?: string; status: string; startedAt: number; endedAt: number | null; chatTurn?: string; reviewOf: string | null; reviewedAt: number | null; currentActivity?: string | null; diffStat: string | null }
export type Turn = { id: string; source: 'user' | 'agent'; prompt: string; text: string; tools: number; edits: string[]; started: number; ended: number | null; running: boolean }
export type TeamState = 'running' | 'reviewing' | 'done' | 'landed' | 'needs-you'
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

function stateOf(job: AgentJob, all: readonly AgentJob[]): TeamState {
  if (job.status === 'running') return 'running'
  if (job.status === 'failed') return 'needs-you'
  if (job.reviewedAt !== null) return 'landed'
  if (all.some(other => other.reviewOf === job.id && other.status === 'running')) return 'reviewing'
  return 'done'
}

export function teamRows(jobs: readonly AgentJob[], turnId: string): TeamRow[] {
  return jobs.filter(job => job.chatTurn === turnId).map(job => ({ id: job.id, engine: job.engine, model: job.model, label: job.label, reason: job.reason ?? '', state: stateOf(job, jobs), activity: job.status === 'running' ? job.currentActivity ?? '' : '', started: job.startedAt, ended: job.endedAt }))
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
