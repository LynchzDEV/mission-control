import Anser from 'anser'
import { diffLines } from 'diff'

export type ToolCardKind = 'read' | 'search' | 'edit' | 'bash' | 'agent' | 'other'
export type ToolCardStatus = 'done' | 'failed' | 'running'

export type DiffLine = { old: number | null; new: number | null; sign: ' ' | '+' | '-'; text: string }

export type EditDiff = { tool: 'Edit' | 'MultiEdit' | 'Write'; path: string; additions: number; deletions: number; lines: DiffLine[] }

export type ToolCard = {
  kind: ToolCardKind
  verb: string
  target: string
  summary: string
  status: ToolCardStatus
  exitCode: number | null
  command: string | null
  output: string
  errorLine: string | null
  key: string
  toolUseId: string
  undone: boolean
  diff: EditDiff | null
}

export type ToolCardMessage = { title: string; detail: string; input: string; result: string; resultIsError: boolean; toolUseId?: string; undone?: boolean }

const KIND_BY_TITLE: Record<string, ToolCardKind> = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  Task: 'agent',
  Agent: 'agent',
}

const OUTPUT_MAX_LINES = 400
const OUTPUT_MAX_CHARS = 20_000
const EXIT_LINE = /^Exit code (\d+)$/
const IMAGE_RESULT = /"type":\s*"image"/

function parseInput(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  return {}
}

