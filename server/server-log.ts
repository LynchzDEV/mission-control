type LoggedJob = { id: string; label: string; engine: string; model: string | null; startedAt: number; endedAt: number | null }
export type JobEvent = 'started' | 'done' | 'failed' | 'stopped'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

export function jobLine(event: JobEvent, job: LoggedJob): string {
  const shortId = job.id.slice(0, 8)
  const name = job.label || shortId
  if (event === 'started') return `job started  ${name} · ${job.model ? `${job.engine}/${job.model}` : job.engine} · ${shortId}`
  return `job ${event}  ${name} · ${duration((job.endedAt ?? job.startedAt) - job.startedAt)} · ${shortId}`
}

export function requestLine(method: string, url: string, status: number, ms: number): string {
  return `${method} ${new URL(url).pathname} ${status} ${Math.round(ms)}ms`
}

export function shouldLogRequest(method: string, status: number, verbose: boolean): boolean {
  return verbose || status >= 400 || MUTATING.has(method)
}

export function log(line: string): void {
  console.log(`${new Date().toLocaleTimeString([], { hour12: false })}  ${line}`)
}
