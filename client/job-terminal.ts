import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

import type { ThreadMessage } from './chat-view'
import { errorText, getJson } from './shared'
import { TERMINAL_FONT, terminalTheme } from './terminal-theme'
import { attachTouchScroll } from './terminal-touch'
import { toolCard } from './tool-cards'

export type JobScreen = { write(text: string): void; replace(text: string): void; reset(): void; size(): { cols: number; rows: number }; fit(): void; dispose(): void }
export type JobWatch = { jobId: string | null; title: string; engine: string }
export type JobTerminal = { show(watch: JobWatch): void; stop(): void; dispose(): void }

const ESC = '\x1b'
const paint = (code: string, text: string): string => `${ESC}[${code}m${text}${ESC}[0m`
const dim = (text: string): string => paint('2', text)
const red = (text: string): string => paint('31', text)
const PREVIEW_LINES = 3
const LINE_CHARS = 400
const REFRESH_MS = 250
const LONG_REFRESH_MS = 1000
const LONG_TRANSCRIPT_BLOCKS = 300
const TAB_WIDTH = 8
const NEWLINE = '\r\n'
const OWN_COLOURS = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const ESCAPE_SEQUENCES = new RegExp([
  `${ESC}\\[[0-?]*[ -/]*[@-~]`,
  `${ESC}[\\]PX^_][\\s\\S]*?(?:\\x07|${ESC}\\\\|$)`,
  `${ESC}[ -/]*[0-~]?`,
].join('|'), 'g')
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

export const JOB_TERMINAL_OPTIONS = { ...TERMINAL_FONT, disableStdin: true, screenReaderMode: true, cursorBlink: false, scrollback: 10000 }

export function inertText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ESCAPE_SEQUENCES, '').replace(CONTROLS, '')
}

const clip = (line: string): string => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line)
const crlf = (text: string): string => text.replace(/\n/g, NEWLINE)
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

function resultPreview(output: string, failed: boolean, running: boolean): string[] {
  if (running) return [dim('  ⎿  running…')]
  const lines = inertText(output).split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return [dim('  ⎿  (no output)')]
  const shown = lines.slice(0, PREVIEW_LINES).map((line, index) => `${index === 0 ? '  ⎿  ' : '     '}${clip(line)}`)
  const rest = lines.length - shown.length
  return [...shown.map(line => (failed ? red(line) : dim(line))), ...(rest > 0 ? [dim(`     … ${plural(rest, 'more line')}`)] : [])]
}

function toolBlock(message: Extract<ThreadMessage, { kind: 'tool' }>, running: boolean, index: number): string[] {
  const card = toolCard(message, running, index)
  const failed = card.status === 'failed'
  const target = inertText(card.target).replace(/\n/g, ' ')
  const command = card.command === null ? null : inertText(card.command).split('\n')[0] ?? ''
  const head = `${paint(failed ? '31' : '35', '●')} ${paint('1', inertText(card.verb))}${target === '' ? '' : ` ${target}`}`
  const commandLine = command !== null && command !== target ? [dim(`  $ ${clip(command)}`)] : []
  return [head, ...commandLine, ...resultPreview(card.output, failed, card.status === 'running')]
}

function lines(message: ThreadMessage, running: boolean, index: number): string[] {
  if (message.kind === 'prompt') return [dim(`Instructions sent to the agent · ${plural(message.text.split('\n').length, 'line')}`)]
  if (message.kind === 'text') return [crlf(inertText(message.text))]
  if (message.kind === 'tool') return toolBlock(message, running, index)
  if (message.kind === 'result') {
    const said = inertText(message.text).replace(/\n/g, ' ')
    return [message.isError ? red(`Stopped with an error · ${said}`) : paint('32', `Finished${said === '' ? '' : ` · ${said}`}`)]
  }
  return []
}

export function transcriptBlocks(messages: readonly ThreadMessage[], running = false): string[] {
  return messages.map((message, index) => lines(message, running, index)).filter(entry => entry.length > 0)
    .map((entry, index) => `${index === 0 ? '' : NEWLINE}${entry.join(NEWLINE)}${NEWLINE}`)
}

export function jobTranscript(messages: readonly ThreadMessage[], running = false): string {
  return transcriptBlocks(messages, running).join('')
}

function screenRows(text: string, cols: number): number {
  const rows = text.split(NEWLINE).slice(0, -1)
  return rows.reduce((total, row) => {
    const width = [...row.replace(OWN_COLOURS, '')].reduce((sum, char) => sum + (char === '\t' ? TAB_WIDTH : 1), 0)
    return total + Math.max(1, Math.ceil(width / Math.max(1, cols)))
  }, 0)
}

const firstChange = (before: readonly string[], after: readonly string[]): number => {
  const index = before.findIndex((entry, at) => entry !== after[at])
  return index === -1 ? before.length : index
}

function statusBar(): { bar: HTMLElement; logo: HTMLImageElement; name: HTMLElement; status: HTMLElement; label: HTMLElement } {
  const bar = document.createElement('div')
  bar.className = 'term-bar flow-term-bar'
  const logoWrap = document.createElement('span')
  logoWrap.className = 'term-bar-logo'
  const logo = document.createElement('img')
  logo.alt = ''
  logoWrap.append(logo)
  const name = document.createElement('span')
  name.className = 'term-bar-name'
  const status = document.createElement('span')
  status.className = 'term-bar-status flow-term-status'
  status.setAttribute('role', 'status')
  const label = document.createElement('span')
  status.append(document.createElement('i'), label)
  bar.append(logoWrap, name, status)
  return { bar, logo, name, status, label }
}

