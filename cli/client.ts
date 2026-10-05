export type FetchLike = (request: Request) => Promise<Response>

export type Query = Record<string, string | undefined>

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown = null) {
    super(message)
    this.name = 'ApiError'
  }
}

export class UnreachableError extends Error {
  constructor(readonly url: string) {
    super(`Mission Control isn't running at ${url}. Start it with: bun run start`)
    this.name = 'UnreachableError'
  }
}

export type ClientOptions = { url: string; token: string | null; fetch: FetchLike }

export type Client = {
  url: string
  get(path: string, query?: Query): Promise<unknown>
  getText(path: string, query?: Query): Promise<string>
  post(path: string, body?: unknown): Promise<unknown>
  put(path: string, body: unknown): Promise<unknown>
  patch(path: string, body: unknown): Promise<unknown>
  del(path: string, body?: unknown): Promise<unknown>
  stream(path: string, query: Query, signal: AbortSignal): Promise<Response>
}

const ERROR_SNIPPET_MAX = 200

export function segment(value: string): string {
  return encodeURIComponent(value)
}

function jsonError(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null
    return typeof parsed?.error === 'string' && parsed.error !== '' ? parsed.error : null
  } catch {
    return null
  }
}

function parsedBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function apiError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '')
  const serverError = jsonError(text)
  const snippet = text.trim().slice(0, ERROR_SNIPPET_MAX)
  const message = serverError ?? (snippet === '' ? `HTTP ${response.status}` : `HTTP ${response.status}: ${snippet}`)
  return new ApiError(response.status, message, parsedBody(text))
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return text
  return text === '' ? null : JSON.parse(text)
}

export function createClient(options: ClientOptions): Client {
  const base = options.url.replace(/\/+$/, '')

  function buildUrl(path: string, query: Query = {}): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value)
    const search = params.toString()
    return `${base}${path}${search === '' ? '' : `?${search}`}`
  }

  async function send(method: string, path: string, init: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = new Headers({ accept: 'application/json' })
    if (options.token !== null) headers.set('authorization', `Bearer ${options.token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const request = new Request(buildUrl(path, init.query), {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
    let response: Response
    try {
      response = await options.fetch(request)
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new UnreachableError(base)
    }
    if (!response.ok) throw await apiError(response)
    return response
  }

  return {
    url: base,
    get: async (path, query) => readBody(await send('GET', path, { query })),
    getText: async (path, query) => (await send('GET', path, { query })).text(),
    post: async (path, body) => readBody(await send('POST', path, { body })),
    put: async (path, body) => readBody(await send('PUT', path, { body })),
    patch: async (path, body) => readBody(await send('PATCH', path, { body })),
    del: async (path, body) => readBody(await send('DELETE', path, body === undefined ? {} : { body })),
    stream: (path, query, signal) => send('GET', path, { query, signal }),
  }
}
