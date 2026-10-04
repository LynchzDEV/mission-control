import { ApiError, segment } from '../client'
import { arg, countOpt, emit, flag, oneOf, records, stringOpt, textArg, UsageError, type Command, type Context, type OptionSpec } from '../command'
import { cell, firstLine, keyValue, relativeAge, table } from '../format'

const DEFAULT_ENGINE = 'claude'
const LABEL_MAX = 60
const FINAL_DRAIN_MS = 200
const RECENT_ACTIVITY = 10
const PERMISSION_DECISIONS = ['allow_once', 'allow_always', 'deny'] as const

type JobRow = Record<string, unknown>

const jobPath = (ctx: Context, suffix = ''): string => `/api/jobs/${segment(arg(ctx, 'id'))}${suffix}`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function newestFirst(jobs: JobRow[]): JobRow[] {
  return [...jobs].sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0))
}

function jobsText(value: unknown): string {
  const jobs = newestFirst(records(value, 'jobs'))
  if (jobs.length === 0) return 'No jobs.\n'
  return table(jobs, [
    { header: 'ID', value: (job) => cell(job.id) },
    { header: 'STATUS', value: (job) => cell(job.status) },
    { header: 'ENGINE', value: (job) => cell(job.engine) },
    { header: 'AGE', value: (job) => relativeAge(job.startedAt) },
    { header: 'PROMPT', value: (job) => firstLine(job.prompt) || '-' },
  ])
}

function labelFor(prompt: string): string {
  return (prompt.split('\n')[0] ?? '').trim().slice(0, LABEL_MAX)
}

async function listJobs(ctx: Context): Promise<JobRow[]> {
  return records(await ctx.client.get('/api/jobs'), 'jobs')
}

async function jobStatus(ctx: Context, id: string): Promise<string> {
  const job = (await listJobs(ctx)).find((entry) => entry.id === id)
  if (job === undefined) throw new ApiError(404, 'job not found')
  return String(job.status)
}

async function waitForEnd(ctx: Context, id: string): Promise<string> {
  for (;;) {
    const status = await jobStatus(ctx, id)
    if (status !== 'running') return status
    await sleep(ctx.pollMs)
  }
}

function ssePayload(block: string): string | null {
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
  return data.length === 0 ? null : data.join('\n')
}

async function readSse(response: Response, signal: AbortSignal, onData: (payload: string) => void): Promise<void> {
  if (response.body === null) return
  const reader = response.body.getReader()
  signal.addEventListener('abort', () => void reader.cancel().catch(() => {}))
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const payload = ssePayload(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (payload !== null) onData(payload)
      boundary = buffer.indexOf('\n\n')
    }
  }
}

async function follow(ctx: Context, id: string, fromStart: boolean): Promise<number> {
  const controller = new AbortController()
  const response = await ctx.client.stream(`/api/jobs/${segment(id)}/stream`, fromStart ? { offset: '0' } : {}, controller.signal)
  let printed = ''
  const onData = (payload: string): void => {
    printed += payload
    ctx.out(ctx.json ? `${JSON.stringify({ type: 'data', data: payload })}\n` : payload)
  }
  const reading = readSse(response, controller.signal, onData).catch(() => {})
  try {
    const status = await waitForEnd(ctx, id)
    await sleep(FINAL_DRAIN_MS)
    controller.abort()
    await reading
    if (fromStart) {
      const log = await ctx.client.getText(`/api/jobs/${segment(id)}/log`)
      if (log.startsWith(printed) && log.length > printed.length) onData(log.slice(printed.length))
    }
    if (ctx.json) ctx.out(`${JSON.stringify({ type: 'end', status })}\n`)
    else if (status !== 'done') ctx.err(`Job ${id} ${status}\n`)
    return status === 'done' ? 0 : 1
  } finally {
    controller.abort()
  }
}

