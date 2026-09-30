import { parseThread } from './activity'

export type EditCall = { toolUseId: string; name: string; input: Record<string, unknown>; resultIsError: boolean }

function parseInput(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  return {}
}

export function findEditCall(log: string, toolUseId: string): EditCall | null {
  for (const event of parseThread(log)) {
    if (event.kind !== 'tool' || event.toolUseId !== toolUseId) continue
    return { toolUseId, name: event.title, input: parseInput(event.input ?? ''), resultIsError: event.resultIsError === true }
  }
  return null
}

export const UNDO_CHANGED = 'The file changed since this edit; undo it by hand'
export const UNDO_UNSUPPORTED = 'This edit cannot be undone automatically'
export const UNDO_ALREADY = 'This edit was already undone'

const turnUndoQueues = new Map<string, Promise<unknown>>()

export function serializeTurnUndo<T>(turnId: string, work: () => Promise<T>): Promise<T> {
  const previous = turnUndoQueues.get(turnId) ?? Promise.resolve()
  const next = previous.then(work, work)
  const settled = next.then(() => undefined, () => undefined)
  turnUndoQueues.set(turnId, settled)
  void settled.then(() => {
    if (turnUndoQueues.get(turnId) === settled) turnUndoQueues.delete(turnId)
  })
  return next
}

function replaceOnce(content: string, needle: string, replacement: string): string | null {
  const first = content.indexOf(needle)
  if (first < 0 || content.indexOf(needle, first + 1) >= 0) return null
  return content.slice(0, first) + replacement + content.slice(first + needle.length)
}

type MultiEditEntry = { old_string: string; new_string: string }

function editPairs(name: string, input: Record<string, unknown>): Array<{ old_string: string; new_string: string }> | null {
  if (name === 'Edit') {
    return typeof input.old_string === 'string' && typeof input.new_string === 'string' ? [{ old_string: input.old_string, new_string: input.new_string }] : null
  }
  if (!Array.isArray(input.edits)) return null
  const pairs: MultiEditEntry[] = []
  for (const edit of input.edits) {
    if (edit === null || typeof edit !== 'object' || typeof (edit as Record<string, unknown>).old_string !== 'string' || typeof (edit as Record<string, unknown>).new_string !== 'string') return null
    const record = edit as Record<string, string>
    pairs.push({ old_string: record.old_string, new_string: record.new_string })
  }
  return pairs
}

export function undoEditContent(content: string, name: string, input: Record<string, unknown>): { content: string } | { error: string; status: number } {
  if (input.old_string === '' || input.replace_all === true) return { error: UNDO_UNSUPPORTED, status: 409 }
  const pairs = editPairs(name, input)
  if (pairs === null) return { error: UNDO_UNSUPPORTED, status: 409 }
  let next = content
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index]
    if (pair === undefined || pair.new_string === '') return { error: UNDO_UNSUPPORTED, status: 409 }
    const replaced = replaceOnce(next, pair.new_string, pair.old_string)
    if (replaced === null) return { error: UNDO_CHANGED, status: 409 }
    next = replaced
  }
  return { content: next }
}
