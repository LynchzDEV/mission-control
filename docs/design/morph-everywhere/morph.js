export const EASE = 'cubic-bezier(.2, .8, .2, 1)'
export const DURATION = 240
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

export function morph(el, apply) {
  if (reduced) { apply(); return }
  const before = el.getBoundingClientRect()
  const oldStyle = { background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, radius: getComputedStyle(el).borderRadius }
  apply()
  const after = el.getBoundingClientRect()
  const now = getComputedStyle(el)
  el.classList.add('morphing')
  el.animate([
    { width: `${before.width}px`, height: `${before.height}px`, backgroundColor: oldStyle.background, color: oldStyle.color, borderRadius: oldStyle.radius },
    { width: `${after.width}px`, height: `${after.height}px`, backgroundColor: now.backgroundColor, color: now.color, borderRadius: now.borderRadius },
  ], { duration: DURATION, easing: EASE }).onfinish = () => el.classList.remove('morphing')
  for (const child of el.children) child.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: DURATION, easing: EASE })
}

export function grow(el, show) {
  if (reduced) { el.hidden = !show; return }
  if (show) {
    el.hidden = false
    el.animate([{ opacity: 0, transform: 'scale(.92)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: DURATION, easing: EASE })
  } else {
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: DURATION * .75, easing: EASE }).onfinish = () => { el.hidden = true }
  }
}

const esc = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export function card({ area, title, source, how, markup, states, labels, shipped = false }) {
  const section = document.createElement('section')
  section.className = 'card'
  section.dataset.area = area
  section.innerHTML = `<header><span class="area">${esc(area)}</span><h3>${esc(title)}${shipped ? ' <em>shipped</em>' : ''}</h3><code>${esc(source)}</code></header>
    <div class="pair"><div class="side"><h4>Now</h4><div class="demo" data-side="now">${markup}</div></div><div class="side"><h4>Morph</h4><div class="demo" data-side="morph">${markup}</div></div></div>
    <p class="how">${how}</p><footer><button type="button" class="play">Play both</button><span class="step"></span></footer>`
  let index = 0
  const sides = [...section.querySelectorAll('.demo')]
  const stepLabel = section.querySelector('.step')
  const paint = () => { stepLabel.textContent = labels ? `${index + 1} / ${states.length} · ${labels[index]}` : '' }
  const go = (next, animate = true) => {
    index = next % states.length
    for (const demo of sides) states[index](demo, animate && demo.dataset.side === 'morph', demo.dataset.side)
    paint()
  }
  for (const demo of sides) demo.addEventListener('click', (event) => { if (event.target.closest('button, input, .tap')) go(index + 1) })
  let playing = 0
  section.querySelector('.play').onclick = () => {
    clearInterval(playing)
    go(0)
    let count = 0
    playing = setInterval(() => { count += 1; go(index + 1); if (count >= states.length) clearInterval(playing) }, 1300)
  }
  go(0, false)
  return section
}
