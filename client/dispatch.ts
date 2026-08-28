import { errorText, getJson, markFixture, postJson, readArray, readNumber } from './shared'

type Job = {
  id: string
  engine: string
  label: string
  cwd: string
  status: string
  startedAt: number | null
  endedAt: number | null
  diffStat: string
  reviewedAt: number | null
}

const LIVE_POLL_MS = 5_000
const ABSENT_POLL_MS = 60_000

let stream: EventSource | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function toJob(raw: Record<string, unknown>): Job {
  return {
    id: str(raw.id, '?'),
    engine: str(raw.engine, '?'),
    label: str(raw.label, str(raw.id, 'job')),
    cwd: str(raw.cwd),
    status: str(raw.status, 'unknown'),
    startedAt: readNumber(raw.startedAt),
    endedAt: readNumber(raw.endedAt),
    diffStat: str(raw.diffStat),
    reviewedAt: readNumber(raw.reviewedAt),
  }
}

function elapsed(job: Job): string {
  if (job.startedAt === null) return '—'
  const end = job.endedAt ?? Date.now()
  const minutes = Math.max(0, Math.round((end - job.startedAt) / 60_000))
  return `${minutes}m`
}

function cellText(row: HTMLTableRowElement, value: string, className = ''): void {
  const cell = row.insertCell()
  cell.textContent = value
  if (className !== '') cell.className = className
}

function renderJobs(jobs: Job[]): void {
  const body = document.querySelector<HTMLTableSectionElement>('#jobs-body')
  if (body === null) return
  body.textContent = ''
  if (jobs.length === 0) {
    const row = body.insertRow()
    row.className = 'empty'
    const cell = row.insertCell()
    cell.colSpan = 6
    cell.textContent = 'NO JOBS YET'
    return
  }
  for (const job of jobs) {
    const row = body.insertRow()
    const status = row.insertCell()
    const dot = document.createElement('span')
    dot.className = `dot ${job.status}`
    status.appendChild(dot)
    status.append(job.status.toUpperCase())
    cellText(row, job.engine.toUpperCase())
    cellText(row, job.label)
    cellText(row, elapsed(job), 'dim')
    cellText(row, job.diffStat === '' ? '—' : job.diffStat, 'dim')

    const actions = row.insertCell()
    const tail = document.createElement('button')
    tail.className = 'btn'
    tail.textContent = 'LOG'
    tail.onclick = () => openLog(job)
    actions.appendChild(tail)
    if (job.status === 'running') {
      const kill = document.createElement('button')
      kill.className = 'btn'
      kill.textContent = 'KILL'
      kill.onclick = () => void killJob(job)
      actions.appendChild(kill)
    }
  }
}

function renderReview(jobs: Job[]): void {
  const body = document.querySelector<HTMLTableSectionElement>('#review-body')
  if (body === null) return
  const queue = jobs.filter(
    (job) => job.status === 'done' && job.diffStat !== '' && job.reviewedAt === null,
  )
  body.textContent = ''
  if (queue.length === 0) {
    const row = body.insertRow()
    row.className = 'empty'
    const cell = row.insertCell()
    cell.colSpan = 5
    cell.textContent = 'NOTHING WAITING ON REVIEW'
    return
  }
  for (const job of queue) {
    const row = body.insertRow()
    cellText(row, job.label)
    cellText(row, job.engine.toUpperCase())
    cellText(row, job.cwd, 'dim')
    cellText(row, job.diffStat, 'dim')
    const actions = row.insertCell()
    const copy = document.createElement('button')
    copy.className = 'btn'
    copy.textContent = 'COPY REVIEW CMD'
    copy.onclick = () => void copyCommand(job)
    actions.appendChild(copy)
    const reviewed = document.createElement('button')
    reviewed.className = 'btn'
    reviewed.textContent = 'MARK REVIEWED'
    reviewed.onclick = () => void markReviewed(job)
    actions.appendChild(reviewed)
  }
}

async function markReviewed(job: Job): Promise<void> {
  const result = await postJson(`/api/jobs/${job.id}/reviewed`, {})
  const message = document.querySelector<HTMLElement>('#review-msg')
  if (message !== null) {
    message.textContent = result.ok ? 'REVIEWED' : errorText(result).toUpperCase()
    message.classList.toggle('ok', result.ok)
  }
  await refresh()
}

async function copyCommand(job: Job): Promise<void> {
  const command = `cd ${job.cwd} && claude --continue`
  const message = document.querySelector<HTMLElement>('#review-msg')
  try {
    await navigator.clipboard.writeText(command)
    if (message !== null) {
      message.textContent = 'COPIED'
      message.classList.add('ok')
    }
  } catch {
    if (message !== null) {
      message.textContent = command
      message.classList.remove('ok')
    }
  }
}

async function killJob(job: Job): Promise<void> {
  await postJson(`/api/jobs/${job.id}/kill`, {})
  await refresh()
}

function openLog(job: Job): void {
  const title = document.querySelector<HTMLElement>('#log-job')
  const body = document.querySelector<HTMLElement>('#log-body')
  if (title === null || body === null) return
  title.textContent = `${job.label} · ${job.id}`
  body.textContent = ''
  stream?.close()
  stream = new EventSource(`/api/jobs/${job.id}/stream`)
  stream.onmessage = (event) => {
    body.textContent += `${event.data}\n`
    body.scrollTop = body.scrollHeight
  }
  stream.onerror = () => {
    body.textContent += '[stream closed]\n'
    stream?.close()
  }
}

async function refresh(): Promise<void> {
  const result = await getJson('/api/jobs')
  const jobs = result.ok ? readArray(result.data.jobs).map(toJob) : []
  markFixture('jobs', !result.ok)
  renderJobs(jobs)
  renderReview(jobs)
  schedule(result.ok ? LIVE_POLL_MS : ABSENT_POLL_MS)
}

function schedule(delay: number): void {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh(), delay)
}

function installForm(): void {
  const form = document.querySelector<HTMLFormElement>('#dispatch-form')
  if (form === null) return
  const message = document.querySelector<HTMLElement>('#dispatch-msg')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const payload = {
      engine: String(data.get('engine') ?? ''),
      cwd: String(data.get('cwd') ?? ''),
      prompt: String(data.get('prompt') ?? ''),
      label: String(data.get('label') ?? ''),
    }
    if (payload.cwd === '' || payload.prompt === '') {
      if (message !== null) {
        message.textContent = 'CWD AND PROMPT ARE REQUIRED'
        message.classList.remove('ok')
      }
      return
    }
    const result = await postJson('/api/jobs', payload)
    if (message !== null) {
      message.textContent = result.ok ? 'DISPATCHED' : errorText(result).toUpperCase()
      message.classList.toggle('ok', result.ok)
    }
    await refresh()
  })
}

export function installDispatch(): void {
  if (document.querySelector('#jobs-body') === null && document.querySelector('#review-body') === null) {
    return
  }
  installForm()
  void refresh()
}

installDispatch()
