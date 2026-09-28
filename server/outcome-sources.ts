import { oneLine } from './activity'

export type OutcomeKind = 'command' | 'edit' | 'agent' | 'job' | 'check'
export type Actor = { by: 'main' | 'spawned'; label: string; engine: string }
export type OutcomeDraft = { at: number; ok: boolean; kind: OutcomeKind; tool: string; target: string; result: string; detail: string; actor: Actor; key: string }
export type PendingUse = { tool: string; kind: OutcomeKind; target: string }
export type ParseState = { pending: Record<string, PendingUse>; agents: Record<string, string> }
export type ParseContext = { source: string; actor: Actor; now: number }
export type ParseResult = { outcomes: OutcomeDraft[]; state: ParseState }

export const TARGET_CHARS = 200
export const DETAIL_CHARS = 300
const DETAIL_LINE_CHARS = 160

const CLAUDE_TOOL_KINDS: Record<string, OutcomeKind> = { Bash: 'command', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Agent: 'agent', Task: 'agent' }
const CLAUDE_TARGET_KEYS: Record<OutcomeKind, readonly string[]> = { command: ['command'], edit: ['file_path', 'notebook_path'], agent: ['description'], job: [], check: [] }
const EXIT_CODE_PATTERNS = [/"exit_code"\s*:\s*(-?\d+)/, /Exit code:?\s*(-?\d+)/i, /Process exited with code (-?\d+)/]

type R = Record<string, unknown>
const isRecord = (value: unknown): value is R => value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function emptyParseState(): ParseState {
  return { pending: {}, agents: {} }
}

function jsonLines(text: string): R[] {
  const out: R[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed)) out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

function timestamp(raw: R, fallback: number): number {
  const value = raw.timestamp ?? raw.ts
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (isRecord(block) ? str(block.text) : '')).filter(Boolean).join('\n')
}

export function exitCodeOf(text: string): number | null {
  for (const pattern of EXIT_CODE_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return Number(match[1])
  }
  return null
}

function meaningfulLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !/^(Error:\s*)?Exit code:?\s*-?\d+$/i.test(line))
}

export function outcomeDetail(text: string, ok: boolean): string {
  const lines = meaningfulLines(text)
  const picked = ok ? lines.slice(-1) : lines.slice(0, 2)
  return picked.map((line) => oneLine(line, DETAIL_LINE_CHARS)).join('\n').slice(0, DETAIL_CHARS)
}

export function resultText(kind: OutcomeKind, ok: boolean, exitCode: number | null): string {
  const exit = exitCode === null ? '' : ` · exit ${exitCode}`
  if (kind === 'command' || kind === 'check') return `${ok ? 'Passed' : 'Failed'}${exit}`
  if (kind === 'edit') return ok ? 'Saved' : 'Failed'
  if (kind === 'agent') return ok ? 'Finished' : 'Failed'
  return ok ? 'Done' : `Failed${exit}`
}

function draft(context: ParseContext, id: string, at: number, use: PendingUse, ok: boolean, exitCode: number | null, text: string): OutcomeDraft {
  return { at, ok, kind: use.kind, tool: use.tool, target: use.target, result: resultText(use.kind, ok, exitCode), detail: outcomeDetail(text, ok), actor: context.actor, key: `${context.source}:${id}` }
}

function claudeTarget(kind: OutcomeKind, input: unknown): string {
  if (!isRecord(input)) return ''
  for (const key of CLAUDE_TARGET_KEYS[kind]) if (str(input[key]) !== '') return oneLine(str(input[key]), TARGET_CHARS)
  return ''
}

function claudeToolUses(message: R, pending: Record<string, PendingUse>): void {
  if (!Array.isArray(message.content)) return
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue
    const tool = str(block.name)
    const kind = CLAUDE_TOOL_KINDS[tool]
    if (kind === undefined || str(block.id) === '') continue
    pending[str(block.id)] = { tool, kind, target: claudeTarget(kind, block.input) }
  }
}

