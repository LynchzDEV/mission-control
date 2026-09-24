const VISIBLE = 3
const PAUSE_MS = 5000
const PIXELS_PER_SECOND = 14

const track = document.getElementById('usage-track')
const viewport = track.parentElement
let animation = null

function start() {
  animation?.cancel()
  animation = null
  const { paddingLeft, paddingRight } = getComputedStyle(viewport)
  const distance = track.scrollWidth - (viewport.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight))
  if (track.children.length <= VISIBLE || distance <= 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const travel = (distance / PIXELS_PER_SECOND) * 1000
  const total = travel * 2 + PAUSE_MS * 2
  const at = ms => ms / total
  animation = track.animate([
    { transform: 'translateX(0)', offset: 0, easing: 'ease-in-out' },
    { transform: `translateX(${-distance}px)`, offset: at(travel) },
    { transform: `translateX(${-distance}px)`, offset: at(travel + PAUSE_MS), easing: 'ease-in-out' },
    { transform: 'translateX(0)', offset: at(travel * 2 + PAUSE_MS) },
    { transform: 'translateX(0)', offset: 1 },
  ], { duration: total, iterations: Infinity })
}

viewport.addEventListener('mouseenter', () => animation?.pause())
viewport.addEventListener('mouseleave', () => animation?.play())
viewport.addEventListener('focusin', () => animation?.pause())
viewport.addEventListener('focusout', () => animation?.play())
new ResizeObserver(start).observe(viewport)
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', start)