export function createJobTerminal(host: HTMLElement, makeScreen: (element: HTMLElement) => JobScreen): JobTerminal {
  const { bar, logo, name, status, label } = statusBar()
  const surface = document.createElement('div')
  surface.className = 'term-screen flow-term-screen'
  host.replaceChildren(bar, surface)
  const screen = makeScreen(surface)
  let current: JobWatch | null = null
  let shown: string[] = []
  let generation = 0
  let stream: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading: Promise<void> | null = null
  let again = false

  const setStatus = (text: string, kind: 'live' | 'muted' | 'down'): void => { label.textContent = text; status.dataset.kind = kind }
  const closeStream = (): void => { stream?.close(); stream = null; clearTimeout(timer); timer = undefined }

  function draw(blocks: string[]): void {
    const from = firstChange(shown, blocks)
    const tail = blocks.slice(from).join('')
    if (from === shown.length) screen.write(tail)
    else {
      const { cols, rows } = screen.size()
      const up = screenRows(shown.slice(from).join(''), cols)
      if (up < rows) screen.write(`${ESC}[${up}A\r${ESC}[J${tail}`)
      else screen.replace(blocks.join(''))
    }
    shown = blocks
  }

  async function load(request: number, jobId: string): Promise<void> {
    const result = await getJson(`/api/jobs/${encodeURIComponent(jobId)}/thread`)
    if (request !== generation) return
    if (!result.ok) { draw([red(`Could not load this step’s output: ${inertText(errorText(result))}`) + NEWLINE]); setStatus('Unavailable', 'down'); closeStream(); return }
    const running = result.data.running === true
    draw(transcriptBlocks(Array.isArray(result.data.messages) ? result.data.messages as ThreadMessage[] : [], running))
    setStatus(running ? 'Live' : 'Finished', running ? 'live' : 'muted')
    const offset = typeof result.data.logSize === 'number' ? result.data.logSize : null
    if (running && stream === null) follow(request, jobId, offset)
    if (!running) closeStream()
  }

  function refresh(request: number, jobId: string): void {
    if (loading !== null) { again = true; return }
    loading = load(request, jobId).finally(() => {
      loading = null
      if (!again || request !== generation) return
      again = false
      refresh(request, jobId)
    })
  }

  function follow(request: number, jobId: string, offset: number | null): void {
    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream${offset === null ? '' : `?offset=${offset}`}`)
    stream = source
    const delay = shown.length > LONG_TRANSCRIPT_BLOCKS ? LONG_REFRESH_MS : REFRESH_MS
    source.onmessage = () => { if (timer === undefined) timer = setTimeout(() => { timer = undefined; refresh(request, jobId) }, delay) }
    source.onerror = () => { if (stream !== source) return; closeStream(); refresh(request, jobId) }
  }

  return {
    show(watch: JobWatch): void {
      if (current !== null && current.jobId === watch.jobId && current.title === watch.title) return
      current = watch
      generation += 1
      closeStream()
      again = false
      name.textContent = watch.title
      logo.src = `/providers/${watch.engine}.svg`
      ;(logo.parentElement as HTMLElement).dataset.engine = watch.engine
      shown = []
      screen.reset()
      if (watch.jobId === null) { draw([dim('This step has not started yet.') + NEWLINE]); setStatus('Waiting', 'muted'); return }
      setStatus('Loading…', 'muted')
      loading = null
      refresh(generation, watch.jobId)
    },
    stop(): void {
      generation += 1
      current = null
      again = false
      loading = null
      closeStream()
    },
    dispose(): void {
      generation += 1
      closeStream()
      screen.dispose()
    },
  }
}

export function xtermScreen(element: HTMLElement): JobScreen {
  const terminal = new Terminal({ ...JOB_TERMINAL_OPTIONS, theme: terminalTheme() })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(new WebLinksAddon())
  terminal.open(element)
  attachTouchScroll(terminal, element)
  const hideCursor = (): void => terminal.write(`${ESC}[?25l`)
  hideCursor()
  const atBottom = (): boolean => terminal.buffer.active.viewportY >= terminal.buffer.active.baseY
  const keepReading = (pinned: boolean, line: number) => (): void => { if (pinned) terminal.scrollToBottom(); else terminal.scrollToLine(line) }
  let frame = 0
  const fitNow = (): void => {
    if (element.clientWidth === 0) return
    const pinned = atBottom()
    fit.fit()
    if (pinned) terminal.scrollToBottom()
  }
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitNow) })
  observer.observe(element)
  const onTheme = (): void => { terminal.options.theme = terminalTheme() }
  document.addEventListener('mc:theme', onTheme)
  return {
    write: text => terminal.write(text, keepReading(atBottom(), terminal.buffer.active.viewportY)),
    replace: (text) => {
      const restore = keepReading(atBottom(), terminal.buffer.active.viewportY)
      terminal.reset()
      hideCursor()
      terminal.write(text, restore)
    },
    reset: () => { terminal.reset(); hideCursor() },
    size: () => ({ cols: terminal.cols, rows: terminal.rows }),
    fit: fitNow,
    dispose: () => { observer.disconnect(); document.removeEventListener('mc:theme', onTheme); terminal.dispose() },
  }
}

const flowTerm = typeof document === 'undefined' ? null : document.getElementById('flow-term')
if (flowTerm !== null) {
  const view = createJobTerminal(flowTerm, xtermScreen)
  addEventListener('quiet:job-watch', (event) => {
    const watch = (event as CustomEvent<JobWatch | null>).detail
    if (watch === null) view.stop()
    else view.show(watch)
  })
}
