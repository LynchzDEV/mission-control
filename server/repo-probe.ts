import { realpath } from 'node:fs/promises'

export const PROBE_TIMEOUT_MS = 5000
export const PROBE_CONCURRENCY = 8

export type RepoProbe = (dir: string, signal: AbortSignal) => Promise<boolean>
export type ProbeResult = 'repo' | 'not-repo' | 'timeout'

export const gitTopLevelProbe: RepoProbe = async (dir, signal) => {
  const proc = Bun.spawn(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' })
  const kill = (): void => { proc.kill('SIGKILL') }
  signal.addEventListener('abort', kill, { once: true })
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return false
    const [top, real] = await Promise.all([realpath(out.trim()).catch(() => null), realpath(dir).catch(() => null)])
    return top !== null && top === real
  } finally {
    signal.removeEventListener('abort', kill)
  }
}

export async function probeRepo(dir: string, timeoutMs: number = PROBE_TIMEOUT_MS, probe: RepoProbe = gitTopLevelProbe): Promise<ProbeResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<ProbeResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('timeout') }, timeoutMs) })
  const probed = probe(dir, controller.signal).then((isRepo): ProbeResult => (isRepo ? 'repo' : 'not-repo'), (): ProbeResult => 'not-repo')
  try {
    return await Promise.race([probed, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}
