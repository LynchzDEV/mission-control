type Grid = { cols: number; rows: number }

type Sketch = {
  grid: Grid
  frameCount: number
  background(value: number): void
  push(): void
  pop(): void
  charColor(r: number, g: number, b: number): void
  char(value: string): void
  translate(x: number, y: number): void
  point(): void
  filter(name: string, options: Record<string, number>): void
  draw(loop: () => void): void
}

type TextmodeNamespace = {
  create?(options: Record<string, unknown>): Sketch
  textmode?: { create(options: Record<string, unknown>): Sketch }
}

declare const window: Window & {
  textmode?: TextmodeNamespace
  FiltersPlugin?: { install?: unknown; FiltersPlugin?: unknown }
}

const HEAD_HEIGHT = 150

export function tm(canvas: HTMLCanvasElement, fontSize: number, w: number, h: number): Sketch | null {
  const NS = window.textmode
  if (!NS || !canvas) return null
  const TM = NS.create ? NS : NS.textmode || null
  if (!TM) return null
  const FPNS = window.FiltersPlugin
  const FP = FPNS && (FPNS.install ? FPNS : FPNS.FiltersPlugin)
  canvas.width = w
  canvas.height = h
  try {
    return (TM as { create(options: Record<string, unknown>): Sketch }).create({
      canvas,
      plugins: FP ? [FP] : [],
      fontSize,
      frameRate: 30,
      loadingScreen: { transition: 'none', transitionDuration: 0 },
    })
  } catch {
    return null
  }
}

export function cell(
  t: Sketch,
  x: number,
  y: number,
  ch: string,
  r: number,
  g: number,
  b: number,
): void {
  if (x < 0 || x >= t.grid.cols || y < 0 || y >= t.grid.rows) return
  t.push()
  t.charColor(r, g, b)
  t.char(ch)
  t.translate(x - (t.grid.cols >> 1), y - (t.grid.rows >> 1))
  t.point()
  t.pop()
}

function mk(id: string, sketch: (t: Sketch) => void): void {
  const c = document.getElementById(id) as HTMLCanvasElement | null
  if (c === null || c.parentElement === null) return
  const w = c.parentElement.clientWidth
  const t = tm(c, 12, w, HEAD_HEIGHT)
  if (t) t.draw(() => sketch(t))
}

export function sketchIdle(t: Sketch): void {
  t.background(0)
  const f = t.frameCount,
    cx = (t.grid.cols - 1) / 2,
    cy = (t.grid.rows - 1) / 2,
    c = [217, 119, 87]
  const breathe = 2.3 + 1 * Math.sin(f * 0.035)
  const ramp = '.:+*x#'
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2 + f * 0.004
    const r = breathe + 0.5 * Math.sin(a * 1.7 + f * 0.02)
    const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(a * 0.9 + f * 0.06))
    cell(
      t,
      Math.round(cx + Math.cos(ang) * r * 1.4),
      Math.round(cy + Math.sin(ang) * r),
      ramp[Math.min(5, Math.floor(k * 5))] as string,
      c[0]! * k,
      c[1]! * k,
      c[2]! * k,
    )
  }
  cell(t, Math.round(cx), Math.round(cy), f % 40 < 24 ? '#' : '+', 245, 245, 240)
  t.filter('bloom', { intensity: 0.38 })
  t.filter('scanlines', { intensity: 0.14 })
  t.filter('filmGrain', { intensity: 0.06 })
}

export function sketchRain(t: Sketch): void {
  t.background(0)
  const f = t.frameCount,
    cols = t.grid.cols,
    rows = t.grid.rows
  const glyphs = '01<>{}[]()=+*/\\|;:.#$%&'
  for (let x = 0; x < cols; x++) {
    const speed = 0.18 + 0.5 * (((Math.sin(x * 12.9898) * 43758.5453) % 1 + 1) % 1)
    const head = ((f * speed + x * 3.7) % (rows + 6)) - 3
    for (let d = 0; d < 6; d++) {
      const y = Math.round(head - d)
      if (y < 0 || y >= rows) continue
      const k = d === 0 ? 1 : Math.max(0.12, 0.75 - d * 0.16)
      const ch = glyphs[(x * 7 + y * 13 + Math.floor(f / 4)) % glyphs.length] as string
      cell(t, x, y, d === 0 ? '#' : ch, 51 * k + (d === 0 ? 120 : 0), 204 * k, 255 * k)
    }
  }
  t.filter('bloom', { intensity: 0.3 })
  t.filter('scanlines', { intensity: 0.12 })
  t.filter('filmGrain', { intensity: 0.05 })
}

export function sketchRadar(t: Sketch): void {
  t.background(0)
  const f = t.frameCount,
    cols = t.grid.cols,
    rows = t.grid.rows
  const cx = (cols - 1) / 2,
    cy = (rows - 1) / 2,
    R = Math.min(cx, cy) - 0.5
  const ang = f * 0.03
  for (let i = 0; i < 3; i++) {
    const a = ang - i * 0.16,
      k = 1 - i * 0.38
    for (let r = 0; r < R; r += 0.5)
      cell(
        t,
        Math.round(cx + Math.cos(a) * r * 1.9),
        Math.round(cy + Math.sin(a) * r),
        i === 0 ? '#' : ':',
        245 * k,
        245 * k,
        240 * k,
      )
  }
  for (let a = 0; a < 20; a++) {
    const th = (a / 20) * Math.PI * 2
    cell(t, Math.round(cx + Math.cos(th) * R * 1.9), Math.round(cy + Math.sin(th) * R), '.', 90, 90, 98)
  }
  const blips = [
    [0.9, 2.1],
    [2.4, 3.4],
    [4.4, 1.2],
    [5.5, 2.9],
  ]
  blips.forEach(([ba, br]) => {
    const d = (((ang - ba!) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    const k = Math.max(0, 1 - d * 0.9)
    if (k <= 0.05) return
    cell(
      t,
      Math.round(cx + Math.cos(ba!) * br! * 1.9),
      Math.round(cy + Math.sin(ba!) * br!),
      '@',
      255 * k,
      176 * k,
      0,
    )
  })
  t.filter('bloom', { intensity: 0.35 })
  t.filter('scanlines', { intensity: 0.14 })
  t.filter('filmGrain', { intensity: 0.06 })
}

export function installMascots(): void {
  mk('m1', sketchIdle)
  mk('m2', sketchRain)
  mk('m3', sketchRadar)
}

installMascots()
