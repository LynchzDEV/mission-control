import { anime, getJson, markFixture, readArray, readNumber, readRecord, text } from './shared'

type Counter = { v: number }

const FIXTURE = { claudeMTok: 1.84, claudeBlockPct: 88, glmPct: 41, tokensPerMin: 12.4 }

function rollTo(id: string, value: number, digits: number, duration = 1100): void {
  const el = document.getElementById(id)
  if (el === null) return
  const A = anime()
  if (A === null) {
    el.textContent = value.toFixed(digits)
    return
  }
  const counter: Counter = { v: 0 }
  A.animate(counter, {
    v: value,
    duration,
    ease: 'outExpo',
    onUpdate: () => (el.textContent = counter.v.toFixed(digits)),
  })
}

function fillTo(id: string, percent: number, delay: number): void {
  const el = document.getElementById(id)
  if (el === null) return
  const width = `${Math.max(0, Math.min(100, percent))}%`
  const A = anime()
  if (A === null) {
    el.style.width = width
    return
  }
  A.animate(`#${id}`, { width, duration: 1000, delay, ease: 'outExpo' })
}

function entrance(): void {
  const A = anime()
  if (A === null) {
    document.querySelectorAll<HTMLElement>('.rack, .task').forEach((el) => (el.style.opacity = '1'))
    return
  }
  A.animate('.rack', {
    opacity: [0, 1],
    translateY: [16, 0],
    delay: A.stagger(120),
    duration: 600,
    ease: 'outExpo',
  })
  A.animate('.task', {
    opacity: [0, 1],
    translateX: [-8, 0],
    delay: A.stagger(80, { start: 500 }),
    duration: 450,
    ease: 'outExpo',
  })
}

function paintFixture(): void {
  rollTo('n1', FIXTURE.claudeMTok, 2)
  rollTo('n2', FIXTURE.glmPct, 0)
  rollTo('tpm', FIXTURE.tokensPerMin, 1, 900)
  fillTo('b1', FIXTURE.claudeBlockPct, 250)
  fillTo('b2', FIXTURE.glmPct, 350)
}

function paintClaude(claude: Record<string, unknown>): void {
  const tokens = readNumber(claude.tokens)
  const percent = readNumber(claude.blockPercent) ?? readNumber(claude.percent)
  rollTo('n1', tokens === null ? FIXTURE.claudeMTok : tokens / 1_000_000, 2)
  if (percent !== null) text('#n1pct', String(Math.round(percent)))
  fillTo('b1', percent ?? (tokens !== null ? 0 : FIXTURE.claudeBlockPct), 250)
  if (claude.available === false) text('#k-claude-auth', 'NO DATA')
}

function paintGlm(glm: Record<string, unknown>, peak: Record<string, unknown>): void {
  const percent = readNumber(glm.fiveHourPct) ?? readNumber(glm.percent) ?? readNumber(glm.usedPercent)
  rollTo('n2', percent ?? FIXTURE.glmPct, 0)
  fillTo('b2', percent ?? FIXTURE.glmPct, 350)
  const minutes = readNumber(peak.minutesToChange)
  const label = peak.peak === true ? 'PEAK x2' : 'OFF-PEAK'
  text('#n2peak', minutes === null ? label : `${label} ${minutes}m`)
}

function paintCodex(codex: Record<string, unknown>): void {
  const authed = codex.authed === true
  text('#n3', authed ? 'AUTH OK' : 'AUTH FAIL')
  text('#n3sub', authed ? 'codex login status → 0' : 'login status → exit 1')
  const big = document.getElementById('n3')
  if (big !== null) big.className = authed ? 'big c-white sm' : 'big c-red sm'
}

async function paintExternal(): Promise<void> {
  const external = await getJson('/api/sessions/external')
  if (!external.ok) return
  const sessions = readArray(external.data.sessions ?? external.data)
  const cell = document.getElementById('k-claude-live')
  if (cell === null) return
  const parts = (cell.textContent ?? '').split('/')
  if (parts.length !== 3) return
  cell.textContent = `${parts[0]!.trim()} / ${parts[1]!.trim()} / ${sessions.length}`
}

async function hydrate(): Promise<void> {
  const quota = await getJson('/api/quota')
  if (!quota.ok) {
    markFixture('quota', true)
    paintFixture()
    return
  }
  markFixture('quota', false)
  rollTo('tpm', FIXTURE.tokensPerMin, 1, 900)
  paintClaude(readRecord(quota.data.claude))
  paintGlm(readRecord(quota.data.glm), readRecord(quota.data.peak))
  paintCodex(readRecord(quota.data.codex))
  void paintExternal()
}

export function installLanes(): void {
  if (document.querySelector('.racks') === null) return
  entrance()
  markFixture('meta', true)
  void hydrate()
}

installLanes()