const countLines = (text: string): number => {
  if (text === '') return 0
  const lines = text.split('\n')
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

function editSummary(title: string, input: Record<string, unknown>): string {
  if (title === 'Edit') return `+${countLines(textOf(input.new_string))} −${countLines(textOf(input.old_string))}`
  if (title === 'Write') return `+${countLines(textOf(input.content))}`
  if (title !== 'MultiEdit') return ''
  let added = 0
  let removed = 0
  for (const edit of Array.isArray(input.edits) ? input.edits : []) {
    if (edit === null || typeof edit !== 'object') continue
    const record = edit as Record<string, unknown>
    added += countLines(textOf(record.new_string))
    removed += countLines(textOf(record.old_string))
  }
  return `+${added} −${removed}`
}

function diffOf(oldText: string, newText: string, path: string, tool: EditDiff['tool']): EditDiff {
  const lines: DiffLine[] = []
  let oldNumber = 0
  let newNumber = 0
  let additions = 0
  let deletions = 0
  for (const part of diffLines(oldText, newText)) {
    const rows = part.value.replace(/\n$/, '').split('\n')
    for (const text of rows) {
      if (part.added === true) {
        newNumber += 1
        additions += 1
        lines.push({ old: null, new: newNumber, sign: '+', text })
      } else if (part.removed === true) {
        oldNumber += 1
        deletions += 1
        lines.push({ old: oldNumber, new: null, sign: '-', text })
      } else {
        oldNumber += 1
        newNumber += 1
        lines.push({ old: oldNumber, new: newNumber, sign: ' ', text })
      }
    }
  }
  return { tool, path, additions, deletions, lines }
}

export function editDiff(title: string, input: Record<string, unknown>): EditDiff | null {
  const path = textOf(input.file_path)
  if (path === '') return null
  if (title === 'Write') {
    const content = textOf(input.content)
    const lines = (content === '' ? [] : content.replace(/\n$/, '').split('\n')).map((text, index) => ({ old: null, new: index + 1, sign: '+' as const, text }))
    return { tool: 'Write', path, additions: lines.length, deletions: 0, lines }
  }
  if (title === 'Edit') return diffOf(textOf(input.old_string), textOf(input.new_string), path, 'Edit')
  if (title !== 'MultiEdit' || !Array.isArray(input.edits)) return null
  const lines: DiffLine[] = []
  let additions = 0
  let deletions = 0
  for (const edit of input.edits) {
    if (edit === null || typeof edit !== 'object') continue
    const record = edit as Record<string, unknown>
    if (lines.length > 0) lines.push({ old: null, new: null, sign: ' ', text: '' })
    const part = diffOf(textOf(record.old_string), textOf(record.new_string), path, 'MultiEdit')
    additions += part.additions
    deletions += part.deletions
    lines.push(...part.lines)
  }
  return lines.length > 0 ? { tool: 'MultiEdit', path, additions, deletions, lines } : null
}

function summaryFor(card: Omit<ToolCard, 'summary'>, title: string, input: Record<string, unknown>, isImage: boolean): string {
  switch (card.kind) {
    case 'read':
      if (isImage) return 'image'
      return card.output === '' ? '0 lines' : `${countLines(card.output)} lines`
    case 'search': {
      const matches = card.output.split('\n').filter(line => line !== '').length
      return card.output === 'No matches found' ? '0 matches' : `${matches} matches`
    }
    case 'edit':
      return card.diff !== null ? `+${card.diff.additions} −${card.diff.deletions}` : editSummary(title, input)
    case 'bash':
      return card.exitCode !== null ? `exit ${card.exitCode}` : card.status === 'failed' ? 'failed' : ''
    default:
      return ''
  }
}

export function toolCard(message: ToolCardMessage, turnRunning: boolean, index: number): ToolCard {
  const kind = KIND_BY_TITLE[message.title] ?? 'other'
  const input = parseInput(message.input)
  let output = message.result
  let exitCode: number | null = null
  if (kind === 'bash') {
    const newline = output.indexOf('\n')
    const exit = EXIT_LINE.exec(newline === -1 ? output : output.slice(0, newline))
    if (exit) {
      exitCode = Number(exit[1])
      output = newline === -1 ? '' : output.slice(newline + 1)
    }
  }
  const isImage = kind === 'read' && message.result.startsWith('{') && IMAGE_RESULT.test(message.result)
  if (isImage) output = ''
  const status: ToolCardStatus = message.resultIsError || (exitCode !== null && exitCode !== 0)
    ? 'failed'
    : turnRunning && message.result === ''
      ? 'running'
      : 'done'
  const partial: Omit<ToolCard, 'summary'> = {
    kind,
    verb: message.title,
    target: message.detail,
    status,
    exitCode,
    command: kind === 'bash' && typeof input.command === 'string' ? input.command : null,
    output,
    errorLine: status === 'failed' ? (output.split('\n').find(line => line !== '') ?? null) : null,
    key: String(index),
    toolUseId: message.toolUseId ?? '',
    undone: message.undone === true,
    diff: kind === 'edit' ? editDiff(message.title, input) : null,
  }
  return { ...partial, summary: summaryFor(partial, message.title, input, isImage) }
}

const HIDDEN_NOTE = (lines: number): string => `… ${lines} earlier lines hidden`

export function capOutput(text: string): string {
  let body = text
  let hidden = 0
  if (body.length > OUTPUT_MAX_CHARS) {
    const cut = body.slice(0, body.length - OUTPUT_MAX_CHARS)
    body = body.slice(-OUTPUT_MAX_CHARS)
    const cutBreaks = cut.split('\n').length - 1
    hidden = cut.endsWith('\n') ? cutBreaks : cutBreaks + 1
    if (!cut.endsWith('\n')) {
      const firstBreak = body.indexOf('\n')
      if (firstBreak !== -1 && firstBreak + 1 < body.length) body = body.slice(firstBreak + 1)
    }
  }
  const lines = body.split('\n')
  if (lines.length > OUTPUT_MAX_LINES) {
    hidden += lines.length - OUTPUT_MAX_LINES
    return [HIDDEN_NOTE(hidden), ...lines.slice(-OUTPUT_MAX_LINES)].join('\n')
  }
  return hidden > 0 ? [HIDDEN_NOTE(hidden), ...lines].join('\n') : text
}

export function ansiHtml(text: string): string {
  return Anser.ansiToHtml(Anser.escapeForHtml(text), { use_classes: true })
}