function claudeToolResults(raw: R, message: R, state: ParseState, context: ParseContext, out: OutcomeDraft[]): void {
  if (!Array.isArray(message.content)) return
  const launched = isRecord(raw.toolUseResult) ? raw.toolUseResult : null
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    const id = str(block.tool_use_id)
    const use = state.pending[id]
    if (use === undefined) continue
    delete state.pending[id]
    if (use.kind === 'agent' && launched && str(launched.agentId) !== '') state.agents[str(launched.agentId)] = use.target
    if (use.kind === 'agent' && launched?.status === 'async_launched') continue
    const text = blockText(block.content)
    const ok = block.is_error !== true
    out.push(draft(context, id, timestamp(raw, context.now), use, ok, use.kind === 'command' ? exitCodeOf(text) : null, text))
  }
}

export function parseClaudeOutcomes(text: string, previous: ParseState, context: ParseContext): ParseResult {
  const state: ParseState = { pending: { ...previous.pending }, agents: { ...previous.agents } }
  const outcomes: OutcomeDraft[] = []
  for (const raw of jsonLines(text)) {
    const message = isRecord(raw.message) ? raw.message : null
    if (message === null) continue
    if (raw.type === 'assistant') claudeToolUses(message, state.pending)
    else if (raw.type === 'user') claudeToolResults(raw, message, state, context, outcomes)
  }
  return { outcomes, state }
}

function codexCommand(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(str).join(' ')
  return str(raw)
}

function codexCallTarget(argumentsText: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    if (isRecord(parsed)) return oneLine(codexCommand(parsed.cmd) || codexCommand(parsed.command) || argumentsText, TARGET_CHARS)
  } catch {
    // not JSON: fall through to the raw text
  }
  return oneLine(argumentsText, TARGET_CHARS)
}

function patchTarget(input: string): string {
  const files = [...input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim())
  return oneLine(files.join(', ') || 'patch', TARGET_CHARS)
}

function codexOutput(output: string): { text: string; exitCode: number | null } {
  try {
    const parsed: unknown = JSON.parse(output)
    if (isRecord(parsed)) {
      const metadata = isRecord(parsed.metadata) ? parsed.metadata : {}
      const code = typeof metadata.exit_code === 'number' ? metadata.exit_code : typeof parsed.exit_code === 'number' ? parsed.exit_code : null
      const text = str(parsed.output) || output
      return { text, exitCode: code ?? exitCodeOf(text) }
    }
  } catch {
    // plain text output
  }
  return { text: output, exitCode: exitCodeOf(output) }
}

export function parseCodexRolloutOutcomes(text: string, previous: ParseState, context: ParseContext): ParseResult {
  const state: ParseState = { pending: { ...previous.pending }, agents: { ...previous.agents } }
  const outcomes: OutcomeDraft[] = []
  for (const raw of jsonLines(text)) {
    if (raw.type !== 'response_item' || !isRecord(raw.payload)) continue
    const payload = raw.payload
    const type = str(payload.type)
    const id = str(payload.call_id)
    if (id === '') continue
    if (type === 'function_call') {
      const name = str(payload.name)
      const kind: OutcomeKind = /patch/i.test(name) ? 'edit' : 'command'
      state.pending[id] = { tool: kind === 'edit' ? 'apply_patch' : 'Shell', kind, target: codexCallTarget(str(payload.arguments)) }
    } else if (type === 'custom_tool_call') {
      const name = str(payload.name)
      if (/patch/i.test(name)) state.pending[id] = { tool: 'apply_patch', kind: 'edit', target: patchTarget(str(payload.input)) }
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const use = state.pending[id]
      if (use === undefined) continue
      delete state.pending[id]
      const { text: output, exitCode } = codexOutput(str(payload.output))
      if (exitCode === null) continue
      outcomes.push(draft(context, id, timestamp(raw, context.now), use, exitCode === 0, use.kind === 'command' ? exitCode : null, output))
    }
  }
  return { outcomes, state }
}

