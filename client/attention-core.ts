import type { AttentionItem } from '../server/attention'

export type AlertData = Pick<AttentionItem, 'key' | 'kind' | 'chatId' | 'jobId' | 'requestId'>
export type AlertOptions = { body: string; tag: string; renotify: boolean; icon: string; data: AlertData; actions: Array<{ action: string; title: string }> }
export type ClickDeps = {
  post(url: string, body: unknown): Promise<{ ok: boolean; status: number }>
  windows(): Promise<Array<{ focus(): Promise<unknown>; postMessage(message: unknown): void }>>
  open(url: string): Promise<unknown>
  show(title: string, options: AlertOptions): Promise<void>
}

const ACTIONS: Record<AttentionItem['kind'], AlertOptions['actions']> = {
  permission: [{ action: 'allow', title: 'Allow once' }, { action: 'deny', title: 'Deny' }],
  loop: [{ action: 'stop', title: 'Stop job' }],
  needs: [],
}

export const tabTitle = (count: number): string => (count > 0 ? `(${count}) Mission Control` : 'Mission Control')

export function diffItems(before: readonly AttentionItem[], after: readonly AttentionItem[]): { raised: AttentionItem[]; resolved: string[] } {
  const was = new Set(before.map(item => item.key))
  const now = new Set(after.map(item => item.key))
  return { raised: after.filter(item => !was.has(item.key)), resolved: [...was].filter(key => !now.has(key)) }
}

export const shouldAlert = (state: { permission: string; enabled: boolean; visible: boolean; focused: boolean }): boolean =>
  state.permission === 'granted' && state.enabled && !(state.visible && state.focused)

const dataOf = (item: AlertData): AlertData => ({ key: item.key, kind: item.kind, chatId: item.chatId, jobId: item.jobId, requestId: item.requestId })

export function alertFor(item: AttentionItem): { title: string; options: AlertOptions } {
  const body = item.kind === 'permission' && item.command !== null ? `Wants to run: ${item.command}` : item.detail
  return { title: item.title, options: { body, tag: item.key, renotify: false, icon: '/favicon.svg', data: dataOf(item), actions: ACTIONS[item.kind] } }
}

export const linkFor = (data: AlertData): string =>
  data.chatId !== null ? `/?chat=${encodeURIComponent(data.chatId)}` : data.jobId !== null ? `/?job=${encodeURIComponent(data.jobId)}` : '/'

export function requestFor(action: string, data: AlertData): { url: string; body: unknown; verb: string } | null {
  if (data.jobId === null) return null
  const job = encodeURIComponent(data.jobId)
  if ((action === 'allow' || action === 'deny') && data.requestId !== null) return { url: `/api/jobs/${job}/permission`, body: { requestId: data.requestId, decision: action === 'allow' ? 'allow_once' : 'deny' }, verb: action }
  if (action === 'stop') return { url: `/api/jobs/${job}/kill`, body: null, verb: 'stop the job' }
  return null
}

export function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`
}

export async function handleAlertClick(action: string, data: AlertData, deps: ClickDeps): Promise<void> {
  const request = requestFor(action, data)
  if (request !== null) {
    const response = await deps.post(request.url, request.body).catch(() => ({ ok: false, status: 0 }))
    if (response.ok || response.status === 409) return
    await deps.show(`Couldn't ${request.verb} · Open the chat`, { body: 'Answer it in Mission Control instead.', tag: `${data.key}:failed`, renotify: false, icon: '/favicon.svg', data: dataOf(data), actions: [] })
    return
  }
  const link = linkFor(data)
  const [tab] = await deps.windows()
  if (tab === undefined) { await deps.open(link); return }
  await tab.focus()
  tab.postMessage({ type: 'mc:open', link })
}
