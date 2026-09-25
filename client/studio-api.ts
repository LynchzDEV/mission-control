export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/studio${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`)
  return result as T
}
export async function apiDelete(path: string): Promise<void> {
  const response = await fetch(`/api/studio${path}`, { method: 'DELETE' })
  if (!response.ok) { const result = await response.json().catch(() => ({})) as { error?: string }; throw new Error(result.error ?? `Request failed (${response.status})`) }
}
