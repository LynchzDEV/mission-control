import { normalizeUsage } from './provider-usage'
import { getJson, readRecord, readNumber, errorText } from './shared'
async function refreshUsage(): Promise<void> {
  const result = await getJson('/api/quota')
  const status = document.querySelector<HTMLElement>('#usage-status')!
  status.textContent = result.ok ? '' : `Usage unavailable: ${errorText(result)}. Retrying automatically.`
  for (const engine of ['claude','glm','codex']) {
    const host = document.querySelector<HTMLElement>(`#usage-${engine}`)!
    host.replaceChildren()
    const data = readRecord(result.data[engine])
    const metric = (label: string, value: string): void => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; host.append(dt,dd) }
    const number = (key: string, suffix = ''): string => { const value = readNumber(data[key]); return value === null ? 'Unavailable' : value.toLocaleString() + suffix }
    if (!result.ok || data.available === false) { metric('Status',typeof data.reason === 'string' ? data.reason : 'Unavailable'); continue }
    const normalized = normalizeUsage(engine,data)
    metric(normalized.fiveHour.estimate ? 'Five-hour quota (ccusage estimate)' : 'Five-hour quota', normalized.fiveHour.percent === null ? 'Unavailable' : `${normalized.fiveHour.percent}%`)
    metric('Five-hour reset', normalized.fiveHour.reset ?? 'Unavailable')
    metric('Weekly quota', normalized.weekly.percent === null ? 'Unavailable' : `${normalized.weekly.percent}%`)
    metric('Weekly reset', normalized.weekly.reset ?? 'Unavailable')
    if (engine === 'claude') { metric('Tokens',number('tokens')); metric('Reported cost',readNumber(data.costUSD) === null ? 'Unavailable' : '$' + Number(data.costUSD).toFixed(2)); metric('Reset',typeof data.resetsAt === 'string' ? data.resetsAt : 'Unavailable') }
    if (engine === 'glm') { metric('Monthly quota',number('monthlyPct','%')) }
    if (engine === 'codex') { metric('Availability', data.available === true ? 'Available' : 'Unknown'); metric('Authentication',data.authed === true ? 'Authenticated' : data.authed === false ? 'Sign-in needed' : 'Unknown') }
  }
}
if (typeof document !== 'undefined' && new URLSearchParams(location.search).get('view') === 'usage') { const usage = document.querySelector<HTMLElement>('#usage-view'); if (usage) { usage.hidden = false; document.querySelector<HTMLElement>('#work-view')!.hidden = true; void refreshUsage(); setInterval(() => { if (!document.hidden) void refreshUsage() },15000) } }
