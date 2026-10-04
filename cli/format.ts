const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type Column<T> = { header: string; value: (row: T) => string }

export function relativeAge(timestamp: unknown, now: number = Date.now()): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '-'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)}s`
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  return `${Math.floor(elapsed / DAY)}d`
}

export function firstLine(text: unknown, max = 60): string {
  if (typeof text !== 'string') return ''
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function cell(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value === '' ? '-' : firstLine(value, 80)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return firstLine(JSON.stringify(value), 80)
}

export function table<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const grid = [columns.map((column) => column.header), ...rows.map((row) => columns.map((column) => column.value(row)))]
  const widths = columns.map((_, index) => Math.max(...grid.map((line) => line[index]!.length)))
  return grid.map((line) => line.map((text, index) => text.padEnd(widths[index]!)).join('  ').trimEnd()).join('\n') + '\n'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

const AUTO_COLUMN_LIMIT = 6

export function autoTable(rows: readonly unknown[]): string {
  const records = rows.filter(isRecord)
  if (records.length !== rows.length) return rows.map((row) => cell(row)).join('\n') + '\n'
  const keys = [...new Set(records.flatMap((row) => Object.keys(row).filter((key) => isScalar(row[key]))))].slice(0, AUTO_COLUMN_LIMIT)
  return table(records, keys.map((key) => ({ header: key.toUpperCase(), value: (row: Record<string, unknown>) => cell(row[key]) })))
}

function indent(text: string): string {
  return text.trimEnd().split('\n').map((line) => `  ${line}`).join('\n') + '\n'
}

export function keyValue(value: unknown): string {
  if (!isRecord(value)) return Array.isArray(value) ? autoTable(value) : `${cell(value)}\n`
  let text = ''
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) text += entry.length === 0 ? `${key}: (none)\n` : `${key}:\n${indent(autoTable(entry))}`
    else if (isRecord(entry)) text += `${key}:\n${indent(keyValue(entry))}`
    else text += `${key}: ${cell(entry)}\n`
  }
  return text
}
