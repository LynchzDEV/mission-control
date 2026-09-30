export type ProcessInfo = { command: string; startedAt: number }

export type ProcessInfoReader = (pid: number) => Promise<ProcessInfo | null>

export const CHILD_START_SLACK_MS = 5_000

const LSTART_WIDTH = 24

export function parseUtcPsLine(output: string): ProcessInfo | null {
  const line = output.split('\n').find((entry) => entry.trim() !== '')
  if (line === undefined || line.length <= LSTART_WIDTH) return null
  const startedAt = new Date(`${line.slice(0, LSTART_WIDTH)} GMT`).getTime()
  const command = line.slice(LSTART_WIDTH).trim()
  if (!Number.isFinite(startedAt) || command === '') return null
  return { command, startedAt }
}

export const readProcessInfo: ProcessInfoReader = async (pid) => {
  try {
    const proc = Bun.spawn(['ps', '-o', 'lstart=,command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return parseUtcPsLine(output)
  } catch {
    return null
  }
}

export function isOwnClaudeChild(info: ProcessInfo | null, notBefore: number): boolean {
  return info !== null && info.command.includes('claude') && info.startedAt >= notBefore - CHILD_START_SLACK_MS
}
