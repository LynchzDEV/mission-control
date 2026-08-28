export type JsonRecord = Record<string, unknown>

export type ApiResult = {
  ok: boolean
  status: number
  data: JsonRecord
}

async function parse(response: Response): Promise<JsonRecord> {
  try {
    const parsed: unknown = await response.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as JsonRecord
  } catch {
    return {}
  }
}

export async function getJson(url: string): Promise<ApiResult> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    return { ok: response.ok, status: response.status, data: await parse(response) }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
}

export async function postJson(url: string, body: JsonRecord): Promise<ApiResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { ok: response.ok, status: response.status, data: await parse(response) }
  } catch {
    return { ok: false, status: 0, data: {} }
  }
}

export function errorText(result: ApiResult): string {
  const message = result.data.error
  if (typeof message === 'string' && message !== '') return message
  return result.status === 0 ? 'server unreachable' : `request failed (${result.status})`
}

export function markFixture(on: boolean): void {
  document.querySelectorAll<HTMLElement>('.fixture').forEach((tag) => {
    tag.classList.toggle('on', on)
  })
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonRecord
}

export function readArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is JsonRecord => readRecord(entry) === entry)
}

export function text(selector: string, value: string): void {
  const element = document.querySelector<HTMLElement>(selector)
  if (element !== null) element.textContent = value
}
