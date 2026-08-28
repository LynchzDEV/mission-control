import { anime, getJson, markFixture, readRecord, token } from './shared'

type StageState = 'done' | 'active' | 'queued' | 'future'
type Stage = [StageState, string]
type SessionFlow = Record<string, Stage>

const STAGES = ['spec', 'impl', 'codex', 'verify', 'merged'] as const

const FIXTURE_SESSIONS: Record<string, SessionFlow> = {
  'moni-audio-v2': {
    spec: ['done', 'CLAUDE'],
    impl: ['done', 'GLM · wt/moni-audio'],
    codex: ['queued', 'CODEX · QUEUED'],
    verify: ['active', 'CLAUDE · NOW · 4m'],
    merged: ['future', ''],
  },
  'orders-export-fix': {
    spec: ['done', 'CLAUDE'],
    impl: ['active', 'GLM · 26m · wt/orders-export'],
    codex: ['queued', 'CODEX · QUEUED'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
  'campaign-occasions': {
    spec: ['done', 'CLAUDE'],
    impl: ['active', 'GLM · 11m · wt/campaign-ai'],
    codex: ['future', 'CODEX'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
  'lead-csv-import': {
    spec: ['done', 'CLAUDE'],
    impl: ['active', 'GLM · 2m · wt/lead-csv'],
    codex: ['future', 'CODEX'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
  'hermez-fb-retry': {
    spec: ['active', 'CLAUDE · NOW · 12m'],
    impl: ['future', 'GLM'],
    codex: ['future', 'CODEX'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
}

const PULSE = {
  boxShadow: [
    '0 0 0 0 rgba(51,255,102,0)',
    '0 0 0 3px rgba(51,255,102,.15)',
    '0 0 0 0 rgba(51,255,102,0)',
  ],
  duration: 2200,
  loop: true,
  ease: 'inOutSine',
}

let SESSIONS: Record<string, SessionFlow> = FIXTURE_SESSIONS
let CUR = 'moni-audio-v2'

function parseSessions(raw: unknown): Record<string, SessionFlow> | null {
  const record = readRecord(raw)
  const parsed: Record<string, SessionFlow> = {}
  for (const [key, value] of Object.entries(record)) {
    const stages = readRecord(value)
    const session: SessionFlow = {}
    for (const stage of STAGES) {
      const pair = stages[stage]
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') return null
      session[stage] = [pair[0] as StageState, typeof pair[1] === 'string' ? pair[1] : '']
    }
    parsed[key] = session
  }
  return Object.keys(parsed).length === 0 ? null : parsed
}

export function setSession(k: string): void {
  const d = SESSIONS[k]
  if (d === undefined) return
  CUR = k
  const A = anime()
  for (const st of STAGES) {
    const nd = document.getElementById('nd-' + st)
    const lc = document.getElementById('lc-' + st)
    if (nd === null || lc === null) continue
    nd.className = 'node ' + d[st]![0]
    nd.style.boxShadow = ''
    if (st !== 'merged') lc.textContent = d[st]![1] || (lc.textContent ?? '').split(' ·')[0]!
  }
  document
    .querySelectorAll<HTMLElement>('#chips .chip')
    .forEach((c) => c.classList.toggle('on', c.dataset.s === k))
  if (A !== null) {
    A.animate('.node', { opacity: { from: 0.2 }, duration: 350, ease: 'outQuad' })
    A.animate('.node.active', PULSE)
  }
  drawFlow()
}

function buildChips(): void {
  const chips = document.getElementById('chips')
  if (chips === null) return
  chips.textContent = ''
  Object.keys(SESSIONS).forEach((k) => {
    const c = document.createElement('span')
    c.className = 'chip'
    c.dataset.s = k
    c.textContent = k
    c.onclick = () => setSession(k)
    chips.appendChild(c)
  })
}

export function drawFlow(): void {
  const svg = document.getElementById('fsvg')
  if (svg === null) return
  const box = svg.getBoundingClientRect()
  svg.querySelectorAll('.edge').forEach((e) => e.remove())
  const R = (id: string) => {
    const node = document.getElementById(id)
    const r = (node as HTMLElement).getBoundingClientRect()
    return {
      l: r.left - box.left,
      r: r.right - box.left,
      t: r.top - box.top,
      b: r.bottom - box.top,
      cy: r.top - box.top + r.height / 2,
      cx: r.left - box.left + r.width / 2,
    }
  }
  if (document.getElementById('nd-spec') === null) return
  const S = R('nd-spec'),
    I = R('nd-impl'),
    C = R('nd-codex'),
    V = R('nd-verify'),
    M = R('nd-merged')
  const mk = (d: string, stroke: string, dash: number, marker: string, op?: string) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', d)
    p.setAttribute('stroke', stroke)
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke-width', '1.5')
    if (dash) p.setAttribute('stroke-dasharray', '5 4')
    p.setAttribute('marker-end', 'url(#' + marker + ')')
    if (op) p.setAttribute('opacity', op)
    p.classList.add('edge')
    svg.appendChild(p)
    return p
  }
  const edge = token('--mc-edge')
  const edgeDim = token('--mc-edge-dim')
  const amber = token('--mc-amber')
  const edges = [
    mk(`M ${S.r} ${S.cy} L ${I.l - 6} ${I.cy}`, edge, 0, 'ar'),
    mk(`M ${I.r} ${I.cy} L ${V.l - 6} ${V.cy}`, edge, 0, 'ar'),
    mk(
      `M ${I.r - 20} ${I.t} C ${I.r + 30} ${C.cy}, ${C.l - 60} ${C.cy}, ${C.l - 6} ${C.cy}`,
      amber,
      1,
      'arA',
    ),
    mk(
      `M ${C.l + 20} ${C.b} C ${C.l - 10} ${C.b + 40}, ${V.cx - 40} ${V.t - 20}, ${V.cx} ${V.t - 6}`,
      edgeDim,
      1,
      'ar',
    ),
    mk(`M ${V.r} ${V.cy} L ${M.l - 6} ${M.cy}`, edgeDim, 0, 'ar', '.5'),
  ]
  const A = anime()
  edges.forEach((p, i) => {
    const L = p.getTotalLength()
    if (!p.getAttribute('stroke-dasharray')) {
      p.setAttribute('stroke-dasharray', String(L))
      p.setAttribute('stroke-dashoffset', String(L))
      if (A !== null) {
        A.animate(p, { strokeDashoffset: [L, 0], duration: 700, delay: 350 + i * 140, ease: 'outQuad' })
      }
    }
  })
}

async function hydrate(): Promise<void> {
  const result = await getJson('/api/flow')
  const parsed = result.ok ? parseSessions(result.data.sessions) : null
  if (parsed === null) {
    markFixture('flow', true)
  } else {
    SESSIONS = parsed
    const current = result.data.current
    if (typeof current === 'string' && parsed[current] !== undefined) CUR = current
    markFixture('flow', result.data.source === 'placeholder')
  }
  buildChips()
  setSession(CUR)
}

export function installFlow(): void {
  if (document.getElementById('fsvg') === null) return
  const A = anime()
  if (A !== null) {
    A.animate('.node', {
      opacity: { from: 0 },
      translateY: [8, 0],
      delay: A.stagger(90, { start: 200 }),
      duration: 500,
      ease: 'outExpo',
    })
    A.animate('.node.active', PULSE)
  }
  document
    .querySelectorAll<HTMLElement>('.task[data-s]')
    .forEach((el) => (el.onclick = () => setSession(el.dataset.s ?? '')))
  void hydrate()
  addEventListener('resize', () => drawFlow())
}

installFlow()