function codexExecItem(item: R, raw: R, context: ParseContext, out: OutcomeDraft[]): void {
  const id = str(item.id)
  if (id === '') return
  if (item.type === 'command_execution' && typeof item.exit_code === 'number') {
    const use: PendingUse = { tool: 'Shell', kind: 'command', target: oneLine(codexCommand(item.command), TARGET_CHARS) }
    out.push(draft(context, id, timestamp(raw, context.now), use, item.exit_code === 0, item.exit_code, str(item.aggregated_output)))
  } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
    const paths = item.changes.map((change) => (isRecord(change) ? str(change.path) : '')).filter(Boolean)
    const use: PendingUse = { tool: 'apply_patch', kind: 'edit', target: oneLine(paths.join(', ') || 'patch', TARGET_CHARS) }
    out.push(draft(context, id, timestamp(raw, context.now), use, item.status === 'completed', null, ''))
  }
}

export function parseCodexExecOutcomes(text: string, previous: ParseState, context: ParseContext): ParseResult {
  const state: ParseState = { pending: { ...previous.pending }, agents: { ...previous.agents } }
  const outcomes: OutcomeDraft[] = []
  for (const raw of jsonLines(text)) {
    if (raw.type === 'item.completed' && isRecord(raw.item)) codexExecItem(raw.item, raw, context, outcomes)
    const msg = isRecord(raw.msg) ? raw.msg : null
    if (msg === null) continue
    const id = str(msg.call_id)
    if (msg.type === 'exec_command_begin' && id !== '') state.pending[id] = { tool: 'Shell', kind: 'command', target: oneLine(codexCommand(msg.command), TARGET_CHARS) }
    if (msg.type === 'exec_command_end' && state.pending[id] !== undefined && typeof msg.exit_code === 'number') {
      const use = state.pending[id]!
      delete state.pending[id]
      outcomes.push(draft(context, id, timestamp(raw, context.now), use, msg.exit_code === 0, msg.exit_code, str(msg.stderr) || str(msg.stdout) || str(msg.aggregated_output)))
    }
  }
  return { outcomes, state }
}

export type SettledJob = { id: string; label: string; engine: string; status: string; exitCode: number | null; endedAt: number | null; diffStat: string | null }

export function jobOutcome(job: SettledJob, reported: 'done' | 'failed' | null, actor: Actor): OutcomeDraft | null {
  if (job.status === 'running') return null
  const ok = job.status === 'done' && reported !== 'failed'
  const exitCode = ok || job.exitCode === 0 ? null : job.exitCode
  return { at: job.endedAt ?? Date.now(), ok, kind: 'job', tool: 'Job', target: oneLine(job.label, TARGET_CHARS), result: resultText('job', ok, exitCode), detail: ok ? oneLine(job.diffStat ?? '', DETAIL_CHARS) : '', actor, key: `job:${job.id}` }
}

export type CheckedAttempt = { number: number; endedAt: number | null; checks: Array<{ command: string; args: string[]; exitCode: number | null; output: string; timedOut: boolean }> }

export function checkOutcomes(runId: string, attempts: readonly CheckedAttempt[], actor: Actor): OutcomeDraft[] {
  return attempts.flatMap((attempt) => attempt.checks.map((check, index): OutcomeDraft => {
    const ok = check.exitCode === 0 && !check.timedOut
    const detail = check.timedOut ? 'Timed out' : outcomeDetail(check.output, ok)
    return { at: attempt.endedAt ?? Date.now(), ok, kind: 'check', tool: 'Check', target: oneLine([check.command, ...check.args].join(' '), TARGET_CHARS), result: resultText('check', ok, check.exitCode), detail, actor, key: `run:${runId}#${attempt.number}#${index}` }
  }))
}
