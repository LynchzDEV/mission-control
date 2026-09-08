import { getJson, readNumber } from './shared'

const ROUTES = new Set(['/lanes', '/dispatch', '/review', '/settings', '/terminals', '/'])
const TITLES: Record<string, string> = { '/lanes': 'Main', '/dispatch': 'Dispatch', '/review': 'Review', '/settings': 'Settings' }
export function routeUrl(path: string, preview = location.pathname.startsWith('/ui-preview/')): string {
  if (!preview) return path
  const url = new URL(path, location.origin)
  const embedded = url.searchParams.get('embed') === '1' && url.pathname !== '/terminals'
  return `/ui-preview/${url.pathname === '/' ? 'terminals' : url.pathname.slice(1)}${embedded ? '-content' : ''}.html${url.search}${url.hash}`
}

function logicalPath(): string {
  return location.pathname.replace(/^\/ui-preview\//, '/').replace(/\.html$/, '')
}

function installMotion(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#ascii-horizon')
  if (!canvas) return
  const context = canvas.getContext('2d')
  if (!context) return
  const control = document.querySelector<HTMLButtonElement>('#motion-toggle')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let paused = false
  try { paused = localStorage.getItem('mc.motion.paused') === '1' } catch {}
  let frame = 0
  let phase = 0
  let last = 0
  const paint = (now: number): void => {
    const bounds = canvas.getBoundingClientRect()
    const scale = Math.min(devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(bounds.width * scale) || canvas.height !== Math.round(bounds.height * scale)) {
      canvas.width = Math.round(bounds.width * scale)
      canvas.height = Math.round(bounds.height * scale)
    }
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.clearRect(0, 0, bounds.width, bounds.height)
    context.font = `12px ${getComputedStyle(canvas).fontFamily}`
    context.fillStyle = getComputedStyle(canvas).color
    const chars = ' .,:;+=*#'
    for (let y = 0; y < bounds.height; y += 13) {
      for (let x = 0; x < bounds.width; x += 10) {
        const u = x / bounds.width, v = (y + bounds.top + 55) / Math.min(270, innerHeight * .33)
        const center = .99 - .38 * u + .12 * Math.sin(u * 6.4 - phase * .38)
        const distance = (v - center) / (.15 + .05 * Math.sin(u * 4 + phase * .22))
        if (Math.abs(distance) > 1.45) continue
        const envelope = Math.pow(Math.max(0, 1 - Math.abs(distance) / 1.45), .7)
        const fold = Math.sin(distance * 13 + u * 9 - phase * .65 + 1.7 * Math.sin(u * 7 + phase * .3))
        const density = envelope * (.16 + .84 * Math.pow((fold + 1) / 2, 2))
        if (density < .12) continue
        const shade = Math.round(42 + density * 115)
        context.fillStyle = `rgb(${shade},${shade},${shade + 3})`
        context.globalAlpha = 1
        context.fillText(chars[Math.min(chars.length - 1, Math.floor(density * (chars.length - 1)))]!, x, y)
      }
    }
    if (!paused && !reduced.matches && !document.hidden) {
      phase += Math.min(50, now - (last || now)) * 0.00045
      last = now
      frame = requestAnimationFrame(paint)
    }
  }
  const sync = (): void => {
    cancelAnimationFrame(frame)
    last = 0
    document.body.dataset.motion = paused || reduced.matches ? 'paused' : 'running'
    if (control) { control.textContent = reduced.matches ? 'Reduced motion' : paused ? 'Play motion' : 'Pause motion'; control.disabled = reduced.matches; control.setAttribute('aria-pressed', String(paused || reduced.matches)) }
    paint(performance.now())
  }
  control?.addEventListener('click', () => { paused = !paused; try { localStorage.setItem('mc.motion.paused', paused ? '1' : '0') } catch {}; sync() })
  reduced.addEventListener('change', sync)
  document.addEventListener('visibilitychange', sync)
  new ResizeObserver(sync).observe(canvas)
  sync()
}

function installWorkspace(): void {
  const embedded = window.parent !== window && new URLSearchParams(location.search).get('embed') === '1'
  if (embedded) document.documentElement.classList.add('embedded-view')
  const deck = document.querySelector<HTMLElement>('#termgrid')
  const body = document.querySelector<HTMLElement>('.body')
  const preview = location.pathname.startsWith('/ui-preview/')
  const frames = new Map<string, HTMLIFrameElement>()
  const navigate = (href: string, push = true): void => {
    const url = new URL(href, location.origin)
    if (url.origin !== location.origin || !ROUTES.has(url.pathname)) return
    const terminal = url.pathname === '/terminals' || url.pathname === '/'
    if (!deck || !body) { location.assign(routeUrl(`${url.pathname}${url.search}`)); return }
    const key = `${url.pathname}${url.search}`
    deck.hidden = !terminal
    for (const iframe of frames.values()) iframe.hidden = true
    if (!terminal) {
      let iframe = frames.get(key)
      if (!iframe) {
        iframe = document.createElement('iframe')
        iframe.className = 'workspace-view'
        iframe.title = url.searchParams.get('view') === 'usage' ? 'Provider usage' : TITLES[url.pathname] ?? 'Workspace view'
        url.searchParams.set('embed', '1')
        iframe.src = routeUrl(`${url.pathname}${url.search}`, preview)
        frames.set(key, iframe)
        body.append(iframe)
      }
      iframe.hidden = false
      if (push && url.pathname === '/dispatch') iframe.contentWindow?.postMessage({ type: 'mc:new-job' }, location.origin)
    }
    if (push) history.pushState({}, '', routeUrl(key, preview))
    document.querySelectorAll<HTMLAnchorElement>('#tabs a').forEach((link) => {
      const target = new URL(link.href)
      const active = target.pathname === (terminal ? '/terminals' : url.pathname) && target.searchParams.get('view') === url.searchParams.get('view')
      link.classList.toggle('on', active)
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current')
    })
    document.title = `Mission Control — ${terminal ? 'Terminals' : url.searchParams.get('view') === 'usage' ? 'Usage' : TITLES[url.pathname]}`
    if (terminal) dispatchEvent(new Event('mc:workspace-visible'))
  }
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
    const url = new URL(anchor.href)
    if (url.origin !== location.origin || !ROUTES.has(url.pathname)) return
    event.preventDefault()
    const path = `${url.pathname}${url.search}${url.hash}`
    if (embedded) parent.postMessage({ type: 'mc:navigate', path }, location.origin)
    else navigate(path)
  })
  addEventListener('mc:navigate', (event) => {
    const path = (event as CustomEvent<string>).detail
    if (embedded) parent.postMessage({ type: 'mc:navigate', path }, location.origin)
    else navigate(path)
  })
  addEventListener('message', (event) => {
    if (event.origin !== location.origin || ![...frames.values()].some((frame) => frame.contentWindow === event.source)) return
    if (event.data?.type === 'mc:settings-saved') { dispatchEvent(new Event('mc:settings-refresh')); for (const frame of frames.values()) frame.contentWindow?.postMessage({ type: 'mc:settings-refresh' }, location.origin) }
    if (event.data?.type === 'mc:navigate' && typeof event.data.path === 'string') navigate(event.data.path)
  })
  addEventListener('popstate', () => navigate(`${logicalPath()}${location.search}`, false))
  if (deck && !embedded) navigate(`${logicalPath()}${location.search}`, false)
  if (new URLSearchParams(location.search).get('view') === 'usage') document.documentElement.classList.add('usage-view')
  const refreshAttention = async (): Promise<void> => {
    if (embedded || document.hidden) return
    const result = await getJson('/api/meta')
    const count = document.querySelector('#global-attention span')
    if (count) count.textContent = result.ok ? String(readNumber(result.data.reviewCount) ?? 0) : '—'
  }
  if (document.querySelector('#global-attention')) { void refreshAttention(); setInterval(() => void refreshAttention(), 15000) }
  installMotion()
}

if (typeof document !== 'undefined') installWorkspace()