async function newJob(ctx: Context): Promise<number> {
  const prompt = await textArg(ctx, 'prompt')
  const label = stringOpt(ctx, 'label') ?? labelFor(prompt)
  if (prompt.trim() === '' || label === '') throw new UsageError('the prompt is empty')
  const model = stringOpt(ctx, 'model')
  const body = {
    engine: stringOpt(ctx, 'engine') ?? DEFAULT_ENGINE,
    cwd: stringOpt(ctx, 'cwd') ?? ctx.cwd,
    prompt,
    label,
    ...(model === undefined ? {} : { model }),
    ...(flag(ctx, 'worktree') ? { worktree: true } : {}),
  }
  const job = await ctx.client.post('/api/jobs', body)
  if (!flag(ctx, 'follow')) {
    emit(ctx, job, keyValue)
    return 0
  }
  const id = String((job as JobRow).id)
  if (ctx.json) ctx.out(`${JSON.stringify({ type: 'job', job })}\n`)
  else ctx.err(`Started job ${id}\n`)
  return follow(ctx, id, true)
}

async function showJob(ctx: Context): Promise<void> {
  const id = arg(ctx, 'id')
  const job = (await listJobs(ctx)).find((entry) => entry.id === id)
  if (job === undefined) throw new ApiError(404, 'job not found')
  const activity = await ctx.client.get(jobPath(ctx, '/activity'))
  emit(ctx, { job, activity }, () => {
    const summary = { id: job.id, status: job.status, engine: job.engine, model: job.model, label: job.label, cwd: job.cwd, worktree: job.worktree, age: relativeAge(job.startedAt), diffStat: job.diffStat, currentActivity: job.currentActivity }
    const events = records(activity, 'events').slice(-RECENT_ACTIVITY)
    const recent = events.length === 0 ? 'Recent activity: (none)\n' : `Recent activity:\n${table(events, [
      { header: 'KIND', value: (event) => cell(event.kind) },
      { header: 'TITLE', value: (event) => cell(event.title) },
      { header: 'DETAIL', value: (event) => cell(event.detail) },
    ])}`
    return keyValue(summary) + recent
  })
}

function rawText(ctx: Context, key: string, text: string): void {
  ctx.out(ctx.json ? `${JSON.stringify({ [key]: text })}\n` : text)
}

const ID_ONLY = ['id']
const LEAF_OPTION: Record<string, OptionSpec> = { leaf: { type: 'string', description: 'turn id to read the branch of', placeholder: 'TURN' } }

function postVerb(verb: string, summary: string): Command {
  return { path: ['job', verb], args: ID_ONLY, summary, run: async (ctx) => emit(ctx, await ctx.client.post(jobPath(ctx, `/${verb}`)), keyValue) }
}

