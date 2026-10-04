export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(entry => errorMessage(entry)).join('\n')
  if (error instanceof Error) return error.message
  return String(error)
}
