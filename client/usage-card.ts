import { getJson, readArray } from './shared'
import { normalizeUsage, weeklyOnly, type ProviderUsage } from './provider-usage'

const VISIBLE = 3, PAUSE_MS = 5000, PIXELS_PER_SECOND = 14
const BUILTINS = ['claude', 'glm', 'codex']

export type UsageItem = { provider: string; name: string; logo: string; period: '5h' | 'Week'; primary: string; primaryPercent: number | null; weekly: string | null; weeklyPercent: number | null; unavailable: boolean }

const label = (percent: number | null): string => percent === null ? '—' : `${Math.round(percent)}%`

export function usageItems(values: ProviderUsage[]): UsageItem[] {
  return values.map(data => {
    const single = weeklyOnly(data.provider), primary = single ? data.weekly : data.fiveHour
    return {
      provider: data.provider,
      name: data.provider === 'glm' ? 'GLM' : data.provider[0]!.toUpperCase() + data.provider.slice(1),
      logo: `/providers/${data.provider}.svg`,
      period: single ? 'Week' : '5h',
      primary: label(primary.percent), primaryPercent: primary.percent,
      weekly: single ? null : label(data.weekly.percent), weeklyPercent: single ? null : data.weekly.percent,
      unavailable: primary.percent === null && data.weekly.percent === null,
    }
  })
}

export function cycleMs(distance: number, pps = PIXELS_PER_SECOND): number {
  return (distance / pps) * 1000 * 2 + PAUSE_MS * 2
}

export function scrollPlan(distance: number, pps = PIXELS_PER_SECOND): Keyframe[] {
  const travel = (distance / pps) * 1000, total = cycleMs(distance, pps), at = (ms: number) => ms / total
  return [
    { transform: 'translateX(0)', offset: 0, easing: 'ease-in-out' },
    { transform: `translateX(${-distance}px)`, offset: at(travel) },
    { transform: `translateX(${-distance}px)`, offset: at(travel + PAUSE_MS), easing: 'ease-in-out' },
    { transform: 'translateX(0)', offset: at(travel * 2 + PAUSE_MS) },
    { transform: 'translateX(0)', offset: 1 },
  ]
}

function meter(value: number | null): HTMLMeterElement {
  const el = document.createElement('meter'); el.min = 0; el.max = 100; el.value = value ?? 0; return el
}

export function renderUsageCard(track: HTMLElement, values: ProviderUsage[]): void {
  track.replaceChildren(...usageItems(values).map(item => {
    const root = document.createElement('div'); root.className = 'usage-item'; root.dataset.provider = item.provider; root.dataset.unavailable = String(item.unavailable)
    const head = document.createElement('div'); head.className = 'usage-head'
    const logo = document.createElement('img'); logo.src = item.logo; logo.alt = ''
    const name = document.createElement('span'); name.textContent = item.name
    const period = document.createElement('small'); period.textContent = item.period
    const value = document.createElement('strong'); value.textContent = item.primary
    head.append(logo, name, period, value)
    root.append(head, meter(item.primaryPercent))
    if (item.weekly !== null) {
      const week = document.createElement('div'); week.className = 'usage-week'
      const weekLabel = document.createElement('span'); weekLabel.textContent = 'Week'
      const weekValue = document.createElement('span'); weekValue.textContent = item.weekly
      week.append(weekLabel, meter(item.weeklyPercent), weekValue); root.append(week)
    }
    return root
  }))
}

type Scroll = { animation: Animation | null; key: string }

function startScroll(track: HTMLElement, viewport: HTMLElement, current: Scroll): void {
  const { paddingLeft, paddingRight } = getComputedStyle(viewport)
  const distance = track.scrollWidth - (viewport.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight))
  const wanted = viewport.clientWidth > 0 && track.children.length > VISIBLE && distance > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches
  const key = wanted ? `${track.children.length}:${Math.round(distance)}` : ''
  if (key === current.key && (current.animation !== null || !wanted)) return
  current.animation?.cancel(); current.animation = null; current.key = key
  if (!wanted) return
  current.animation = track.animate(scrollPlan(distance), { duration: cycleMs(distance), iterations: Infinity })
  if (viewport.matches(':hover, :focus-within')) current.animation.pause()
}

async function refresh(track: HTMLElement, viewport: HTMLElement, current: Scroll): Promise<void> {
  if (document.hidden) return
  const [quota, providers] = await Promise.all([getJson('/api/quota'), getJson('/api/providers')])
  const ids = providers.ok ? readArray(providers.data.providers).map(p => (p as { id: string }).id) : BUILTINS
  const withQuota = ids.filter(id => BUILTINS.includes(id) || (quota.ok && quota.data[id] !== undefined))
  renderUsageCard(track, withQuota.map(id => normalizeUsage(id, quota.ok ? quota.data[id] : null)))
  startScroll(track, viewport, current)
}

const track = typeof document === 'undefined' ? null : document.getElementById('usage-track')
if (track) {
  const viewport = track.parentElement as HTMLElement
  const current: Scroll = { animation: null, key: '' }
  viewport.addEventListener('mouseenter', () => current.animation?.pause())
  viewport.addEventListener('mouseleave', () => current.animation?.play())
  viewport.addEventListener('focusin', () => current.animation?.pause())
  viewport.addEventListener('focusout', () => current.animation?.play())
  new ResizeObserver(() => startScroll(track, viewport, current)).observe(viewport)
  void refresh(track, viewport, current)
  setInterval(() => void refresh(track, viewport, current), 15000)
}