export const jobCommands: Command[] = [
  {
    path: ['jobs'],
    options: {
      limit: { type: 'string', description: 'show only the newest N jobs', placeholder: 'N' },
      chat: { type: 'string', description: 'only jobs of this chat', placeholder: 'ID' },
    },
    summary: 'List jobs (newest first)',
    run: async (ctx) => {
      const limit = countOpt(ctx, 'limit')
      const value = await ctx.client.get('/api/jobs', { chat: stringOpt(ctx, 'chat') })
      const limited = limit === undefined ? value : { ...(value as object), jobs: newestFirst(records(value, 'jobs')).slice(0, limit) }
      emit(ctx, limited, jobsText)
    },
  },
  {
    path: ['job', 'new'],
    args: ['prompt'],
    options: {
      engine: { type: 'string', description: `engine to run (default ${DEFAULT_ENGINE})`, placeholder: 'E' },
      model: { type: 'string', description: 'model id', placeholder: 'M' },
      cwd: { type: 'string', description: 'repo to work in (default: current folder)', placeholder: 'DIR' },
      label: { type: 'string', description: 'job name (default: first line of the prompt)', placeholder: 'L' },
      worktree: { type: 'boolean', description: 'run in an isolated git worktree' },
      follow: { type: 'boolean', description: 'stream the output until the job ends' },
    },
    summary: 'Start a job; pass - as the prompt to read it from stdin',
    run: newJob,
  },
  { path: ['job', 'show'], args: ID_ONLY, summary: 'One job with its recent activity', run: showJob },
  { path: ['job', 'log'], args: ID_ONLY, summary: 'Full job log (raw text)', run: async (ctx) => rawText(ctx, 'log', await ctx.client.getText(jobPath(ctx, '/log'))) },
  {
    path: ['job', 'follow'],
    args: ID_ONLY,
    summary: 'Stream a job until it ends; exit 0 if done, 1 if failed or killed (NDJSON under --json)',
    run: (ctx) => follow(ctx, arg(ctx, 'id'), false),
  },
  {
    path: ['job', 'reply'],
    args: ['id', 'text'],
    summary: 'Send a follow-up message to a job (- reads stdin)',
    run: async (ctx) => {
      const message = await textArg(ctx, 'text')
      emit(ctx, await ctx.client.post(jobPath(ctx, '/reply'), { message }), keyValue)
    },
  },
  {
    path: ['job', 'permission'],
    args: ['id', 'decision'],
    options: { request: { type: 'string', description: 'permission request id (required; see mctl attention)', placeholder: 'RID' } },
    summary: 'Answer a permission request: allow_once, allow_always or deny',
    run: async (ctx) => {
      const decision = oneOf(arg(ctx, 'decision'), PERMISSION_DECISIONS, 'decision')
      const requestId = stringOpt(ctx, 'request')
      if (requestId === undefined || requestId === '') throw new UsageError('--request <requestId> is required')
      emit(ctx, await ctx.client.post(jobPath(ctx, '/permission'), { requestId, decision }), keyValue)
    },
  },
  postVerb('kill', 'Stop a running job'),
  postVerb('land', 'Land a job’s worktree changes on its branch'),
  postVerb('reviewed', 'Mark a job reviewed'),
  {
    path: ['job', 'undo'],
    args: ['id', 'toolUseId'],
    summary: 'Undo one Edit/MultiEdit tool call of a chat turn',
    run: async (ctx) => emit(ctx, await ctx.client.post(jobPath(ctx, '/undo'), { toolUseId: arg(ctx, 'toolUseId') }), keyValue),
  },
  {
    path: ['job', 'rename'],
    args: ['id', 'label'],
    options: { lock: { type: 'boolean', description: 'lock the title so auto-titling stops' } },
    summary: 'Rename a chat',
    run: async (ctx) => emit(ctx, await ctx.client.patch(jobPath(ctx), { label: arg(ctx, 'label'), ...(flag(ctx, 'lock') ? { titleLocked: true } : {}) }), keyValue),
  },
  {
    path: ['job', 'export'],
    args: ID_ONLY,
    options: LEAF_OPTION,
    summary: 'Export a chat as markdown',
    run: async (ctx) => rawText(ctx, 'markdown', await ctx.client.getText(jobPath(ctx, '/export.md'), { leaf: stringOpt(ctx, 'leaf') })),
  },
  {
    path: ['job', 'thread'],
    args: ID_ONLY,
    options: LEAF_OPTION,
    summary: 'Messages of a job’s thread',
    run: async (ctx) => emit(ctx, await ctx.client.get(jobPath(ctx, '/thread'), { leaf: stringOpt(ctx, 'leaf') }), keyValue),
  },
  { path: ['job', 'commands'], args: ID_ONLY, summary: 'Slash commands a job’s engine offers', run: async (ctx) => emit(ctx, await ctx.client.get(jobPath(ctx, '/commands')), keyValue) },
  { path: ['job', 'queue'], args: ID_ONLY, summary: 'Messages queued behind a running reply', run: async (ctx) => emit(ctx, await ctx.client.get(jobPath(ctx, '/queue')), keyValue) },
  {
    path: ['job', 'queue', 'rm'],
    args: ['id', 'itemId'],
    summary: 'Remove one queued message',
    run: async (ctx) => emit(ctx, await ctx.client.del(jobPath(ctx, `/queue/${segment(arg(ctx, 'itemId'))}`)), keyValue),
  },
]
