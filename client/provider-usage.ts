import { getJson, readRecord } from './shared'
export type QuotaWindow = { percent: number | null; reset: string | null; estimate: boolean }
export type ProviderUsage = { provider: string; fiveHour: QuotaWindow; weekly: QuotaWindow; reason: string }
const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
const reset = (value: unknown): string | null => typeof value === 'string' && value ? value : null
export function normalizeUsage(provider: string, raw: unknown): ProviderUsage {
  const data = readRecord(raw), available = data.available === true
  const reported = available ? percent(data.fiveHourPct) : null
  const fallback = available && provider === 'claude' ? percent(data.blockPercent) : null
  return { provider, fiveHour: { percent: reported ?? fallback, estimate: reported === null && fallback !== null, reset: reset(data.fiveHourResetsAt) ?? (reported === null && fallback !== null ? reset(data.resetsAt) : null) }, weekly: { percent: available ? percent(data.weeklyPct) : null, reset: reset(data.weeklyResetsAt), estimate: false }, reason: data.source === 'ccstatusline cache' ? `Cached usage · observed ${typeof data.observedAt === 'string' ? data.observedAt : 'time unavailable'}` : typeof data.reason === 'string' ? data.reason : reported === null && fallback !== null ? 'ccusage estimate' : '' }
}
export const weeklyOnly = (provider: string): boolean => provider === 'codex'
function meter(window: QuotaWindow, label: string): HTMLElement {
  if (window.percent === null) { const track = document.createElement('span'); track.className = 'quota-track'; track.setAttribute('role', 'img'); track.setAttribute('aria-label', `${label}: unavailable`); return track }
  const result = document.createElement('meter'); result.min = 0; result.max = 100; result.value = window.percent
  result.setAttribute('aria-label', `${label}: ${window.percent}%${window.estimate ? ' estimate' : ''}`)
  result.title = window.reset ? `Resets ${window.reset}` : 'Reset unavailable'
  return result
}
export function renderUsage(host: HTMLElement, values: ProviderUsage[]): void {
  host.replaceChildren()
  for (const data of values) {
    const section = document.createElement('section'); section.className = 'provider-usage'; section.title = data.reason || (data.fiveHour.percent === null && data.weekly.percent === null ? 'Usage unavailable' : '')
    section.dataset.unavailable = String(data.fiveHour.percent === null && data.weekly.percent === null)
    const heading = document.createElement('div'); heading.className = 'quota-heading'
    const name = document.createElement('span'); name.className = 'quota-provider'; name.textContent = data.provider === 'glm' ? 'GLM' : data.provider[0]!.toUpperCase() + data.provider.slice(1)
    const single = weeklyOnly(data.provider), primary = single ? data.weekly : data.fiveHour
    const period = document.createElement('span'); period.className = 'quota-period'; period.textContent = single ? 'Weekly' : data.fiveHour.estimate ? '5h est.' : '5h'
    const value = document.createElement('strong'); value.textContent = primary.percent === null ? '—' : String(Math.round(primary.percent))
    if (primary.percent !== null) { const unit = document.createElement('small'); unit.textContent = '%'; value.append(unit) }
    heading.append(name, period, value)
    section.append(heading, meter(primary, `${name.textContent} ${single ? 'weekly' : '5-hour'} usage${primary.estimate ? ' (ccusage estimate)' : ''}`))
    if (single) { host.append(section); continue }
    const weekly = document.createElement('div'); weekly.className = 'quota-week'
    const label = document.createElement('span'); label.textContent = 'Weekly'
    const weekValue = document.createElement('span'); weekValue.className = 'week-value'; weekValue.textContent = data.weekly.percent === null ? '—' : `${Math.round(data.weekly.percent)}%`
    weekly.append(label, meter(data.weekly, `${name.textContent} weekly usage`), weekValue)
    section.append(weekly)
    host.append(section)
  }
}
async function refresh(): Promise<void> {
  const host = document.querySelector<HTMLElement>('#provider-summary')
  if (!host || document.hidden) return
  const result = await getJson('/api/quota')
  renderUsage(host, ['claude','glm','codex'].map(provider => normalizeUsage(provider, result.ok ? result.data[provider] : null)))
}
if (typeof document !== 'undefined' && document.querySelector('#provider-summary')) { void refresh(); setInterval(() => void refresh(), 15000) }
