export type ThreadMember = {
  id: string
  threadRoot: string
  startedAt: number | null
  status: string
}

export type ThreadGroup<T extends ThreadMember> = {
  threadRoot: string
  newestJob: T
  runningJob: T | null
  jobCount: number
}

function rootOf(job: ThreadMember): string {
  return job.threadRoot === '' ? job.id : job.threadRoot
}

// Every job that ever shares a thread root collapses into one card: the newest job (by
// startedAt) drives the displayed status/elapsed/engine, and the newest still-running job (if
// any) is the target for KILL — the two coincide except mid-reply, when a fresh turn hasn't
// started yet but an earlier one in the same thread is still running.
export function groupByThread<T extends ThreadMember>(jobs: readonly T[]): ThreadGroup<T>[] {
  const byRoot = new Map<string, T[]>()
  for (const job of jobs) {
    const root = rootOf(job)
    const members = byRoot.get(root)
    if (members === undefined) byRoot.set(root, [job])
    else members.push(job)
  }
  const groups: ThreadGroup<T>[] = []
  for (const [threadRoot, members] of byRoot) {
    const sorted = [...members].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    const newestJob = sorted[0] as T
    const runningJob = sorted.find((job) => job.status === 'running') ?? null
    groups.push({ threadRoot, newestJob, runningJob, jobCount: sorted.length })
  }
  return groups
}

export function sortThreadsByActivity<T extends ThreadMember>(
  groups: readonly ThreadGroup<T>[],
): ThreadGroup<T>[] {
  return [...groups].sort((left, right) => (right.newestJob.startedAt ?? 0) - (left.newestJob.startedAt ?? 0))
}
